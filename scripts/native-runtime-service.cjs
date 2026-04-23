#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Server } = require('socket.io')

const DONGLE_VENDOR_ID = 0x1314
const DONGLE_PRODUCT_IDS = new Set([0x1520, 0x1521])
const PORT = Number(process.env.CARPLAY_NATIVE_PORT ?? 4100)
const CONFIG_PATH =
  process.env.CARPLAY_NATIVE_CONFIG ?? path.join(os.homedir(), '.config', 'react-carplay', 'config.json')
const START_RETRY_LIMIT = Number(process.env.CARPLAY_NATIVE_START_RETRIES ?? 2)
const DONGLE_REDISCOVERY_TIMEOUT_MS = Number(process.env.CARPLAY_NATIVE_REDISCOVERY_TIMEOUT_MS ?? 30000)
const DONGLE_POLL_INTERVAL_MS = Number(process.env.CARPLAY_NATIVE_POLL_INTERVAL_MS ?? 1000)
const USB_RESET_SETTLE_MS = Number(process.env.CARPLAY_NATIVE_RESET_SETTLE_MS ?? 500)
const WIFI_PAIR_DELAY_MS = Number(process.env.CARPLAY_NATIVE_WIFI_PAIR_DELAY_MS ?? 15000)
const USB_STOP_RESET_TIMEOUT_MS = Number(process.env.CARPLAY_NATIVE_STOP_RESET_TIMEOUT_MS ?? 2500)
const USB_CLOSE_TIMEOUT_MS = Number(process.env.CARPLAY_NATIVE_CLOSE_TIMEOUT_MS ?? 1000)
const AUTO_START = process.env.CARPLAY_NATIVE_AUTOSTART === '1'

let nativeModule = null
let usbModule = null
let NativeCarplay = null
let carplay = null
let activeWebUsbDevice = null
let config = null
let startPromise = null
let stopPromise = null
let stopping = false

const status = {
  desiredSession: 'stopped',
  session: 'idle',
  isPlugged: false,
  deviceFound: false,
  receivingVideo: false,
  cameraVisible: false,
  lastError: null,
  startedAt: null,
  stoppedAt: null,
  updatedAt: Date.now(),
  metadata: {
    runtimeEngine: 'native-node',
    configPath: CONFIG_PATH,
    port: PORT,
    lastEventAt: null,
    lastMessageAt: null
  },
  messageCounts: {
    audio: 0,
    video: 0,
    media: 0,
    command: 0,
    nativeMessage: 0
  }
}

const now = () => new Date().toISOString()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const io = new Server({
  cors: {
    origin: '*'
  }
})

const log = (event, details = {}) => {
  const payload = { timestamp: now(), event, ...details }
  console.log(JSON.stringify(payload))
  io.emit('sessionEvent', payload)
}

const emitStatus = () => {
  status.updatedAt = Date.now()
  io.emit('status', status)
}

const setStatus = (update) => {
  Object.assign(status, update)
  emitStatus()
  return status
}

