'use strict';

const
  steem = require("steem"),
  path = require("path"),
  mongodb = require("mongodb"),
  moment = require('moment'),
  S = require('string');

const
  DB_RECORDS = "records";

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
    steem.api.getAccountHistory(process.env.STEEM_USER, 10, 10, function(err, result) {
      if (err) {
        console.log("fatal error, cannot get account history" +
          " (transactions)");
      } else {
        console.log(JSON.stringify(result));
        for (var j = 0 ; j < result.length ; j++) {
          var r = result[j];
          console.log(" - entry");
          if (r !== undefined && r !== null && r.length > 1) {
            var transaction = r[1];
            //console.log(" - - transaction: "+JSON.stringify(transaction));
            console.log(" - - transaction");
            for (var i = 0 ; i < transaction.op.length ; i += 2) {
              var opName = transaction.op[i];
              console.log(" - - - "+opName);
              if (opName.localeCompare("transaction") == 0) {
                var opDetail = transaction.op[i+1];
                verifyTransferIsValid(opDetail, function (err) {
                  if (err) {
                    console.log("verifyTransferIsValid failed: "+err);
                  } else {
                    console.log("verifyTransferIsValid pass!");
                  }
                });
              }
            }
          }
        }
      }
    });
  });
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
                  " (failed at fetch author/permlink content from API)");
              } else {
                console.log("DEBUG get post content: "+JSON.stringify(result));
                callback(null);
              }
            });
          }
        }
      } else {
        callback("Transfer memo does not contain valid post URL (failed" +
          " at URL split by /)");
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