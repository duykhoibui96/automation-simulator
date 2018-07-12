import BPromise from 'bluebird'
import * as enums from '@kobiton/core-util/enum'
import {debug} from '@kobiton/core-util'
import config from '../config'
import api from '../utils/api'
import WebSocketClient from '../utils/websocket'

export default class Manual {
  constructor(deviceId) {
    this._ns = 'Manual_Session'
    this._ws = null
    this._deviceId = deviceId
  }

  async start() {
    const response = await api.post({
      url: 'hubs/book',
      token: config.token,
      body: {deviceId: this._deviceId}
    })

    this._ws = await this._establishWebSocketConnection(response)
  }

  async _onStartManualDone() {
    const delayTime = 2000
    debug.log(this._ns, 'NOOP')
    this._ws.sendMessage({
      type: 'NOOP'
    })

    await BPromise.delay(delayTime)
    debug.log(this._ns, 'Press Home')
    this._ws.sendMessage({
      type: 'PRESS_BUTTON',
      value: 'HOME'
    })

    await BPromise.delay(delayTime)
    debug.log(this._ns, 'Press Home 2nd')
    this._ws.sendMessage({
      type: 'PRESS_BUTTON',
      value: 'HOME'
    })

    await BPromise.delay(delayTime)
    debug.log(this._ns, 'Press Home 3rd')
    this._ws.sendMessage({
      type: 'PRESS_BUTTON',
      value: 'HOME'
    })

    await BPromise.delay(delayTime)
    debug.log(this._ns, 'Stop manual')
    this._ws.sendMessage({
      type: 'STOP_MANUAL'
    })

    this._closeWebSocketConnection()
  }

  async _establishWebSocketConnection(session) {
    const webSocket = new WebSocketClient(
      'manual',
      session.hub,
      {
        token: config.token,
        type: enums.CONNECTION_TYPES.MANUAL,
        projection: enums.SCREEN_QUALITIES.MEDIUM,
        params: session.params
      },
      {onlyJsonMessage: false}
    )

    await webSocket.open()

    webSocket.on('json', (msg) => {
      this._handleHubMessage(msg)
    })

    return webSocket
  }

  _handleHubMessage(msg) {
    debug.log('_handleHubMessage msg:', msg)
    let type = msg.type;
    if (type === 'START_MANUAL') {
      this._onStartManualDone()
    }
  }

  _closeWebSocketConnection() {
    this._ws.on('disconnected', () => {
      debug.log('_closeWebSocketConnection _cancelReconnecting')
      this._ws._cancelReconnecting()
    })
    this._ws.close()
  }
}