const setSession = (session, extra = {}) => {
  setStatus({
    session,
    lastError: session === 'error' ? status.lastError : null,
    metadata: {
      ...status.metadata,
      lastEventAt: Date.now()
    },
    ...extra
  })
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

const isPendingCloseError = (error) => /pending request|can't close device/i.test(getErrorMessage(error))

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

const formatDevice = (dongle) => {
  if (!dongle?.deviceDescriptor) return {}
  return {
    vendorId: `0x${dongle.deviceDescriptor.idVendor.toString(16)}`,
    productId: `0x${dongle.deviceDescriptor.idProduct.toString(16)}`,
    busNumber: dongle.busNumber,
    deviceAddress: dongle.deviceAddress
  }
}

const formatWebUsbDevice = (device) => {
  if (!device) return {}
  return {
    vendorId: typeof device.vendorId === 'number' ? `0x${device.vendorId.toString(16)}` : undefined,
    productId: typeof device.productId === 'number' ? `0x${device.productId.toString(16)}` : undefined,
    productName: device.productName,
    manufacturerName: device.manufacturerName,
    serialNumber: device.serialNumber,
    opened: device.opened
  }
}

const loadDependencies = () => {
  nativeModule = require('node-carplay/node')
  usbModule = require('usb')
  NativeCarplay =
    [
      nativeModule.default,
      nativeModule.CarplayNode,
      nativeModule.CarPlayNode,
      nativeModule.Carplay,
      nativeModule.CarPlay,
      nativeModule.NodeCarplay,
      nativeModule.NodeCarPlay
    ].find((candidate) => typeof candidate === 'function') ?? null

  if (!NativeCarplay) {
    throw new Error(`node-carplay/node did not expose a native Carplay constructor: ${Object.keys(nativeModule)}`)
  }
  if (!usbModule?.webusb?.requestDevice) {
    throw new Error('usb.webusb.requestDevice is unavailable')
  }

  log('serviceReady', {
    modulePath: require.resolve('node-carplay/node'),
    constructorName: NativeCarplay.name || '(anonymous)',
    nodeCarplayNodeExports: Object.keys(nativeModule),
    configPath: CONFIG_PATH,
    port: PORT
  })
}

const loadConfig = () => {
  const defaults = nativeModule.DEFAULT_CONFIG ?? nativeModule.default?.DEFAULT_CONFIG ?? {}
  let diskConfig = {}

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      diskConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    } catch (error) {
      log('sessionError', {
        error: `Failed to read config at ${CONFIG_PATH}: ${getErrorMessage(error)}`
      })
    }
  }

  config = {
    ...defaults,
    ...diskConfig
  }
  persistConfig()
  return config
}

const persistConfig = () => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)
}

const validateConfig = (candidate) => {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { valid: false, errors: ['config must be an object'] }
  }
  return { valid: true, errors: [] }
}

const setConfig = (update) => {
  const validation = validateConfig(update)
  if (!validation.valid) {
    throw new Error(validation.errors.join(', '))
  }
  config = {
    ...config,
    ...update
  }
  persistConfig()
  io.emit('config', config)
  return config
}

const findDongle = () => {
  if (!usbModule?.getDeviceList) return null
  return (
    usbModule.getDeviceList().find((device) => {
      const descriptor = device.deviceDescriptor
      return descriptor?.idVendor === DONGLE_VENDOR_ID && DONGLE_PRODUCT_IDS.has(descriptor.idProduct)
    }) ?? null
  )
}

const waitForDongle = async ({ rediscovery = false, timeoutMs = 0 } = {}) => {
  const eventName = rediscovery ? 'resetLostDevice' : 'waitingForDongle'
  log(eventName, { timeoutMs: timeoutMs || undefined })
  setSession(rediscovery ? 'starting' : 'waiting_for_dongle', { deviceFound: false })

  const startedAt = Date.now()
  while (!stopping) {
    const dongle = findDongle()
    if (dongle) {
      log(rediscovery ? 'dongleRediscovered' : 'dongleFound', {
        elapsedMs: Date.now() - startedAt,
        ...formatDevice(dongle)
      })
      setStatus({ deviceFound: true })
      return dongle
    }
    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      return null
    }
    await delay(DONGLE_POLL_INTERVAL_MS)
  }
  return null
}

const requestWebUsbDongle = async ({ timeoutMs = 0 } = {}) => {
  const filters = nativeModule.DongleDriver?.knownDevices ?? [
    { vendorId: DONGLE_VENDOR_ID, productId: 0x1520 },
    { vendorId: DONGLE_VENDOR_ID, productId: 0x1521 }
  ]
  const startedAt = Date.now()

  while (!stopping) {
    try {
      const device = await usbModule.webusb.requestDevice({ filters })
      if (device) return device
    } catch {
      // requestDevice throws while the dongle is absent during reset/re-enumeration.
    }

    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      return null
    }
    await delay(DONGLE_POLL_INTERVAL_MS)
  }

  return null
}

