'use strict';

const
  fs = require('fs'),
  steem = require("steem"),
  path = require("path"),
  mongodb = require("mongodb"),
  moment = require('moment'),
  S = require('string'),
  wait = require('wait.for'),
  sprintf = require("sprintf-js").sprintf,
  request = require('request');

const
  DB_RECORDS = "records",
  DB_QUEUE = "queue";

const
  RECORDS_FETCH_LIMIT = 100,
  VOTE_POWER_1_PC = 100,
  MIN_VOTING_POWER = 80,
  MIN_DONATION = 0.1,
  MAX_DONATION = 0.5;

var db;

var mAccount = null;
var mProperties = null;
var mLastInfos = null;
var mMessage = null;
var latestBlockMoment = null;


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
  steem.config.set('websocket','wss://steemd.steemit.com');
  init(function () {
    loadFileToString("/message.txt", function (str) {
      mMessage = str;
      setupLastInfos(function () {
        console.log("Got last infos from DB (or newly created: "+JSON.stringify(mLastInfos));
        readTransfers(function (transfers) {
          console.log("*** GOT TRANSFERS ***");
          if (transfers === undefined
            || transfers === null) {
            console.log("Error getting transfers");
            console.log(err, transfers);
          } else {
            console.log("Got "+transfers.length+" transfers");
            console.log(JSON.stringify(transfers));
            // process transactions
            voteOnPosts(transfers, function (err) {
              if (err) {
                console.log("vote on posts had error: "+err);
              } else {
                console.log("*** FINISHED ***")
              }
            });
          }
        });
      });
    });
  });
}

function init(callback) {
  wait.launchFiber(function() {
    // get steem global properties first, needed for SP calc
    mProperties = wait.for(steem_getSteemGlobaleProperties_wrapper);
    console.log("global properties: "+JSON.stringify(mProperties));
    // get Steem Power of bot account
    var accounts = wait.for(steem_getAccounts_wrapper);
    mAccount = accounts[0];
    console.log("account: "+JSON.stringify(mAccount));
    init_conversion(function () {
      callback();
    });
  });
}

var conversionInfo = {};

function init_conversion(callback) {
  wait.launchFiber(function () {
    // get some info first
    var headBlock = wait.for(steem_getBlockHeader_wrapper, mProperties.head_block_number);
    latestBlockMoment = moment(headBlock.timestamp, moment.ISO_8601);
    conversionInfo.rewardfund_info = wait.for(steem_getRewardFund_wrapper, "post");
    conversionInfo.price_info = wait.for(steem_getCurrentMedianHistoryPrice_wrapper);

    conversionInfo.reward_balance = conversionInfo.rewardfund_info.reward_balance;
    conversionInfo.recent_claims = conversionInfo.rewardfund_info.recent_claims;
    conversionInfo.reward_pool = conversionInfo.reward_balance.replace(" STEEM", "")
      / conversionInfo.recent_claims;

    conversionInfo.sbd_per_steem = conversionInfo.price_info.base.replace(" SBD", "")
      / conversionInfo.price_info.quote.replace(" STEEM", "");

    conversionInfo.steem_per_vest = mProperties.total_vesting_fund_steem.replace(" STEEM", "")
      / mProperties.total_vesting_shares.replace(" VESTS", "");
    request('https://api.coinmarketcap.com/v1/ticker/steem/', function (err, response, body) {
      if (err) {
        console.log("error getting price of steem from coinmarketcap");
        conversionInfo.steem_to_dollar = 1;
      } else {
        var data = JSON.parse("{\"data\":"+body+"}");
        conversionInfo.steem_to_dollar = data["data"][0]["price_usd"];
        console.log("got price of steem: "+conversionInfo.steem_to_dollar);
      }
      callback();
    });
  });
}


