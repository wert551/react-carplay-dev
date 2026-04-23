#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DONGLE_VENDOR_ID = 0x1314
const DONGLE_PRODUCT_IDS = new Set([0x1520, 0x1521])
const DEFAULT_TIMEOUT_MS = Number(process.env.CARPLAY_PROBE_TIMEOUT_MS ?? 0)
const START_RETRY_LIMIT = Number(process.env.CARPLAY_PROBE_START_RETRIES ?? 2)
const DONGLE_REDISCOVERY_TIMEOUT_MS = Number(process.env.CARPLAY_PROBE_REDISCOVERY_TIMEOUT_MS ?? 15000)
const DONGLE_POLL_INTERVAL_MS = Number(process.env.CARPLAY_PROBE_POLL_INTERVAL_MS ?? 1000)

let nativeModule = null
let usbModule = null
let carplay = null
let sessionConnected = false
let stopping = false

const now = () => new Date().toISOString()

const log = (event, details = {}) => {
  console.log(JSON.stringify({ timestamp: now(), event, ...details }))
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const formatDevice = (dongle) => {
  if (!dongle?.deviceDescriptor) return {}
  return {
    vendorId: `0x${dongle.deviceDescriptor.idVendor.toString(16)}`,
    productId: `0x${dongle.deviceDescriptor.idProduct.toString(16)}`,
    busNumber: dongle.busNumber,
    deviceAddress: dongle.deviceAddress
  }
}

const getErrorMessage = (error) => {
  if (error instanceof Error) return error.message
  return String(error)
}

const getErrorStack = (error) => {
  if (error instanceof Error) return error.stack
  return undefined
}

const isResetLostDeviceError = (error) => {
  const message = getErrorMessage(error)
  const stack = getErrorStack(error) ?? ''
  return (
    /LIBUSB_ERROR_NOT_FOUND/i.test(message) ||
    /LIBUSB_ERROR_NO_DEVICE/i.test(message) ||
    (/reset/i.test(message) && /not_found|no_device|device/i.test(message)) ||
    /WebUSBDevice\.reset/i.test(stack)
  )
}

const getStartupFailureDiagnostic = (error, recoverableResetError) => {
  const message = getErrorMessage(error)
  if (recoverableResetError) {
    return 'The dongle vanished during reset or node-carplay/node kept a stale device reference. Waiting for re-enumeration and retrying with a new runtime instance.'
  }
  if (/LIBUSB_ERROR_BUSY|busy|access/i.test(message)) {
    return 'The dongle may be owned by another process. Stop Electron/dev sessions and check for other node/electron processes before rerunning the probe.'
  }
  if (/permission|denied|LIBUSB_ERROR_ACCESS/i.test(message)) {
    return 'USB permissions may be blocking native access. Check udev rules, group membership, and whether the probe is running with the same permissions as the working Pi Electron path.'
  }
  return 'Native startup failed for a reason that is not recognized as reset/re-enumeration.'
}

const summarize = (value) => {
  if (value == null) return value
  if (ArrayBuffer.isView(value)) {
    return {
      type: value.constructor.name,
      byteLength: value.byteLength
    }
  }
  if (value instanceof ArrayBuffer) {
    return {
      type: 'ArrayBuffer',
      byteLength: value.byteLength
    }
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map(summarize)
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['data', 'buffer'].includes(key))
        .slice(0, 12)
        .map(([key, child]) => [key, summarize(child)])
    )
  }
  return value
}

const loadOptionalJson = (candidatePath) => {
  if (!candidatePath || !fs.existsSync(candidatePath)) return null
  try {
    return JSON.parse(fs.readFileSync(candidatePath, 'utf-8'))
  } catch (error) {
    log('sessionError', {
      error: `Failed to read config JSON at ${candidatePath}: ${error.message}`
    })
    return null
  }
}

const getConfig = () => {
  const defaultConfig = nativeModule.DEFAULT_CONFIG ?? nativeModule.default?.DEFAULT_CONFIG ?? {}
  const configCandidates = [
    process.env.CARPLAY_PROBE_CONFIG,
    path.join(os.homedir(), '.config', 'react-carplay', 'config.json')
  ]

  const diskConfig = configCandidates.map(loadOptionalJson).find(Boolean) ?? {}
  return {
    ...defaultConfig,
    ...diskConfig
  }
}