const closeWebUsbDevice = async (device, reason) => {
  if (!device?.opened || typeof device.close !== 'function') return
  try {
    await Promise.race([
      device.close(),
      delay(USB_CLOSE_TIMEOUT_MS).then(() => {
        throw new Error(`close timed out after ${USB_CLOSE_TIMEOUT_MS}ms`)
      })
    ])
  } catch (error) {
    const warning = isPendingCloseError(error) ? 'usbCloseDeferred' : 'usbCloseWarning'
    log(warning, {
      reason,
      warning: getErrorMessage(error),
      diagnostic:
        'Shutdown continues after dropping the stale WebUSB handle. A reset is used first to settle pending transfers on Raspberry Pi.'
    })
  }
}

const resetAndReopenDongle = async () => {
  const resetDevice = await requestWebUsbDongle()
  if (!resetDevice) throw new Error('Unable to acquire dongle before reset')

  log('resetStarted', {
    mode: 'patched',
    ...formatWebUsbDevice(resetDevice)
  })

  await resetDevice.open()
  try {
    await resetDevice.reset()
  } catch (error) {
    if (!isResetLostDeviceError(error)) throw error
    log('resetLostDevice', {
      error: getErrorMessage(error),
      diagnostic:
        'WebUSBDevice.reset() caused the dongle to disappear. The stale handle is discarded before startup continues.'
    })
  } finally {
    await closeWebUsbDevice(resetDevice, 'startup reset')
  }

  if (USB_RESET_SETTLE_MS > 0) await delay(USB_RESET_SETTLE_MS)

  const rediscoveredNativeDevice = await waitForDongle({
    rediscovery: true,
    timeoutMs: DONGLE_REDISCOVERY_TIMEOUT_MS
  })
  if (!rediscoveredNativeDevice) {
    throw new Error(`Dongle did not re-enumerate after reset within ${DONGLE_REDISCOVERY_TIMEOUT_MS}ms`)
  }

  const rediscoveredDevice = await requestWebUsbDongle({
    timeoutMs: DONGLE_REDISCOVERY_TIMEOUT_MS
  })
  if (!rediscoveredDevice) {
    throw new Error(`Dongle did not become available through usb.webusb after ${DONGLE_REDISCOVERY_TIMEOUT_MS}ms`)
  }

  await rediscoveredDevice.open()
  activeWebUsbDevice = rediscoveredDevice
  log('deviceReopened', {
    ...formatWebUsbDevice(rediscoveredDevice)
  })
  return rediscoveredDevice
}

const scheduleWifiPair = (runtimeConfig) => {
  const SendCommand = nativeModule.SendCommand
  if (typeof SendCommand !== 'function') {
    log('runtimeMessage', {
      type: 'wifiPairSkipped',
      reason: 'node-carplay/node does not export SendCommand'
    })
    return
  }

  carplay._pairTimeout = setTimeout(() => {
    log('runtimeMessage', {
      type: 'wifiPairTimeout',
      delayMs: WIFI_PAIR_DELAY_MS
    })
    carplay?.dongleDriver?.send(new SendCommand('wifiPair'))
  }, WIFI_PAIR_DELAY_MS)

  log('runtimeMessage', {
    type: 'wifiPairScheduled',
    delayMs: WIFI_PAIR_DELAY_MS,
    width: runtimeConfig.width,
    height: runtimeConfig.height,
    fps: runtimeConfig.fps
  })
}