function do_conversion(latestBlockMoment, target_value, callback) {
  wait.launchFiber(function () {
    console.log("--DEBUG CALC VOTE PERCENTAGE--");
    var vp = recalcVotingPower(latestBlockMoment);
    console.log(" - vp: " + vp);
    console.log(" - abs_percentage calc");
    console.log(" - - mAccount.vesting_shares: " + mAccount.vesting_shares);
    console.log(" - - mAccount.received_vesting_shares" +
      " (delegated from others): " + mAccount.received_vesting_shares);
    var vestingSharesParts = mAccount.vesting_shares.split(" ");
    var vestingSharesNum = Number(vestingSharesParts[0]);
    console.log(" - - - vesting_shares num: " + vestingSharesNum);
    var receivedSharesParts = mAccount.received_vesting_shares.split(" ");
    var receivedSharesNum = Number(receivedSharesParts[0]);
    console.log(" - - - received_vesting_shares num: " + receivedSharesNum);
    var totalVests = vestingSharesNum + receivedSharesNum;
    console.log(" - - total vests: " + totalVests);

    var steempower = getSteemPowerFromVest(totalVests);
    console.log("steem power: " + steempower);
    var sp_scaled_vests = steempower / conversionInfo.steem_per_vest;
    console.log("sp_scaled_vests: " + sp_scaled_vests);

    var voteweight = 100;

    var oneval = (target_value * 52) / (sp_scaled_vests * 100
      * conversionInfo.reward_pool * conversionInfo.sbd_per_steem);
    console.log("oneval: " + oneval);

    var votingpower = (oneval / (100 * (100 * voteweight) / VOTE_POWER_1_PC)) * 100;
    console.log("voting power: " + votingpower);

    if (votingpower > 100) {
      votingpower = 100;
      console.log("capped voting power to 100%");
    }

    console.log("voting percentage: " + votingpower);
    callback(null, votingpower);
  });
}

function recalcVotingPower(latestBlockMoment) {
  // update account
  var accounts = wait.for(steem_getAccounts_wrapper);
  var account = accounts[0];
  if (account === null || account === undefined) {
    console.log("Could not get bot account detail");
    return 0;
  }
  mAccount = accounts[0];
  var vp = account.voting_power;
  var lastVoteTime = moment(account.last_vote_time);
  var secondsDiff = latestBlockMoment.seconds() - lastVoteTime.seconds();
  if (secondsDiff > 0) {
    var vpRegenerated = secondsDiff * 10000 / 86400 / 5;
    vp += vpRegenerated;
  }
  if (vp > 10000) {
    vp = 10000;
  }
  console.log(" - - new vp(corrected): "+vp);
  return vp;
}

