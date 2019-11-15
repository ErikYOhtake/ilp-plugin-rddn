'use strict'

const base64url = require('base64url')
const Web3 = require('web3')
const EventEmitter2 = require('eventemitter2').EventEmitter2
const debug = require('debug')('ilp-plugin-rddn')
const Errors = require('./errors')
const Transaction = require('./transaction')

const uuidParse = require('uuid-parse');

const stateToName = (state) => {
  return (['prepare', 'fulfill', 'abort'])[state]
}
const directionToName = (direction) => {
  return (['deposit', 'withdraw'])[direction]
}
const hexToAccount = (prefix, account) => prefix + account

// remove this when Geth fixes this: https://github.com/ethereum/go-ethereum/issues/16846
const createWebsocketProvider = (provider) => new Web3.providers.WebsocketProvider(provider
    ,{
      clientConfig: {
        fragmentationThreshold: 81920
      }
    }
  )

class PluginRddn extends EventEmitter2 {
  constructor(opts) {
    super()
    // provider
    this._primaryProvider = opts.provider
    this._secondaryProvider = opts.altProvider || opts.provider
    this.provider = this._primaryProvider

    this.address = opts.address
    this.privateKey = opts.secretKey
    this.contractAddress = opts.contract
    this._prefix = opts.prefix
    this.abi = opts.abi

    // optional
    this.private = opts.private || ''

    this.notesToSelf = {}
    this.web3 = null // local web3 instance
    this.extWeb3 = null // external web3 instance
  }

  /**
   * getAccount
   * @returns {string} ledger plugin's ILP address
   */
  getAccount() {
    return this._prefix + this.address
  }

  /**
   * getInfo
   * @returns {object} metadata about the ledger
   */
  getInfo() {
    return {
      prefix: this._prefix,
      currencyCode: 'JPY',
      currencyScale: 0
    }
  }

  /**
   * setWeb3
   */
  setWeb3(_web3) {
    this.extWeb3 = _web3;
  }

  /**
   * connect
   * @returns {void} connect plugin to quorum server
   */
  async connect() {
    try {
      if (this.extWeb3) {
        debug('use external web3 instance')
        this.contract = new this.extWeb3.eth.Contract(this.abi, this.contractAddress)
      } else {
        if (this.web3) return
        debug('creating web3 instance', this.provider)
        this.web3 = new Web3(createWebsocketProvider(this.provider))
        this.contract = new this.web3.eth.Contract(this.abi, this.contractAddress)
      }

      this.contract.events.Deposit()
        .on('data', (event) => {
          debug('Deposit event:', event.returnValues[0], event.returnValues[1], event.returnValues[2], event.returnValues[3])
        })
        .on('error', console.error);

      this.contract.events.Withdraw()
        .on('data', (event) => {
          debug('Withdraw event:', event.returnValues[0], event.returnValues[1], event.returnValues[2], event.returnValues[3])
        })
        .on('error', console.error);

      debug('registering Fulfill event handler')
      this.contract.events.Fulfill()
        .on('data', async (event) => {
          const uuid = event.returnValues[0]
          const fulfillment = event.returnValues[1]
          const transfer = await this._getRddnTransfer(uuid)
          this._processUpdate(transfer, base64url(Buffer.from(fulfillment.slice(2), 'hex')))
        })
        .on('error', console.error);

      debug('registering Update event handler')
      this.contract.events.Update()
        .on('data', async (event) => {
          const uuid = event.returnValues[0]
          const transfer = await this._getRddnTransfer(uuid)
          this._processUpdate(transfer)
        })
        .on('error', console.error);
    } catch (e) {
      throw e;
    }

    this._heartbeat();

    this.emitAsync('connect')
    return null
  }

  _heartbeat() {
    if (this.extWeb3) return; // If using external web3 instance, do nothing
    if (this.isProcessing) return;
    this.isProcessing = true;
    setInterval(async () => {
      /**
       * Reconnect
       */
      if (!this.web3) {
        if (this.provider === this._primaryProvider) {
          this.provider = this._secondaryProvider;
        } else {
          this.provider = this._primaryProvider;
        }
        debug('Attempting to reconnect... ' + this.provider);
        const provider = createWebsocketProvider(this.provider);
        provider.on('connect', async () => {
          await this.connect();
        })
      }

      /**
       * Handle web socket disconnects
       * @see https://github.com/ethereum/web3.js/issues/1354
       * @see https://github.com/ethereum/web3.js/issues/1933
       * It also serves as a heartbeat to node
       */
      if (this.web3) {
        await this.web3.eth.net.isListening()
          .catch( async (e) => {
            debug(e);
            this.web3.currentProvider.disconnect();
            this.web3 = null;
            if (this.provider === this._primaryProvider) {
              this.provider = this._secondaryProvider;
            } else {
              this.provider = this._primaryProvider;
            }
            const provider = createWebsocketProvider(this.provider);
            provider.on('connect', async () => {
              await this.connect();
            })
          })
      }
    }, 5 * 1000)
  }