const attachMessageHandler = () => {
  carplay.onmessage = (message) => {
    const type = message?.type ?? 'nativeMessage'
    status.metadata.lastMessageAt = Date.now()

    if (type in status.messageCounts) {
      status.messageCounts[type] += 1
    } else {
      status.messageCounts.nativeMessage += 1
    }

    switch (type) {
      case 'plugged':
      case 'phoneConnected':
        log('phoneConnected')
        setSession('connected', {
          isPlugged: true,
          deviceFound: true
        })
        break
      case 'unplugged':
      case 'phoneDisconnected':
        log('phoneDisconnected')
        setSession('waiting_for_phone', {
          isPlugged: false,
          receivingVideo: false
        })
        break
      case 'video':
        if (!status.isPlugged) {
          log('phoneConnected', { inferredFrom: 'video' })
          setSession('connected', {
            isPlugged: true,
            deviceFound: true
          })
        }
        setStatus({ receivingVideo: true })
        io.emit('runtimeMessage', { type, message: summarize(message?.message) })
        break
      case 'audio':
      case 'media':
      case 'command':
        io.emit('runtimeMessage', { type, message: summarize(message?.message) })
        log('runtimeMessage', {
          type,
          message: summarize(message?.message)
        })
        break
      case 'failure':
        log('sessionError', { error: 'node-carplay/native reported failure' })
        setSession('error', { lastError: 'node-carplay/native reported failure' })
        break
      default:
        io.emit('runtimeMessage', { type, message: summarize(message) })
        log('runtimeMessage', {
          type,
          message: summarize(message)
        })
        break
    }
  }
}

const createRuntime = () => {
  carplay = new NativeCarplay(config)
  attachMessageHandler()
  if (!carplay?.dongleDriver?.initialise || !carplay?.dongleDriver?.start) {
    throw new Error('CarplayNode does not expose dongleDriver.initialise/start')
  }
}

const startPatchedRuntime = async () => {
  createRuntime()
  const device = await resetAndReopenDongle()
  const runtimeConfig = carplay._config ?? config
  await carplay.dongleDriver.initialise(device)
  await carplay.dongleDriver.start(runtimeConfig)
  scheduleWifiPair(runtimeConfig)
}

const startSession = async () => {
  status.desiredSession = 'running'
  if (status.session === 'connected' || status.session === 'starting' || status.session === 'waiting_for_phone') {
    emitStatus()
    return status
  }
  if (startPromise) return startPromise

  stopping = false
  startPromise = (async () => {
    setSession('starting', {
      lastError: null,
      startedAt: Date.now(),
      stoppedAt: null,
      receivingVideo: false
    })

    for (let attempt = 0; attempt <= START_RETRY_LIMIT && !stopping; attempt += 1) {
      if (attempt > 0) {
        log('startRetried', { attempt, maxRetries: START_RETRY_LIMIT })
      }

      try {
        await waitForDongle()
        if (stopping) return status
        log('waitingForPhone')
        setSession('waiting_for_phone')
        await startPatchedRuntime()
        return status
      } catch (error) {
        await cleanupNativeRuntime({ reason: 'failed start', emitStopped: false })
        const recoverable = isResetLostDeviceError(error) && attempt < START_RETRY_LIMIT
        log(recoverable ? 'resetLostDevice' : 'sessionError', {
          attempt,
          error: getErrorMessage(error),
          stack: getErrorStack(error)
        })
        if (!recoverable) {
          setSession('error', { lastError: getErrorMessage(error) })
          return status
        }
      }
    }

    return status
  })().finally(() => {
    startPromise = null
  })

  return startPromise
}

const clearRuntimeTimers = () => {
  if (carplay?._pairTimeout) {
    clearTimeout(carplay._pairTimeout)
    carplay._pairTimeout = null
  }
  if (carplay?._frameInterval) {
    clearInterval(carplay._frameInterval)
    carplay._frameInterval = null
  }
  if (carplay?.dongleDriver?._heartbeatInterval) {
    clearInterval(carplay.dongleDriver._heartbeatInterval)
    carplay.dongleDriver._heartbeatInterval = null
  }
}