function voteOnPosts(transfers, callback) {
  wait.launchFiber(function () {
    console.log("steem power in VESTS: "+mAccount.vesting_shares);
    console.log("delegated steem power in VESTS: "+mAccount.received_vesting_shares);
    var delegatedSteemPower = getSteemPowerFromVest(mAccount.received_vesting_shares);
    var steemPower = getSteemPowerFromVest(mAccount.vesting_shares) + delegatedSteemPower;
    console.log("combined SP as SP: "+steemPower);
    // TODO : make sure this takes delegated SP into account also
    // override steem power with override value if exists (greater than 0)
    if (process.env.STEEM_POWER_OVERRIDE !== undefined
      && process.env.STEEM_POWER_OVERRIDE !== null) {
      var steemPowerOverride = Number(process.env.STEEM_POWER_OVERRIDE);
      if (steemPowerOverride > 0) {
        console.log("Overriding actual SP of "+steemPower+" with value "+steemPowerOverride);
        steemPower = steemPowerOverride;
      }
    }
    // override vote power with override value if exists (greater than 0)
    var votePowerOverride = 0;
    if (process.env.VOTE_POWER_OVERRIDE !== undefined
      && process.env.VOTE_POWER_OVERRIDE !== null) {
      votePowerOverride = Number(process.env.VOTE_POWER_OVERRIDE);
      if (votePowerOverride > 0) {
        console.log("Overriding vote power to "+votePowerOverride);
      }
    }
    console.log("Bot SP is "+steemPower);
    console.log("Add transfers from queue if any");
    var queue = wait.for(mongo_getQueue_wrapper);
    mongo_dropQueue_wrapper(); // remove it
    if (queue === undefined || queue === null) {
      console.log("Error getting queue, reseting");
    } else if (queue.length > 0) {
      console.log("Adding "+queue.length+" queued items");
      var newTransfers = [];
      for (var i = 0 ; i < queue.length ; i++) {
        newTransfers.push(queue[i]);
      }
      for (var i = 0 ; i < transfers.length ; i++) {
        newTransfers.push(transfers[i]);
      }
      transfers = newTransfers;
    } else {
      console.log("Nothing in queue");
    }
    queue = [];
    // process transfers, vote on posts
    console.log("processing transfers...");
    for (var i = 0 ; i < transfers.length ; i++) {
      var transfer = transfers[i];
      console.log(" - transfer "+i+": "+JSON.stringify(transfer));
      var percentage = 0.01;
      if (transfer.number_amount !== undefined
          && transfer.number_amount !== null) {
        // calc nearest whole number STEEM amount
        var donation = transfer.number_amount;
        if (donation > MAX_DONATION) {
          donation = MAX_DONATION;
        }
        percentage = wait.for(do_conversion, latestBlockMoment, donation * 1.5);
      } else if (transfer.percentage !== undefined
        && transfer.percentage !== null) {
        percentage = transfer.percentage;
      }
      console.log(" - - - percentage = "+percentage+" pc");
      if (votePowerOverride > 0) {
        console.log(" - - - - OVERRIDE percentage = "+votePowerOverride+" pc");
        percentage = votePowerOverride;
      }
      var didVote = false;
      // do vote (note that this does not need to be wrapped)
      // actually do voting
      console.log("Voting...");
      // update account first
      var accounts = wait.for(steem_getAccounts_wrapper);
      mAccount = accounts[0];
      var botVotingPower = mAccount.voting_power;
      console.log("bot voting power: "+(botVotingPower/VOTE_POWER_1_PC));
      if (botVotingPower >= (MIN_VOTING_POWER * VOTE_POWER_1_PC)) {
        if (process.env.VOTING_ACTIVE !== undefined
          && process.env.VOTING_ACTIVE !== null
          && process.env.VOTING_ACTIVE.localeCompare("true") == 0) {
          try {
            var voteResult = wait.for(steem.broadcast.vote,
              process.env.POSTING_KEY_PRV,
              process.env.STEEM_USER,
              transfer.author,
              transfer.permlink,
              parseInt(percentage * VOTE_POWER_1_PC)); // adjust pc to Steem
            // scaling
            console.log("Vote result: " + JSON.stringify(voteResult));
            didVote = true;
            console.log("Waiting for vote time...");
            wait.for(timeout_wrapper, 4000);
            console.log("Finished waiting");
          } catch(err) {
            console.log("Error voting: "+JSON.stringify(err));
          }
        } else {
          console.log("NOT voting, disabled");
          didVote = true; // TODO : remove, for debug only
        }
      } else {
        var item = {
          author: transfer.author,
          permlink: transfer.permlink,
          from: transfer.from,
          is_steem: transfer.is_steem,
          percentage: parseInt(percentage * VOTE_POWER_1_PC)
        };
        console.log("VP too small, putting in queue: "+JSON.stringify(item));
        queue.push(item);
      }
      // comment on post
      //console.log("message raw: "+mMessage);
      var treesPlanted = (donation / 2) * conversionInfo.steem_to_dollar;
      var spToTrees = Math.floor(steemPower / 300);
      var commentMsg = sprintf(mMessage,
        treesPlanted,
        percentage,
        donation * 1.5,
        "SBD",
        transfer.from,
        spToTrees,
        steemPower);
      // wrap comment in code fixed space markdown tags, preserve spacing
      commentMsg = "```\n" + commentMsg + "\n```";
      // check for self vote and add message if is
      if (transfer.author.localeCompare(transfer.from) === 0) {
        commentMsg = sprintf("You have just self-voted yourself using" +
            " @treeplanter. Make other people happy and vote for others" +
            " instead! Connect the steemit network, make the value. Be" +
            " nice and share!\nAnyway you have still planted %.2f" +
          " tree(s)...\n\n",
            treesPlanted)
          + commentMsg;
      }
      //console.log("Commenting: "+commentMsg);
      if (didVote
        && process.env.COMMENTING_ACTIVE !== undefined
        && process.env.COMMENTING_ACTIVE !== null
        && process.env.COMMENTING_ACTIVE.localeCompare("true") == 0) {
        var commentResult = wait.for(steem.broadcast.comment,
            process.env.POSTING_KEY_PRV,
            transfer.author,
            transfer.permlink,
            process.env.STEEM_USER,
            steem.formatter.commentPermlink(transfer.author, transfer.permlink).toLowerCase(),
            "Tree planter comment",
            commentMsg,
            {});
        console.log("Comment result: "+JSON.stringify(commentResult));
        console.log("Waiting for comment timeout...");
        wait.for(timeout_wrapper, 20000);
        console.log("Finished waiting");
      } else {
        console.log("NOT commenting, disabled");
      }
    }
    // put queue in memory
    if (queue.length > 0) {
      console.log("saving "+queue.length+" queued items to memory");
      for (var i = 0 ; i < queue.length ; i++) {
        wait.for(mongoSave_queue_wrapper, queue[i]);
      }
    }
    // TODO : transfer half the donation to vesting, i.e. power up
    callback(null);
  });
}

