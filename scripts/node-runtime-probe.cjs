#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DONGLE_VENDOR_ID = 0x1314
const DONGLE_PRODUCT_IDS = new Set([0x1520, 0x1521])
const DEFAULT_TIMEOUT_MS = Number(process.env.CARPLAY_PROBE_TIMEOUT_MS ?? 0)

let nativeModule = null
let usbModule = null
let carplay = null
let sessionConnected = false
let stopping = false

const now = () => new Date().toISOString()

const log = (event, details = {}) => {
  console.log(JSON.stringify({ timestamp: now(), event, ...details }))
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

const waitForDongle = async () => {
  log('waitingForDongle')

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
      log('dongleFound', {
        elapsedMs: Date.now() - startedAt,
        vendorId: `0x${dongle.deviceDescriptor.idVendor.toString(16)}`,
        productId: `0x${dongle.deviceDescriptor.idProduct.toString(16)}`
      })
      return dongle
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return null
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
            error: payload instanceof Error ? payload.message : String(payload)
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
    configKeys: Object.keys(config).sort()
  })

  const dongle = await waitForDongle()
  if (stopping) return false

  log('waitingForPhone')
  try {
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

    await startCarplay(dongle)
    log('nativeStartReturned')
    return true
  } catch (error) {
    log('sessionError', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
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
      error: `Failed to stop native runtime: ${error instanceof Error ? error.message : String(error)}`
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
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  })
  process.exit(1)
})
