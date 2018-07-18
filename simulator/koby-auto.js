import BPromise from 'bluebird'
import EventEmitter from 'events'
import omit from 'lodash/omit'
import request from 'request'
import * as enums from '@kobiton/core-util/enum'
import { debug, retry } from '@kobiton/core-util'
import config from '../config'
import api from '../utils/api'
import TcpConnection from '../core/connection/tcp'
import http, { createServer, request as _request } from "http";
import { connect } from "net";
import { parse } from "url";
import { getPorts, nextPort } from 'portfinder'
import { promisify } from "util";
import { once } from "lodash";
import httpProxy from 'http-proxy'

const getPortsAsync = promisify(getPorts)
const HOST_PORT_REGEX = /^([^:]+)(:([0-9]+))?$/

const MIN_PORT = 10000
const MAX_PORT = 49151 // 49152+ are ephemeral

let basePort = MIN_PORT

const requestAsync = BPromise.promisify(request, { multiArgs: true })

const TOUCH_ACTIONS = [
    enums.TEST_ACTIONS.TOUCH_MOVE,
    enums.TEST_ACTIONS.TOUCH_DOWN,
    enums.TEST_ACTIONS.TOUCH_UP,
    enums.TEST_ACTIONS.ZOOM
]

const PRE_SCREENSHOT_ACTIONS = [
    enums.TEST_ACTIONS.DOUBLE_PRESS_BUTTON,
    enums.TEST_ACTIONS.LONG_PRESS_BUTTON,
    enums.TEST_ACTIONS.SIMULATE_GEO_LOCATION,
    enums.DEVICE_SERVICES.TIME_ZONE_SETTING
]

export default class Koby extends EventEmitter {
    constructor({ deviceInfo, token }) {
        super()
        this._ns = `Koby_${deviceInfo.udid}`
        this._deviceInfo = deviceInfo
        this._token = token
        this._authInfo = { token, udid: deviceInfo.udid }
        this._sessionConnection = null
        this._startProxyServer()
    }

    async _findPort(count = 1) {
        // Handle race condition: assume 2 requests getting port for Appium.
        // Before Appium starts, it's possible for getPortsAsync() to return the same
        // port. Therefore, we need to increase basePort per call.
        const host = '127.0.0.1'
        const startPort = basePort

        basePort += 100 + count
        if (basePort > MAX_PORT) {
            basePort = MIN_PORT
        }

        const ports = await getPortsAsync(count, { host, port: startPort })

        // Although we increased basePort by a fairly big range, there's a chance
        // the last port returned is larger than basePort if the range was mostly
        // occupied. So need to check and set basePort accordingly.
        const lastPort = ports[ports.length - 1]
        if (lastPort >= basePort) {
            basePort = lastPort + 1
        }

        return ports[0]
    }

    _getHostPortFromString(hostString, defaultPort) {
        let host = hostString
        let port = defaultPort

        let result = HOST_PORT_REGEX.exec(hostString)
        if (result) {
            host = result[1]
            if (result[2]) {
                port = result[3]
            }
        }

        return [host, port]
    }

    async _startProxyServer() {
        const port = await this._findPort()
        let proxyServer
        const server = http.createServer((req, res) => {
            const urlObj = parse(req.url)
            const target = `${urlObj.protocol}//${urlObj.host}`

            proxyServer = httpProxy.createProxyServer({})
            proxyServer
                .on('error', (err, req, res) => {
                    if (err.code !== 'ENOTFOUND' && err.code !== 'ETIMEOUT') {
                        debug.error(this._ns, err)
                    }

                    res.end()
                })
                .web(req, res, { target })
        })

        server
            .on('connect', (req, socket, bodyhead) => {
                const hostPort = this._getHostPortFromString(req.url, 443)
                const hostDomain = hostPort[0]
                const port = parseInt(hostPort[1])
                const proxySocket = new net.Socket()

                // Closes pipe sockets while getting error
                proxySocket.on('error', () => socket && socket.removeAllListeners().destroy())
                socket.on('error', () => proxySocket && proxySocket.removeAllListeners().destroy())

                proxySocket.connect(port, hostDomain, () => {
                    proxySocket.pipe(socket)
                    socket.pipe(proxySocket)

                    // Makes the pipes always keep alive
                    proxySocket.setKeepAlive(true)
                    socket.setKeepAlive(true)

                    proxySocket.write(bodyhead)
                    socket.write(`HTTP/${req.httpVersion} 200 Connection established\r\n\r\n`)
                })
            })
            .listen(port, () => {
                debug.log('Proxy server', `Listening on port ${port}`)
            })

        return once(() => {
            proxyServer && proxyServer
                .removeAllListeners()
                .close()

            server && server
                .removeAllListeners()
                .close()
        })
    }

    async activate() {
        await this._updateStatus(enums.DEVICE_STATES.ACTIVATING)
        const getHub = () => {
            debug.log('activate getHub....')
            return api.get({ url: 'hubs/which', token: this._authInfo.token })
        }
        this._hub = await retry(getHub, -1, 5000)
        await this._establishControlConnection()
        await this._updateStatus(enums.DEVICE_STATES.ACTIVATED)
    }

    _updateStatus(status) {
        return api.put({
            url: `devices/${this._deviceInfo.udid}/status`,
            token: this._authInfo.token,
            body: {
                deviceUDID: this._deviceInfo.udid,
                state: status,
                message: this._deviceInfo.message
            }
        })
    }