/*
 getSteemPowerFromVest(vest):
 * converts vesting steem (from get user query) to Steem Power (as on Steemit.com website)
 */
function getSteemPowerFromVest(vest) {
  try {
    return steem.formatter.vestToSteem(
      vest,
      parseFloat(mProperties.total_vesting_shares),
      parseFloat(mProperties.total_vesting_fund_steem)
    );
  } catch(err) {
    return 0;
  }
}

function steem_getSteemGlobaleProperties_wrapper(callback) {
  steem.api.getDynamicGlobalProperties(function(err, properties) {
    callback(err, properties);
  });
}

function steem_getAccounts_wrapper(callback) {
  steem.api.getAccounts([process.env.STEEM_USER], function(err, result) {
    callback(err, result);
  });
}

function steem_getAccountCount_wrapper(callback) {
  steem.api.getAccountCount(function(err, result) {
    callback(err, result);
  });
}

function steem_getAccountHistory_wrapper(start, limit, callback) {
  steem.api.getAccountHistory(process.env.STEEM_USER, start, limit, function (err, result) {
    callback(err, result);
  });
}

function steem_getContent_wrapper(author, permlink, callback) {
  steem.api.getContent(author, permlink, function (err, result) {
    callback(err, result);
  });
}

function readTransfers(callback) {
  wait.launchFiber(function() {
    var idx = mLastInfos.lastTransaction;
    if (idx < 0) {
      idx = 0;
    }
    var oldestTransaction = 1;
    var newestTransaction = 0;

    var transfers = [];
    var keepProcessing = true;
    while(keepProcessing) {
      var from = idx + RECORDS_FETCH_LIMIT;
      var limit = RECORDS_FETCH_LIMIT;
      console.log("getAccountHistory: from "+from+", limit "+limit);
      var result = wait.for(steem_getAccountHistory_wrapper, from, limit);
      idx += RECORDS_FETCH_LIMIT;
      if (result === undefined || result === null
          || result.length < 1) {
        console.log("fatal error, cannot get account history" +
          " (transfers), may be finished normally, run out of data");
        callback(transfers);
        keepProcessing = false;
        break;
      } else {
        //console.log("*** transaction fetch result at idx "+idx);
        //console.log(JSON.stringify(result));
        var gotNewTransaction = false;
        for (var j = 0; j < result.length; j++) {
          var r = result[j];
          if (r[0] <= mLastInfos.lastTransaction
              || !(r[0] < oldestTransaction || r[0] > newestTransaction)) {
            // this means the API returned older results than we asked
            // for, meaning there are no more recent transactions to get
            /*
            console.log("trx id "+r[0]+" already" +
              " processed, <= "+mLastInfos.lastTransaction);
              */
            continue;
          }
          gotNewTransaction = true;
          if (newestTransaction < r[0]) {
            newestTransaction = r[0];
          }
          if (oldestTransaction > r[0]) {
            oldestTransaction = r[0];
          }
          console.log("Processing trx id: "+r[0]);
          if (r !== undefined && r !== null && r.length > 1) {
            var transaction = r[1];
            var ops = transaction.op;
            if (ops === undefined || ops === null || ops.length < 2) {
              console.log("processTransactionOp_recursive failed, back ops: " + JSON.stringify(ops));
            } else {
              for (var i = 0; i < ops.length; i += 2) {
                var opName = ops[i];
                //console.log(" - op: "+opName);
                if (opName.localeCompare("transfer") == 0) {
                  var opDetail = ops[i + 1];
                  // verifyTransferIsValid
                  console.log(" - - - - detail: " + JSON.stringify(opDetail));
                    var amountParts = opDetail.amount.split(" ");
                    if (amountParts.length === 2) {
                      var amount = Number(amountParts[0]);
                      var asset = amountParts[1];
                      var isSteem = asset.localeCompare("STEEM") === 0;
                      if (amount >= MIN_DONATION) {
                        console.log(" - - - - MATCH, amount >= "+MIN_DONATION);
                        // do not allow comment, so screen for # hash
                        // symbol and reject if present
                        if (opDetail.memo.indexOf("#") < 0) {
                          var parts = opDetail.memo.split("/");
                          if (parts.length > 0) {
                            var permlink = parts[parts.length - 1];
                            var author = null;
                            for (var i = 0; i < parts.length; i++) {
                              if (S(parts[i]).startsWith("@")) {
                                author = parts[i].substr(1, parts[i].length);
                              }
                            }
                            if (author !== null) {
                              if (author !== null && author !== undefined
                                && author.localeCompare(process.env.STEEM_USER) !== 0) {
                                // check exists by fetching from Steem API
                                var content = wait.for(steem_getContent_wrapper, author, permlink);
                                if (content == undefined || content === null) {
                                  console.log("Transfer memo does not" +
                                    " contain valid post URL" +
                                    " (failed at fetch author/permlink content from API): "
                                    + opDetail.memo);
                                } else {
                                  console.log("DEBUG get post content: " +
                                    JSON.stringify(content));
                                  var match = false;
                                  try {
                                    for (var k = 0; k < content.active_votes.length; k++) {
                                      if (content.active_votes[k].voter.localeCompare(process.env.STEEM_USER) == 0) {
                                        match = true;
                                        break;
                                      }
                                    }
                                  } catch (err) {
                                    console.log("Error analysing memo linked" +
                                      " post for votes");
                                  }
                                  if (match) {
                                    console.log("Already voted on this post," +
                                      " skipping");
                                  } else {
                                    // check time since posted is < (7 days
                                    // - 12 hrs)
                                    var cashoutTime = moment(content.cashout_time);
                                    cashoutTime.subtract(7, 'hours');
                                    var nowTime = moment(new Date());
                                    if (nowTime.isBefore(cashoutTime)) {
                                      // PASSES ALL TESTS
                                      // add author and permlink to detail,
                                      //    and number amount
                                      opDetail.author = author;
                                      opDetail.permlink = permlink;
                                      opDetail.number_amount = amount;
                                      opDetail.is_steem = isSteem;
                                      // add to list
                                      transfers.push(opDetail);
                                      console.log("MEMO LINKED POST PASSES" +
                                        " TESTS, will vote on");
                                    } else {
                                      console.log("Memo linked post is too" +
                                        " old to vote on, skipping");
                                    }
                                  }
                                }
                              } else {
                                console.log("Will not vote on own posts");
                              }
                            } else {
                              console.log("Transfer memo does not contain valid post URL (failed" +
                                " to find user name at @ symbol): " + opDetail.memo);
                            }
                          } else {
                            console.log("Transfer memo does not contain valid post URL (failed" +
                              " at URL split by /): " + opDetail.memo);
                          }
                        } else {
                          console.log("Transfer memo does not contain valid post URL (failed" +
                            " as is probably a comment): " + opDetail.memo);
                        }
                      } else {
                        console.log("Transfer amount < 1.0 STEEM");
                      }
                    } else {
                      console.log("Transfer amount field is invalid");
                    }
                }
              }
            }
            //idx += RECORDS_FETCH_LIMIT;
          } else {
            console.log("fatal error, cannot get account history" +
              " (transfers), may be finished normally, run out of data");
            callback(transfers);
            keepProcessing = false;
            break;
          }
        }
        if (!gotNewTransaction) {
          console.log("API has no more results, ending fetch");
          callback(transfers);
          keepProcessing = false;
          break;
        }
      }
    }
    if (newestTransaction > mLastInfos.lastTransaction) {
      mLastInfos.lastTransaction = newestTransaction;
      // save / update last transaction
      console.log("saving / updating last transaction number");
      wait.for(mongoSave_records_wrapper, mLastInfos);
    } else {
      console.log("do not need to update last transaction number," +
        " nothing new");
    }
  });
}

