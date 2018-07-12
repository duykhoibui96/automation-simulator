import BPromise from 'bluebird'
import EventEmitter from 'events'
import omit from 'lodash/omit'
import request from 'request'
import * as enums from '@kobiton/core-util/enum'
import { debug, retry } from '@kobiton/core-util'
import config from '../config'
import api from '../utils/api'
import TcpConnection from '../core/connection/tcp'

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
        debug.log(this._ns, `Receive message from hub: ${JSON.stringify(message)}`)
        const { START_MANUAL, STOP_MANUAL, START_AUTO } = enums.TEST_ACTIONS
        const { type, timeoutKey, quality, fps, deviceMetricCaptureInterval } = message

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
                    debug.error(this._ns, `Unhandled error while processing message ${START_MANUAL}`)
                    debug.error(this._ns, ignored)
                }
                break
            case STOP_MANUAL:
                try {
                    await this._endSession()
                }
                catch (err) {
                    debug.error(this._ns, 'Error while ending session on STOP_MANUAL message', err)
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
        console.log('Start automation session')
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
