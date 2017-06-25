'use strict';

const
  steem = require("steem"),
  path = require("path"),
  mongodb = require("mongodb"),
  moment = require('moment'),
  S = require('string');

const
  DB_RECORDS = "records";

const
  RECORDS_FETCH_LIMIT = 100;

var ObjectID = mongodb.ObjectID;
var db;


// Connect to the database first
mongodb.MongoClient.connect(process.env.MONGODB_URI, function (err, database) {
  if (err) {
    console.log(err);
    process.exit(1);
  }

  db = database;
  console.log("Database connection ready");

  main();
});

function main() {
  console.log("donation-vote-bot waking up");
  steem.api.setWebSocket('wss://steemd.steemit.com');
  getLastInfos(function (lastTransactionTimeAsEpoch, lastTransactionNumber) {
    readTransactions_recursive(lastTransactionTimeAsEpoch,
        lastTransactionTimeAsEpoch, 0, [],
        function (err, transactions) {
          console.log("***FINISHED***");
          if (err || transactions === undefined
            || transactions === null) {
            console.log("Error getting transactions");
            console.log(err, transactions);
          } else {
            console.log("Got "+transactions.length+" transactions");
            console.log(JSON.stringify(transactions));
          }
        });
  });
}

function readTransactions_recursive(lastTransactionTimeAsEpoch,
                                    lastTransactionNumber,
                                    idx,
                                    transactions,
                                    callback) {
  steem.api.getAccountHistory(process.env.STEEM_USER, idx + RECORDS_FETCH_LIMIT,
        RECORDS_FETCH_LIMIT, function(err, result) {
    if (err || result === undefined || result === null
        || result.length < 1) {
      console.log("fatal error, cannot get account history" +
        " (transactions)");
      callback("fatal error, cannot get account history" +
        " (transactions)", transactions);
    } else {
      console.log(JSON.stringify(result));
      for (var j = 0 ; j < result.length ; j++) {
        var r = result[j];
        if (r !== undefined && r !== null && r.length > 1) {
          var transaction = r[1];
          processTransactionOp_recursive(transaction.op, 0, [], function (_transactions) {
            if (_transactions !== undefined
                && _transactions !== null
                && _transactions.length > 0) {
              for (var trx in _transactions) {
                transactions.push(trx);
              }
            }
            // do recursion
            idx += RECORDS_FETCH_LIMIT;
            readTransactions_recursive(lastTransactionTimeAsEpoch,
                lastTransactionNumber, idx, transactions, callback);
          });
        }
      }
    }
  });
}

function processTransactionOp_recursive(ops, idx, transactions, callback) {
  if (ops === undefined || ops === null || ops.length < 2) {
    console.log("processTransactionOp_recursive failed, back ops: "+JSON.stringify(ops));
    callback(transactions);
  }
  var opName = ops[idx];
  //console.log(" - op: "+opName);
  if (opName.localeCompare("transfer") == 0) {
    var opDetail = ops[idx+1];
    verifyTransferIsValid(opDetail, function (err) {
      if (err) {
        console.log("verifyTransferIsValid failed: "+err);
      } else {
        console.log("verifyTransferIsValid pass! Adding to list");
        transactions.push(opDetail);
      }
      idx += 2;
      if (idx >= ops.length) {
        callback(transactions);
      } else {
        processTransactionOp_recursive(ops, idx, transactions, callback);
      }
    });
  } else {
    idx += 2;
    if (idx >= ops.length) {
      callback(transactions);
    } else {
      processTransactionOp_recursive(ops, idx, transactions, callback);
    }
  }
}


function verifyTransferIsValid(opDetail, callback) {
  console.log(" - - - - detail: "+JSON.stringify(opDetail));
  // CHECK 1: only consider STEEM transactions, not SBD
  if (opDetail.asset.localeCompare("STEEM") == 0) {
    console.log(" - - - - MATCH, is for STEEM");
    if (opDetail.amount >= 1.0) {
      console.log(" - - - - MATCH, amount >= 1.0");
      var parts = opDetail.memo.split("/");
      if (parts.length > 0) {
        var permlink = parts[parts.length - 1];
        for (var i = 0 ; i < parts.length ; i++) {
          if (S(parts[i]).startsWith("@")) {
            var author = parts[i].substr(1, parts[i].length);
            // check exists by fetching from Steem API
            steem.api.getContent(author, permlink, function(err, result) {
              if (err) {
                callback("Transfer memo does not contain valid post URL" +
                  " (failed at fetch author/permlink content from API): "
                  + opDetail.memo);
              } else {
                console.log("DEBUG get post content: "+JSON.stringify(result));
                callback(null);
              }
            });
          } else {
            callback("Transfer memo does not contain valid post URL (failed" +
              " to find user name at @ symbol): "+opDetail.memo);
          }
        }
      } else {
        callback("Transfer memo does not contain valid post URL (failed" +
          " at URL split by /): "+opDetail.memo);
      }
    } else {
      callback("Transfer amount < 1.0 STEEM");
    }
  } else {
    callback("Transfer is not for STEEM");
  }
}

function getLastInfos(callback) {
  db.collection(DB_RECORDS).find({}).toArray(function(err, data) {
    if (err) {
      console.log(err);
      console.log("Error, exiting");
      callback(0);
      return;
    }
    var lastTransactionNumber = -1;
    var lastTransactionTimeAsEpoch = 0;
    if (process.env.START_TIME_AS_EPOCH !== undefined
      && process.env.START_TIME_AS_EPOCH !== null) {
      try {
        lastTransactionTimeAsEpoch = Number(process.env.START_TIME_AS_EPOCH);
      } catch(err) {
        console.log("Error converting env var START_TIME_AS_EPOCH to" +
          " number");
        lastTransactionTimeAsEpoch = 0;
      }
    }
    if (data === undefined || data === null) {
      console.log("Db data does not exist, consider this a first time run");
      try {
        if (lastTransactionTimeAsEpoch < data[0].timeAsEpoch) {
          lastTransactionTimeAsEpoch = data[0].timeAsEpoch;
        }
        lastTransactionNumber = data[0].trxNumber;
      } catch(err) {
        console.log(err);
        console.log("not fatal, continuing");
      }
    }
    callback(lastTransactionTimeAsEpoch, lastTransactionNumber);
  });
}