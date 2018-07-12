import {debug} from '@kobiton/core-util'
import config from './config'
import api from './utils/api'
import Kobies from './simulator/kobies'
import Koby from './simulator/koby'
import Auto from './simulator/auto'
import Manual from './simulator/manual'

import BPromise from 'bluebird'

// To enable debug msg, uncomment next line
debug.enable('*')
api.setDefaultBaseUrl(config.apiUrl + '/v1/')

const deviceInfo = {
  udid: 'khoibui-device',
  deviceName: 'TaSi 01',
  deviceType: 'iPhone',
  installedBrowsers: [{name: 'safari'}],
  isEmulator: false,
  isHidden: false,
  modelName: 'D10AP',
  name: 'iPhone 7',
  platformName: 'iOS',
  platformVersion: '10.3.3',
  productType: 'iPhone9,1',
  support: {
    appiumDisabled: false,
    networkTrafficCapturingDisabled: false
  }
}

// This function was used to add new device to db
async function addDevice() {
  const kobies = new Kobies({
    token: config.token,
    settings: {
      nodeId: 'simulator-node-1',
      machine: {
        hostname: 'Khoi-PC',
        arch: 'x64',
        freemem: 444768256,
        totalmem: 17179869184,
        platform: 'darwin',
        type: 'Darwin',
        uptime: 74664,
        version: '1.0.0',
        buildNumber: 'N/A',
        network: {
          address: '192.168.102.25',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '4c:8d:79:ea:96:fe',
          internal: false
        }
      }
    }
  })

  await kobies.addDevice(deviceInfo)
}

async function main() {

  await addDevice()

  const targetDeviceId = 106393 //Device ID to be simulate
  await simulateManualSession(targetDeviceId)
  //await simulateAutoSession(targetDeviceId)

  debug.log('Session ENDED - Exiting..')
}

function simulateManualSession(deviceId) {
  return new BPromise(async (resolve, reject) => {
    const koby = new Koby({
      deviceInfo,
      token: config.token
    })

    await koby.activate()
      .catch((err) => {
        console.log(err)
        reject(err)
      })

    console.log('Start manual')
    const appInstance = new Manual(deviceId)
    await appInstance
      .start()
      .catch((err) => {
        reject(err)
      })

    koby.on('session-ended', () => {
      resolve()
    })
  })
}

function simulateAutoSession(deviceId) {
  return new BPromise(async (resolve, reject) => {
    const koby = new Koby({
      deviceInfo,
      token: config.token
    })

    await koby.activate()
      .catch((err) => {
        reject(err)
      })

    debug.log('Start Auto')
    await new Auto(deviceInfo)
      .start()
      .catch(async (err) => {
        await koby._disconnectControlConnection()
        reject(err)
      })

    resolve()
    // TODO: This line to make program exit, have to remove when flow completed
    await koby._disconnectControlConnection()
  })
}

main()
