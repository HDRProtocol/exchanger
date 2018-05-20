const eventBus = require('byteballcore/event_bus');
const localConf = require('../conf.json');
const texts = require('../texts');
const conf = require('byteballcore/conf');
const db = require('byteballcore/db');
const notifications = require('./notifications');
const mutex = require('byteballcore/mutex.js');
const tx = require('./tx');
var async = require("async");
const Web3 = require('web3');
const BigNumber = require('bignumber.js');

const PLATFORM_ID = 1;

var CURRENT_TIMESTAMP = {
    toSqlString: function () {
        return 'CURRENT_TIMESTAMP()';
    }
};

let pool = require('./mysql_connect.js');
var connection = pool();

const headlessWallet = require('../start_headless');

eventBus.on('paired', from_address => {
    let device = require('byteballcore/device.js');
    device.sendMessageToDevice(from_address, 'text', texts.exchangerGreeting());
    sendInfoToDevice(from_address, PLATFORM_ID);
});

function sendInfoToDevice(fromAddress, platformId) {
    let device = require('byteballcore/device.js');
    checkUserAddress(fromAddress, platformId, (bEthereumAddressKnown, knownEthereumAddress) => {
        if (!bEthereumAddressKnown) {
            return device.sendMessageToDevice(fromAddress, 'text', texts.insertMyEthereumAddress());
        } else {
            let response = '';
            readOrAssignReceivingAddress(fromAddress, receiving_address => {

                var i = 0;
                var tmpTexts = '';
                var tmpMinimumTexts = '';
                var canTransfer = false;
                async.whilst(
                    function () {
                        return i < conf.tokensUnits.length;
                    },

                    function (callback) {
                        var tmpUnit = conf.tokensUnits[i];
                        getDeviceTokenBalance(fromAddress, tmpUnit, tmpAmount => {
                            i++;
                            tmpTexts += tmpAmount / 10 ** conf.tokensParams[tmpUnit].tokenDisplayDecimals + ' ' + conf.tokensParams[tmpUnit].tokenName + '\n';
                            tmpMinimumTexts += 'Minimum - ' + conf.tokensParams[tmpUnit].MIN_EXCHANGE_AMOUNT / 10 ** conf.tokensParams[tmpUnit].tokenDisplayDecimals + ' ' + conf.tokensParams[tmpUnit].tokenName + '.\n';
                            if (tmpAmount >= conf.tokensParams[tmpUnit].MIN_EXCHANGE_AMOUNT) {
                                canTransfer = true;
                            }
                            callback();
                        });
                    },

                    function () {
                        device.sendMessageToDevice(fromAddress, 'text', 'Your current balance on Exchange Bot:\n' + tmpTexts);
                        if (canTransfer) {
                            device.sendMessageToDevice(fromAddress, 'text', 'Type: [transfer](command:transfer) to convert tokens.');
                        } else {
                            device.sendMessageToDevice(fromAddress, 'text', 'You have not enough tokens for exchange.\nMinimum - ' + tmpMinimumTexts);
                        }

                        response += "Your current Ethereum address is " + knownEthereumAddress + "\n\n";
                        response += "Send " + conf.tokensNames.join(' or ') +
                            ' to ' + receiving_address + ' to convert it for ERC20 tokens. \n';

                        response += 'Type "my balance" to see your balance.\n';
                        device.sendMessageToDevice(fromAddress, 'text', response);
                    }
                );

            });
        }
    });
}


function getDeviceTokenBalance(deviceAddress, unit, callb) {
    "use strict";
    connection.query('SELECT receiving_address FROM receiving_address WHERE device_address=? AND currency="GBYTE"', [deviceAddress], (err, row) => {
        if (!err && row.length > 0) {
            db.query('SELECT SUM(amount) as sum FROM outputs JOIN units USING(unit) WHERE asset=? AND address=? AND is_spent=0 AND is_serial=1  AND is_stable=1', [unit, row[0].receiving_address], (row) => {
                if (row) {
                    callb(row[0].sum);
                } else {
                    callb(0);
                }
            });
        } else {
            callb(0);
        }
    });
}