const getNativeConstructor = () => {
  const candidates = [
    nativeModule.default,
    nativeModule.CarplayNode,
    nativeModule.CarPlayNode,
    nativeModule.Carplay,
    nativeModule.CarPlay,
    nativeModule.NodeCarplay,
    nativeModule.NodeCarPlay
  ]

  return candidates.find((candidate) => typeof candidate === 'function') ?? null
}

const loadDependencies = () => {
  try {
    nativeModule = require('node-carplay/node')
  } catch (error) {
    log('sessionError', {
      error: `Unable to require node-carplay/node: ${error.message}`
    })
    process.exitCode = 1
    return false
  }

  try {
    usbModule = require('usb')
  } catch (error) {
    log('probeWarning', {
      warning: `Unable to require usb for dongle preflight; native runtime may still work: ${error.message}`
    })
  }

  let resolved = null
  try {
    resolved = require.resolve('node-carplay/node')
  } catch {
    resolved = null
  }

  log('moduleLoaded', {
    modulePath: resolved,
    nodeCarplayNodeExports: Object.keys(nativeModule),
    hasDefaultExport: typeof nativeModule.default !== 'undefined',
    hasDefaultConfig: Boolean(nativeModule.DEFAULT_CONFIG ?? nativeModule.default?.DEFAULT_CONFIG),
    usbAvailable: Boolean(usbModule)
  })

  return true
}

const findDongle = () => {
  if (!usbModule?.getDeviceList) return null
  return usbModule.getDeviceList().find((device) => {
    const descriptor = device.deviceDescriptor
    return descriptor?.idVendor === DONGLE_VENDOR_ID && DONGLE_PRODUCT_IDS.has(descriptor.idProduct)
  }) ?? null
}

const waitForDongle = async ({ rediscovery = false, timeoutMs = 0 } = {}) => {
  log(rediscovery ? 'resetLostDevice' : 'waitingForDongle', {
    timeoutMs: timeoutMs || undefined
  })

  if (!usbModule?.getDeviceList) {
    log('probeWarning', {
      warning: 'Skipping explicit dongle scan because usb.getDeviceList is unavailable'
    })
    return null
  }

  const startedAt = Date.now()
  while (!stopping) {
    const dongle = findDongle()
    if (dongle) {
      log(rediscovery ? 'dongleRediscovered' : 'dongleFound', {
        elapsedMs: Date.now() - startedAt,
        ...formatDevice(dongle)
      })
      return dongle
    }
    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      return null
    }
    await delay(DONGLE_POLL_INTERVAL_MS)
  }
  return null
}

const safeStopCarplay = async (reason) => {
  if (!carplay || typeof carplay.stop !== 'function') return
  try {
    await carplay.stop()
  } catch (error) {
    log('probeWarning', {
      warning: `Ignoring stop() failure while recovering from ${reason}: ${getErrorMessage(error)}`
    })
  }
}

const startCarplay = async (dongle) => {
  if (carplay.start.length > 0 && dongle) {
    log('nativeStartInvoked', {
      mode: 'start(device)',
      expectedArgs: carplay.start.length
    })
    return carplay.start(dongle)
  }

  log('nativeStartInvoked', {
    mode: 'start()',
    expectedArgs: carplay.start.length
  })
  return carplay.start()
}

const createRuntime = (NativeCarplay, config) => {
  carplay = new NativeCarplay(config)
  attachMessageHandler()
  if (typeof carplay.start !== 'function') {
    log('sessionError', {
      error: 'Native runtime instance does not expose start()',
      instanceKeys: Object.keys(carplay)
    })
    process.exitCode = 2
    return false
  }
  return true
}

const startWithResetRecovery = async (NativeCarplay, config, initialDongle) => {
  let dongle = initialDongle

  for (let attempt = 0; attempt <= START_RETRY_LIMIT && !stopping; attempt += 1) {
    if (attempt > 0) {
      log('startRetried', {
        attempt,
        maxRetries: START_RETRY_LIMIT
      })
    }

    if (!createRuntime(NativeCarplay, config)) return false

    try {
      log('resetStarted', {
        attempt,
        note: 'node-carplay/node performs dongle reset during start; LIBUSB_ERROR_NOT_FOUND usually means the device disappeared and may re-enumerate'
      })
      await startCarplay(dongle)
      log('nativeStartReturned')
      return true
    } catch (error) {
      const recoverableResetError = isResetLostDeviceError(error)
      log(recoverableResetError ? 'resetLostDevice' : 'sessionError', {
        attempt,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        diagnostic: getStartupFailureDiagnostic(error, recoverableResetError)
      })

      await safeStopCarplay('failed start')
      carplay = null

      if (!recoverableResetError || attempt >= START_RETRY_LIMIT) {
        if (recoverableResetError) {
          log('sessionError', {
            error: 'Native startup did not recover after dongle reset/re-enumeration retries',
            recommendation:
              'Patch node-carplay/node around WebUSBDevice.reset/startup to rediscover the device after reset instead of reusing the stale device handle.'
          })
        }
        process.exitCode = 1
        return false
      }

      dongle = await waitForDongle({
        rediscovery: true,
        timeoutMs: DONGLE_REDISCOVERY_TIMEOUT_MS
      })

      if (!dongle) {
        log('sessionError', {
          error: 'Dongle did not reappear after reset',
          timeoutMs: DONGLE_REDISCOVERY_TIMEOUT_MS,
          diagnostic:
            'If the dongle remains missing, check USB power, cable, kernel logs, permissions, and whether another process such as Electron still owns the device.'
        })
        process.exitCode = 1
        return false
      }
    }
  }

  return false
}

