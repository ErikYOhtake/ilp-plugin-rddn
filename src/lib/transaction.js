'use strict'

const debug = require('debug')('ilp-plugin-rddn:ethereum')
const Tx = require('ethereumjs-tx');

// TODO: better number conversion
const accountToHex = (account, ledgerPrefix) => {
  if (!account.startsWith(ledgerPrefix)) {
    throw new Error('account does not start with ledger prefix')
  }
  const match = account.substring(ledgerPrefix.length).match(/^(0x[0-9A-Fa-f]{40})(\.|$)/g)
  if (match === null) {
    throw new Error('account is not a 40-digit hex number')
  }
  return match[0]
}

const uuidToHex = (uuid) => '0x' + uuid.replace(/-/g, '')
const conditionToHex = (condition) => '0x' + Buffer.from(condition, 'base64').toString('hex')
const fulfillmentToHex = conditionToHex
const isoToHex = (web3, iso) => web3.utils.toHex(Math.round((new Date(iso)).getTime() / 1000))
const ilpToData = (ilp) => '0x' + Buffer.from(ilp, 'base64').toString('hex')
const gasLimit = 4700000
const gasPrice = 0

/**
 * rejectIncomingTransfer
 * @param {object} contract object of web3 contract
 * @param {string} uuid transfer uuid
 * @param {string} address address to send transaction to ledger
 * @param {string} privateKey private key of the address above
 * @param {object} web3 instance of web3
 * @param {string} privateFor send private transaction to target node
 * @returns {promise} A promise which resolves when the fulfillment has been submitted
 */
async function rejectIncomingTransfer(contract, uuid, address, privateKey, web3, privateFor) {
  const params = contract.methods.abortTransfer(
    uuidToHex(uuid)
  ).encodeABI();

  const nonce = await web3.eth.getTransactionCount(address, 'pending');
  const rawTx = {
    from: address,
    to: contract.options.address,
    gasPrice: gasPrice,
    gas: gasLimit,
    data: params,
    nonce: nonce,
  };

  let tx = new Tx(rawTx);
  tx.sign(new Buffer(privateKey.split('0x')[1], 'hex'));
  let serializedTx = tx.serialize();

  try {
    await web3.eth.sendSignedTransaction('0x' + serializedTx.toString('hex'));
  } catch (e) {
    throw e;
  }
}

/**
 * fulfillCondition
 * @param {object} contract object of web3 contract
 * @param {string} uuid transfer uuid
 * @param {string} fulfillment fulfill string will be applied to ledger
 * @param {string} address address to send transaction to ledger
 * @param {string} privateKey private key of the address above
 * @param {object} web3 instance of web3
 * @param {string} privateFor send private transaction to target node
 * @returns {promise} A promise which resolves when the fulfillment has been submitted
 */
async function fulfillCondition(contract, uuid, fulfillment, address, privateKey, web3, privateFor) {
  const params = contract.methods.fulfillTransfer(
    uuidToHex(uuid),
    fulfillmentToHex(fulfillment),
  ).encodeABI();

  const nonce = await web3.eth.getTransactionCount(address, 'pending');
  const rawTx = {
    from: address,
    to: contract.options.address,
    gasPrice: gasPrice,
    gas: gasLimit,
    data: params,
    nonce: nonce,
  };

  let tx = new Tx(rawTx);
  tx.sign(new Buffer(privateKey.split('0x')[1], 'hex'));
  let serializedTx = tx.serialize();

  try {
    await web3.eth.sendSignedTransaction('0x' + serializedTx.toString('hex'));
  } catch (e) {
    throw e;
  }
}

/**
 * sendTransfer
 * @param {object} contract object of web3 contract
 * @param {object} transfer object of transfer to be send
 * @param {string} address address to send transaction to ledger
 * @param {string} privateKey private key of the address above
 * @param {string} prefix prefix of ledger
 * @param {object} web3 instance of web3
 * @param {string} privateFor send private transaction to target node
 * @returns {promise} A promise which resolves when the transfer has been submitted
 */
async function sendTransfer(contract, transfer, address, privateKey, prefix, web3, privateFor) {
  const params = contract.methods.createTransfer(
    transfer.custom.moneyId,
    transfer.amount,
    conditionToHex(transfer.executionCondition),
    uuidToHex(transfer.id),
    isoToHex(web3, transfer.expiresAt),
    ilpToData(transfer.ilp),
    transfer.custom.direction
  ).encodeABI();

  const nonce = await web3.eth.getTransactionCount(address, 'pending');
  const rawTx = {
    from: address,
    to: contract.options.address,
    gasPrice: gasPrice,
    gas: gasLimit,
    data: params,
    nonce: nonce,
  };

  let tx = new Tx(rawTx);
  tx.sign(new Buffer(privateKey.split('0x')[1], 'hex'));
  let serializedTx = tx.serialize();

  try {
    await web3.eth.sendSignedTransaction('0x' + serializedTx.toString('hex'));
  } catch (e) {
    throw e;
  }
}

module.exports = {
  rejectIncomingTransfer,
  sendTransfer,
  fulfillCondition,
  uuidToHex
}