eventBus.once('exchange_ready', () => {
    console.log('on exchange_ready');

    eventBus.on('text', (from_address, text) => {
        connection.query('SELECT 1');
        let device = require('byteballcore/device');
        text = text.trim();
        let ucText = text.toUpperCase();
        let lcText = text.toLowerCase();

        if (Web3.utils.isAddress(lcText)) {
            connection.query('INSERT INTO user_address (device_address, platform_id, address, created_at) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE address=?, updated_at=?', [from_address, PLATFORM_ID, text, CURRENT_TIMESTAMP, text, CURRENT_TIMESTAMP], (error) => {

                if (!error) {
                    device.sendMessageToDevice(from_address, 'text', 'Saved your Ethereum address.');
                } else {
                    console.error(error);
                }
                sendInfoToDevice(from_address, PLATFORM_ID);
            });
            return;
        }

        checkUserAddress(from_address, PLATFORM_ID, (bEthereumAddressKnown, knownEthereumAddress) => {
            if (!bEthereumAddressKnown && !Web3.utils.isAddress(lcText)) {
                return sendInfoToDevice(from_address, PLATFORM_ID);
            }

            if (bEthereumAddressKnown) {
                if (text == 'transfer') {

                    var lockUnits = [];
                    var i = 0;
                    async.whilst(
                        function () {
                            return i < conf.tokensUnits.length;
                        },

                        function (callback) {
                            var tmpUnit = conf.tokensUnits[i];
                            getDeviceTokenBalance(from_address, tmpUnit, amount => {
                                i++;
                                if (amount >= conf.tokensParams[tmpUnit].MIN_EXCHANGE_AMOUNT) {
                                    lockUnits.push({"unit": tmpUnit, "amount": amount});
                                }
                                callback();
                            });
                        },

                        function () {
                            if (lockUnits.length > 0) {
                                for (var k = 0; k < lockUnits.length; k++) {
                                    lockTokens(from_address, lockUnits[k].amount, lockUnits[k].unit);
                                }
                            } else {
                                return device.sendMessageToDevice(from_address, 'text', 'You don\'t have enough tokens to exchange.\n');
                            }
                        }
                    );
                } else {
                    sendInfoToDevice(from_address, PLATFORM_ID);
                }
            } else {
                sendInfoToDevice(from_address, PLATFORM_ID);
            }
        });
    });
});

function checkUserAddress(device_address, platform_id, cb) {
    connection.query('SELECT user_address_id, address FROM user_address WHERE device_address = ? AND platform_id = ?', [device_address, platform_id], function (err, rows) {
        if (!err && rows.length > 0) {
            cb(true, rows[0].address, rows[0].user_address_id)
        } else {
            console.error('db.err', err);
            cb(false)
        }
    });
}

readOrAssignReceivingAddress = (device_address, cb) => {
    connection.query("SELECT receiving_address FROM receiving_address WHERE device_address=? AND currency='GBYTE'", [device_address], (err, rows) => {
        if (typeof rows.length != 'undefined' && rows.length > 0) {
            cb(rows[0].receiving_address);
            return unlock();
        }
        headlessWallet.issueNextMainAddress(receiving_address => {
            connection.query(
                "INSERT INTO receiving_address (receiving_address, currency, device_address) VALUES(?,?,?)",
                [receiving_address, 'GBYTE', device_address],
                (err) => {
                    console.error('err', err);
                    cb(receiving_address);
                }
            );
        });
    });
};

function lockTokens(from_address, tokens, unit) {
    var device = require('byteballcore/device.js');

    checkUserAddress(from_address, PLATFORM_ID, (bEthereumAddressKnown, knownEthereumAddress, userAddressId) => {
        if (bEthereumAddressKnown) {
            readOrAssignReceivingAddress(from_address, receivingAddress => {
                headlessWallet.readSingleAddress(to_address => {
                    const divisibleAsset = require('byteballcore/divisible_asset.js');
                    const network = require('byteballcore/network');

                    let arrOutputs = [];
                    var commission, tmp_commission_address, exchange_rate;

                    tmp_commission_address = conf.altTokensParams[unit].commission_address;
                    commission = conf.altTokensParams[unit].EXCHANGE_COMMISSION;
                    exchange_rate = conf.altTokensParams[unit].EXCHANGE_RATE_BB_TO_ERC20;

                    if (commission >= tokens) {
                        return false;
                    }

                    tokens = tokens - commission;
                    arrOutputs.push({amount: tokens, address: to_address});
                    if (commission > 0) {
                        arrOutputs.push({amount: commission, address: tmp_commission_address });
                    }

                    divisibleAsset.composeAndSaveDivisibleAssetPaymentJoint({
                        asset: unit,
                        paying_addresses: [receivingAddress],
                        fee_paying_addresses: [to_address],
                        change_address: to_address,
                        asset_outputs: arrOutputs,
                        signer: headlessWallet.signer,
                        callbacks: {
                            ifError: onError,
                            ifNotEnoughFunds: onError,
                            ifOk: (objJoint) => {
                                network.broadcastJoint(objJoint);
                                tx.save({
                                    userAddressId: userAddressId,
                                    objJoint: objJoint,
                                    objJoint: from_address,
                                    unit: unit,
                                    tokens: tokens,
                                    to_address: to_address,
                                    knownEthereumAddress: knownEthereumAddress,
                                    receivingAddress: receivingAddress
                                }, (err) => {
                                    sendInfoToDevice(from_address, PLATFORM_ID);
                                });
                            }
                        }
                    });
                });
            } );
        }
    });
}

function onError(err) {
    console.error('Error: ', err);
    notifications.notifyAdmin('Error: ', err);
}
