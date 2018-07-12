import {retry} from '@kobiton/core-util'
import api from '../utils/api'

export default class Kobies {
  constructor({token, settings}) {
    this._token = token
    this._settings = settings
  }

  addDevice(deviceInfo) {
    // Removes custom fields that's only used in desktop
    const capabilities = {
      ...deviceInfo,
      desktopVersion: 'simulate 1.0'
    }

    return retry(() => api.post({
      url: 'devices/update',
      token: this._token,
      body: {
        nodeId: this._settings.nodeId,
        udid: deviceInfo.udid,
        capabilities,
        machine: this._settings.machine
      }
    }), -1, 500)
  }
}