const resetDeviceForStop = async (device) => {
  if (!device?.opened || typeof device.reset !== 'function') return
  try {
    await Promise.race([
      device.reset(),
      delay(USB_STOP_RESET_TIMEOUT_MS).then(() => {
        throw new Error(`stop reset timed out after ${USB_STOP_RESET_TIMEOUT_MS}ms`)
      })
    ])
  } catch (error) {
    if (isResetLostDeviceError(error)) {
      log('resetLostDevice', {
        phase: 'stop',
        error: getErrorMessage(error),
        diagnostic: 'Stop reset made the dongle disappear, which is acceptable during teardown.'
      })
      return
    }
    log('usbStopResetWarning', {
      warning: getErrorMessage(error)
    })
  }
}

const cleanupNativeRuntime = async ({ reason = 'stopSession', emitStopped = true } = {}) => {
  clearRuntimeTimers()

  const driver = carplay?.dongleDriver
  const device = activeWebUsbDevice ?? driver?._device

  if (driver) {
    driver._heartbeatInterval = null
    driver._device = null
    driver._inEP = null
    driver._outEP = null
  }

  if (device?.opened) {
    await resetDeviceForStop(device)
    await closeWebUsbDevice(device, reason)
  }

  carplay = null
  activeWebUsbDevice = null

  if (emitStopped) {
    log('sessionStopped', { reason })
  }
}

const stopSession = async () => {
  status.desiredSession = 'stopped'
  if (stopPromise) return stopPromise

  stopPromise = (async () => {
    stopping = true
    setSession('stopping')
    await cleanupNativeRuntime({ reason: 'stopSession', emitStopped: true })
    stopping = false
    setSession('idle', {
      isPlugged: false,
      deviceFound: Boolean(findDongle()),
      receivingVideo: false,
      stoppedAt: Date.now()
    })
    return status
  })().finally(() => {
    stopPromise = null
  })

  return stopPromise
}

const restartSession = async () => {
  await stopSession()
  return startSession()
}

const showCamera = (visible = true) => {
  setStatus({ cameraVisible: Boolean(visible) })
  return status
}

const reply = async (handler, callback) => {
  try {
    const result = await handler()
    callback?.({ ok: true, result })
  } catch (error) {
    const message = getErrorMessage(error)
    log('sessionError', { error: message, stack: getErrorStack(error) })
    callback?.({ ok: false, error: message })
  }
}

const registerSocketApi = () => {
  io.on('connection', (socket) => {
    socket.emit('config', config)
    socket.emit('status', status)

    socket.on('getConfig', (callback) => reply(() => config, callback))
    socket.on('setConfig', (update, callback) => reply(() => setConfig(update), callback))
    socket.on('validateConfig', (candidate, callback) => reply(() => validateConfig(candidate), callback))
    socket.on('getStatus', (callback) => reply(() => status, callback))
    socket.on('startSession', (callback) => reply(startSession, callback))
    socket.on('stopSession', (callback) => reply(stopSession, callback))
    socket.on('restartSession', (callback) => reply(restartSession, callback))
    socket.on('showCamera', (visible, callback) => reply(() => showCamera(visible), callback))
  })
}

const shutdown = async () => {
  await stopSession()
  io.close()
}

const main = async () => {
  loadDependencies()
  loadConfig()
  registerSocketApi()
  io.listen(PORT)
  io.emit('config', config)
  emitStatus()

  log('nativeRuntimeServiceListening', {
    port: PORT,
    configPath: CONFIG_PATH,
    autoStart: AUTO_START
  })

  if (AUTO_START) {
    await startSession()
  }
}

process.on('SIGINT', () => {
  shutdown().finally(() => process.exit(process.exitCode ?? 0))
})

process.on('SIGTERM', () => {
  shutdown().finally(() => process.exit(process.exitCode ?? 0))
})

main().catch((error) => {
  log('sessionError', {
    error: getErrorMessage(error),
    stack: getErrorStack(error)
  })
  process.exit(1)
})