const mapMessageToEvent = (message) => {
  const type = message?.type
  switch (type) {
    case 'plugged':
    case 'phoneConnected':
      sessionConnected = true
      log('phoneConnected')
      break
    case 'unplugged':
    case 'phoneDisconnected':
      sessionConnected = false
      log('phoneDisconnected')
      break
    case 'failure':
      log('sessionError', {
        error: 'node-carplay/native reported failure',
        message: summarize(message)
      })
      break
    case 'video':
      if (!sessionConnected) {
        sessionConnected = true
        log('phoneConnected', { inferredFrom: 'video' })
      }
      break
    default:
      log('nativeMessage', {
        type: type ?? typeof message,
        message: summarize(message)
      })
      break
  }
}

const attachMessageHandler = () => {
  if (!carplay) return

  if ('onmessage' in carplay || Object.isExtensible(carplay)) {
    carplay.onmessage = mapMessageToEvent
  }

  if (typeof carplay.on === 'function') {
    ;['message', 'plugged', 'unplugged', 'failure', 'error', 'video', 'audio'].forEach((eventName) => {
      carplay.on(eventName, (payload) => {
        if (eventName === 'error') {
      log('sessionError', {
        error: getErrorMessage(payload)
      })
          return
        }
        mapMessageToEvent({ type: eventName, message: payload })
      })
    })
  }
}

const startNativeRuntime = async () => {
  const NativeCarplay = getNativeConstructor()
  if (!NativeCarplay) {
    log('sessionError', {
      error: 'node-carplay/node did not expose a usable native runtime constructor',
      exports: Object.keys(nativeModule)
    })
    process.exitCode = 2
    return false
  }

  const config = getConfig()
  log('nativeRuntimeCandidate', {
    constructorName: NativeCarplay.name || '(anonymous)',
    configKeys: Object.keys(config).sort(),
    startRetryLimit: START_RETRY_LIMIT,
    rediscoveryTimeoutMs: DONGLE_REDISCOVERY_TIMEOUT_MS
  })

  const dongle = await waitForDongle()
  if (stopping) return false

  log('waitingForPhone')
  try {
    return startWithResetRecovery(NativeCarplay, config, dongle)
  } catch (error) {
    log('sessionError', {
      error: getErrorMessage(error),
      stack: getErrorStack(error)
    })
    process.exitCode = 1
    return false
  }
}

const stopNativeRuntime = async () => {
  if (stopping) return
  stopping = true
  try {
    if (carplay && typeof carplay.stop === 'function') {
      await carplay.stop()
    }
    log('sessionStopped')
  } catch (error) {
    log('sessionError', {
      error: `Failed to stop native runtime: ${getErrorMessage(error)}`
    })
  }
}

const main = async () => {
  log('probeStarted', {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid
  })

  if (!loadDependencies()) return

  const started = await startNativeRuntime()
  if (!started) return

  if (DEFAULT_TIMEOUT_MS > 0) {
    setTimeout(() => {
      stopNativeRuntime().finally(() => process.exit(process.exitCode ?? 0))
    }, DEFAULT_TIMEOUT_MS)
  }
}

process.on('SIGINT', () => {
  stopNativeRuntime().finally(() => process.exit(process.exitCode ?? 0))
})

process.on('SIGTERM', () => {
  stopNativeRuntime().finally(() => process.exit(process.exitCode ?? 0))
})

main().catch((error) => {
  log('sessionError', {
    error: getErrorMessage(error),
    stack: getErrorStack(error)
  })
  process.exit(1)
})