  /**
   * _processUpdate
   * @param {object} transfer object transfer
   * @param {string} fulfillment base64-encoded string of fulfillment data
   * @returns {void} Emit the corresponding event to plugin when received transfer object and fulfillment string
   */
  _processUpdate(transfer, fulfillment) {
    let direction

    if (transfer.from === this.getAccount()) direction = 'outgoing'
    if (transfer.to === this.getAccount()) direction = 'incoming'
    if (!direction) {
      if (transfer.state === 'fulfill') {
        this.emit('event_fulfill', transfer, fulfillment)
      } else {
        this.emit('event_' + transfer.state, transfer)
      }
      return
    }

    transfer.ledger = this._prefix
    debug('emitting ' + direction + '_' + transfer.state)
    if (transfer.state === 'fulfill') {
      this.emit(direction + '_' + transfer.state, transfer, fulfillment, transfer.ilp)
      return
    }
    this.emit(direction + '_' + transfer.state, transfer)
  }

  /**
   * disconnect
   * @returns {promise} remove connect between plugin and quorum server
   */
  disconnect() {
    if (!this.web3) return
    this.web3.currentProvider.disconnect()
    this.web3 = null

    this.emit('disconnect')
    return Promise.resolve(null)
  }

  /**
   * isConnected
   * @return {Boolean} True if plugin is connected to server, False if it's not.
   */
  isConnected() {
    return !!this.web3 || !!this.extWeb3
  }

