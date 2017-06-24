'use strict';

const
  steem = require("steem"),
  path = require("path"),
  mongodb = require("mongodb"),
  moment = require('moment');

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
  getLastTimeAsEpoch(function (lastTransactionTimeAsEpoch) {
    steem.api.getAccountHistory(process.env.STEEM_USER, 10, 10, function(err, result) {
      console.log("*** ACCOUNT HISTORY");
      console.log(err, result);
      if (result !== undefined && result !== null && result.length > 0) {
        for (var r in result) {
          steem.api.getTransactionHex(r.trx_id, function(err, result) {
            //console.log(err, result);
            if (err) {
              console.log("error getting transaction "+r.trx_id);
            } else {
              console.log("transaction hex: "+r.trx_id);
              console.log(result);
            }
          });
          /*
          steem.api.getTransaction(r.trx_id, function(err, result) {
            if (err) {
              console.log("error getting transaction "+r.trx_id);
            } else {
              console.log("transaction: "+r.trx_id);
              console.log(result);
            }
          });
          */
        }
      }
    });
  });
}

function getLastTimeAsEpoch(callback) {
  db.collection(DB_RECORDS).find({}).toArray(function(err, data) {
    if (err) {
      console.log(err);
      console.log("Error, exiting");
      callback(0);
      return;
    }
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
      } catch(err) {
        console.log(err);
        console.log("not fatal, continuing");
      }
    }
    callback(lastTransactionTimeAsEpoch);
  });
}