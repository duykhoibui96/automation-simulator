import {URL} from 'url'
import wd from 'wd'
import {debug} from '@kobiton/core-util'
import config from '../config'

export default class Auto {
  constructor(deviceInfo) {
    this._ns = `Auto_Session_${deviceInfo.udid}`
    this._deviceInfo = deviceInfo
  }

  async start() {
    const desiredCaps = {
      sessionName: 'Simulate automation test session',
      sessionDescription: 'This is an example for app',
      deviceOrientation: 'portrait',
      captureScreenshots: true,
      deviceGroup: 'ORGANIZATION',
      browserName: 'safari',
      deviceName: this._deviceInfo.deviceName,
      platformName: this._deviceInfo.platformName
    }

    const apiUrl = new URL(config.apiUrl)
    const kobitonServerConfig = {
      protocol: apiUrl.protocol.replace(':', ''),
      host: apiUrl.hostname,
      port: apiUrl.port,
      auth: `${config.username}:${config.apiKey}`
    }

    let driver

    try {
      driver = wd.promiseChainRemote(kobitonServerConfig)
      driver.on('status', (info) => {
        debug.log(`${this._ns} status:`, info)
      })
      driver.on('command', (meth, path, data) => {
        debug.log(`${this._ns} command:`, `${meth || ''} ${path || ''} ${data || ''}`)
      })
      driver.on('http', (meth, path, data) => {
        debug.log(`${this._ns} http:`, ` > ${meth || ''} ${path || ''} ${data || ''}`)
      })

      try {
        await driver.init(desiredCaps)
      }
      catch (err) {
        if (err.data) {
          debug.error(this.ns, `init driver: ${err.data}`)
        }
        throw err
      }

      await driver.get('https://www.google.com')
        .waitForElementByName('q')
        .sendKeys('Kobiton')
        .sleep(3000)
        .waitForElementByName('btnG')
        .click()
    }
    finally {
      if (driver != null) {
        try {
          await driver.quit()
        }
        catch (err) {
          debug.error(this.ns, `quit driver: ${err}`)
        }
      }
    }
  }
}