function mongoSave_records_wrapper(obj, callback) {
  db.collection(DB_RECORDS).save(obj, function (err, data) {
    callback(err, data);
  });
}

function mongoSave_queue_wrapper(obj, callback) {
  db.collection(DB_QUEUE).save(obj, function (err, data) {
    callback(err, data);
  });
}

function mongo_getQueue_wrapper(callback) {
  db.collection(DB_QUEUE).find({}).toArray(function(err, data) {
    callback(err, data);
  });
}

function mongo_dropQueue_wrapper() {
  db.collection(DB_QUEUE).drop();
}

function setupLastInfos(callback) {
  db.collection(DB_RECORDS).find({}).toArray(function(err, data) {
    if (err || data === null || data === undefined || data.length === 0) {
      console.log("No last infos data in db, is first time run, set up" +
        " with defaults");
      if (process.env.START_FROM_TRX_NUM !== undefined
        && process.env.START_FROM_TRX_NUM !== null) {
        mLastInfos = {
          lastTransaction: Number(process.env.START_FROM_TRX_NUM)
        };
      } else {
        mLastInfos = {
          lastTransaction: 0
        };
      }
    } else {
      mLastInfos = data[0];
    }
    callback();
  });
}

function steem_getRewardFund_wrapper(type, callback) {
  steem.api.getRewardFund(type, function (err, data) {
    callback(err, data);
  });
}

function steem_getCurrentMedianHistoryPrice_wrapper(callback) {
  steem.api.getCurrentMedianHistoryPrice(function(err, result) {
    callback(err, result);
  });
}

function steem_getBlockHeader_wrapper(blockNum, callback) {
  steem.api.getBlockHeader(blockNum, function(err, result) {
    callback(err, result);
  });
}

function steem_transferToVesting_wrapper(amount, callback) {
  steem.broadcast.transferToVesting(process.env.ACTIVE_KEY_PRV,
    process.env.STEEM_USER, process.env.STEEM_USER, amount, function(err, result) {
    callback(err, result);
  });
}

function loadFileToString(filename, callback) {
  fs.readFile(path.join(__dirname, filename), {encoding: 'utf-8'}, function(err,data) {
    var str = "";
    if (err) {
      console.log(err);
    } else {
      str = data;
    }
    if (callback) {
      callback(str);
    }
  });
}

function timeout_wrapper(delay, callback) {
  setTimeout(function() {
    callback(null, true);
  }, delay);
}