    async _establishControlConnection() {
        const connectionInfo = { runningSession: !!this._session, ...this._authInfo }

        await this._disconnectControlConnection()
        this._controlConnection = new TcpConnection(
            enums.CONNECTION_TYPES.CONTROL, this._hub, connectionInfo)
        this._controlConnection
            .on('error', ({ message }) => {
                debug.error(this._ns, `Control connection error: ${message}`)
                if (message === 'not-authorized') {
                    this.emit('not-authorized')
                }
            })
            .on('message', :: this._handleMessage)
        await this._controlConnection.establish()
    }

    async _disconnectControlConnection() {
        if (this._controlConnection) {
            await this._controlConnection
                .removeAllListeners()
                .drop()
            this._controlConnection = null
        }
    }

    async _handleMessage(message) {
        const { START_MANUAL, STOP_MANUAL, START_AUTO } = enums.TEST_ACTIONS
        const { type, timeoutKey, quality, fps, deviceMetricCaptureInterval } = message
        debug.log(this._ns, '_onControlConnectionMessage:', message)

        switch (type) {
            case START_AUTO:
                try {
                    await this._startSession(
                        enums.CONNECTION_TYPES.AUTO,
                        {
                            ...this._authInfo, appium: this._appium, deviceInfo: this._deviceInfo,
                            timeoutKey
                        },
                        { json: false, reconnect: false }
                    )
                }
                catch (ignored) {
                    // Writes log for supporting investigating
                    debug.error(this._ns, `Unhandled error while processing message ${START_AUTO}`)
                    debug.error(this._ns, ignored)
                }
                break
        }
    }

    async _startSession(type, options, connectionOptions) {
        this._sessionConnection = new TcpConnection(type, this._hub, this._authInfo, connectionOptions)
        this._sessionConnection
            .on('message', :: this._onHubMessage)

        await this._sessionConnection.establish()

        this._updateStatus(enums.DEVICE_STATES.UTILIZING)
    }

    async _onHubMessage(message) {
        debug.log(this._ns, '_onHubMessage:', message)

        await this._preprocessAction(message)

        const { type } = message
        switch (type) {
            case enums.TEST_STATES.MANUAL_BEGAN:
                this._sessionId = message.sessionId
                await this._startLogService()
                break
        }
    }

    async _startLogService() {
        this._baseUrl = `${config.apiUrl}/v1/sessions/${this._sessionId}`
    }

    async _preprocessAction(message) {
        let { type, value, touch } = message
        let recordAction = false
        let recordValue = value

        if (TOUCH_ACTIONS.includes(type)) {
            const { x, y, duration } = message

            if (type === enums.TEST_ACTIONS.TOUCH_DOWN) {
                this._lastTouchDownPoint = { x, y }
            }
            else if (type === enums.TEST_ACTIONS.TOUCH_UP) {
                recordAction = true

                if (x === this._lastTouchDownPoint.x && y === this._lastTouchDownPoint.y) {
                    recordValue = this._lastTouchDownPoint
                    type = enums.TOUCH_ACTIONS.TOUCH
                }
                else if (duration > 500) {
                    recordValue = {
                        x1: this._lastTouchDownPoint.x,
                        y1: this._lastTouchDownPoint.y,
                        x2: x,
                        y2: y
                    }
                    type = enums.TOUCH_ACTIONS.DRAG
                }
                else {
                    recordValue = {
                        x1: this._lastTouchDownPoint.x,
                        y1: this._lastTouchDownPoint.y,
                        x2: x,
                        y2: y
                    }
                    type = enums.TOUCH_ACTIONS.SWIPE
                }
            }
        }

        if (type === enums.TEST_ACTIONS.ZOOM) {
            if (touch === enums.TEST_ACTIONS.TOUCH_UP) {
                recordAction = true
                recordValue = omit(message, 'type', 'from1', 'from2')
                recordValue = { ...recordValue, ...this._zoomInfo }
            }
            else if (touch === enums.TEST_ACTIONS.TOUCH_DOWN) {
            }
        }
        else if (type === enums.TEST_ACTIONS.PRESS_BUTTON &&
            value !== enums.DEVICE_KEYBOARDS.DELETE && value !== enums.DEVICE_KEYBOARDS.ENTER) {
            recordAction = true
        }
        else if (PRE_SCREENSHOT_ACTIONS.includes(type)) {
            recordAction = true
        }

        if (recordAction) {
            if (type === enums.TEST_ACTIONS.SIMULATE_GEO_LOCATION) {
                const { lat, long } = message
                recordValue = { lat, long }
            }
            else if (type === enums.DEVICE_SERVICES.TIME_ZONE_SETTING) {
                const { timezone } = message
                recordValue = { timezone }
            }

            await this._recordAction(type, recordValue)
        }
    }

    async _recordAction(action, value) {
        await this._getCommandId(action, value)
    }

    async _getCommandId(action, value) {
        if (!this._baseUrl) return

        const [{ statusCode }, { id }] = await requestAsync({
            url: `${this._baseUrl}/commands`,
            method: 'POST',
            json: true,
            body: { action, value },
            headers: {
                Authorization: `Bearer ${this._token}`
            }
        })

        if (statusCode >= 300) {
            throw new Error(`Non-success response from saving action to API: ${statusCode}`)
        }

        return id
    }

    async _endSession() {
        await this._disconnectControlConnection()
        await this._sessionConnection
            .removeAllListeners()
            .drop()

        this.emit('session-ended')
    }
}