  /**
   * _sleep
   * @param {milisecond} time
   * @returns {promise} resolve after <time>
   */
  _sleep(time) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        resolve();
      }, time);
    });
  }

  /**
   * rejectIncomingTransfer
   * @param {string} transferId uuid
   */
  async rejectIncomingTransfer(transferId) {
    try {
      await this._rejectIncomingTransfer(transferId)
    } catch (error) {
      if (error instanceof Errors.PastSequenceError) {
        debug('PastSequenceError retry rejectIncomingTransfer', transferId)
        this._sleep(500)
        await this.rejectIncomingTransfer(transferId)
      } else {
        throw error
      }
    }
  }

  async _rejectIncomingTransfer(transferId) {
    try {
      await Transaction.rejectIncomingTransfer(this.contract, transferId, this.address, this.privateKey, this.web3 || this.extWeb3, this.private);
    } catch (error) {
      // TODO: MECE
      const message = error.message.toString()
      if (message.indexOf('replacement transaction underpriced') >= 0) {
        throw new Errors.PastSequenceError()
      } else if (message.indexOf('known transaction') >= 0) {
        throw new Errors.PastSequenceError()
      } else {
        throw error
      }
    }
    debug('execute transaction mined');
  }

  /**
   * fulfillCondition
   * @param {string} transferId uuid
   * @param {string} fulfillment base64url-encoded string
   * @param {string} ilp base64url-encoded string
   * @returns {promise} A promise which resolves when the fulfillment has been submitted to ledger
   */
  async fulfillCondition(transferId, fulfillment, ilp) {
    try {
      await this._fulfillCondition(transferId, fulfillment)
    } catch (error) {
      if (error instanceof Errors.PastSequenceError) {
        debug('PastSequenceError retry fulfillCondition', transferId)
        this._sleep(500)
        await this.fulfillCondition(transferId, fulfillment, ilp)
      } else {
        throw error
      }
    }
  }

  async _fulfillCondition(transferId, fulfillment) {
    try {
      await Transaction.fulfillCondition(this.contract, transferId, fulfillment, this.address, this.privateKey, this.web3 || this.extWeb3, this.private);
    } catch (error) {
      // TODO: MECE
      const message = error.message.toString()
      if (message.indexOf('replacement transaction underpriced') >= 0) {
        throw new Errors.PastSequenceError()
      } else if (message.indexOf('known transaction') >= 0) {
        throw new Errors.PastSequenceError()
      } else {
        throw error
      }
    }
    debug('execute transaction mined');
  }

  /**
   * getTransfer
   * @param {string} uuid transfer uuid (ex:f55585e1-0c19-4588-832d-369cfa005640)
   * @returns {object} get transfer object from ledger by transfer id
   */
  async getTransfer(uuid) {
    try {
      return await this._getRddnTransfer(Transaction.uuidToHex(uuid));
    } catch(e) {
      throw e;
    }
  }

  /**
   * _getRddnTransfer
   * @param {string} _id hex string (ex:0xf55585e10c194588832d369cfa005640)
   * @return {Object} RDDN Transfer struct
   */
  async _getRddnTransfer(_id) {
    try {
      const transfer = await this.contract.methods.getTransfer(_id).call()
      if (transfer[0] === '0x0000000000000000000000000000000000000000') {
        return {
          id: uuidParse.unparse(Buffer.from(_id.substring(2), 'hex')),
          from: '',
          to: '',
          amount: 0,
          ilp: '',
          executionCondition: '',
          expiresAt: '',
          custom: '',
          state: ''
        };
      }
      const moneyId = await this.contract.methods.getMoneyIdByTransferId(_id).call()
      const ilp = base64url(Buffer
        .from((await this.contract.methods.getIlpPacket(_id).call()).slice(2), 'hex'))
      const unparsedId = uuidParse.unparse(Buffer.from(_id.substring(2), 'hex'))
      const custom = {
        moneyId: moneyId,
        direction: directionToName(transfer[6])
      }
      const result = {
        id: unparsedId,
        from: hexToAccount(this._prefix, transfer[0]),
        to: hexToAccount(this._prefix, transfer[1]),
        amount: transfer[2],
        ilp: ilp,
        executionCondition: base64url(Buffer.from(transfer[3].slice(2), 'hex')),
        expiresAt: (new Date(+transfer[4] * 1000)).toISOString(),
        custom: custom,
        state: stateToName(transfer[5])
      }
      return result
    } catch (e) {
      throw e;
    }
  }

  /**
   * getRequests
   * @param {string} address rddn addresse
   * @param {number} state 0:prepare, 1:fulfill, 2:cancel, 3:reject
   * @param {number} direction 0:deposit, 1:withdraw
   * @returns {array} array of uuid
   */
  async getRequests(_address, _state, _direction) {
    try {
      const result = await this.contract.methods.getRequests(
        _address, _state, _direction
      ).call()
      if (result.length === 0) {
        return result;
      }
      let temp = [];
      let i = 0;
      result.forEach(value => {
        temp[i++] = uuidParse.unparse(Buffer.from(value.substring(2), 'hex'));
      })
      return temp
    } catch (e) {
      throw e;
    }
  }

  async getDigitalMoney(_moneyId) {
    try {
      const result = await this.contract.methods.getMoney(_moneyId).call()
      return result
    } catch (e) {
      throw e;
    }
  }

  /**
   * forceEmitPrepare
   * force plugin to emit *_prepare event with transfer object get from ledger
   * @param {string} transferId
   * @returns {boolean} True if the transfer is loaded from ledger and the event is fully emitted. False if it's not.
   */
  async forceEmitPrepare(transferId) {
    try {
      const transfer = await this.getTransfer(transferId)
      let direction

      if (transfer.from === this.getAccount() || _.includes(this.outgoingList, transfer.from.toLowerCase())) direction = 'outgoing'
      if (transfer.to === this.getAccount() || _.includes(this.incomingList, transfer.to.toLowerCase())) direction = 'incoming'
      if (direction) {
        transfer.direction = direction
        debug('emitting ' + direction + '_prepare')
        this.emit(direction + '_prepare', transfer)
        return true
      }
      return false
    } catch (e) {
      throw e;
    }
  }

  /**
   * forceEmitFulfill
   * force plugin to emit *_fulfill event with transfer object get from ledger
   * @param {string} transferId string uuid
   * @param {string} fulfillment base64url-encoded string
   * @param {string} ilp base64url-encoded string
   * @returns {boolean} True if the transfer is loaded from ledger and the event is fully emitted. False if it's not.
   */
  async forceEmitFulfill(transferId, fulfillment, ilp) {
    try {
      const transfer = await this.getTransfer(transferId)
      let direction
      if (transfer.from === this.getAccount()) direction = 'outgoing'
      if (transfer.to === this.getAccount()) direction = 'incoming'

      if (direction) {
        transfer.direction = direction
        debug('emitting ' + direction + '_fulfill')
        this.emit(direction + '_fulfill', transfer, fulfillment, ilp)
        return true
      }
      return false
    } catch (e) {
      throw e;
    }
  }

  /**
   * sendTransfer
   * @param {object} _transfer
   * @returns {promise} A promise which resolves when the transfer has been submitted
   */
  async sendTransfer(_transfer) {
    if (!this.web3 && !this.extWeb3) throw new Error('must be connected')

    try {
      await Transaction.sendTransfer(this.contract, _transfer, this.address, this.privateKey, this._prefix, this.web3 || this.extWeb3, this.private)
    } catch (error) {
      const message = error.message.toString()
      if (message.indexOf('replacement transaction underpriced') >= 0) {
        throw new Errors.PastSequenceError()
      } else {
        throw error
      }
    }
    debug('transfer transaction mined')
  }
}

module.exports = PluginRddn
