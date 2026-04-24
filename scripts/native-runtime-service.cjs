#!/usr/bin/env node

const fs = require('node:fs')
const crypto = require('node:crypto')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { Server } = require('socket.io')

const DONGLE_VENDOR_ID = 0x1314
const DONGLE_PRODUCT_IDS = new Set([0x1520, 0x1521])
const HOST = process.env.CARPLAY_NATIVE_HOST ?? '127.0.0.1'
const PORT = Number(process.env.CARPLAY_NATIVE_PORT ?? 4100)
const VIDEO_STREAM_HOST = process.env.CARPLAY_NATIVE_VIDEO_HOST ?? HOST
const VIDEO_STREAM_PORT = Number(process.env.CARPLAY_NATIVE_VIDEO_PORT ?? PORT + 1)
const CONFIG_PATH =
  process.env.CARPLAY_NATIVE_CONFIG ?? path.join(os.homedir(), '.config', 'react-carplay', 'config.json')
const START_RETRY_LIMIT = Number(process.env.CARPLAY_NATIVE_START_RETRIES ?? 2)
const DONGLE_REDISCOVERY_TIMEOUT_MS = Number(process.env.CARPLAY_NATIVE_REDISCOVERY_TIMEOUT_MS ?? 30000)
const DONGLE_POLL_INTERVAL_MS = Number(process.env.CARPLAY_NATIVE_POLL_INTERVAL_MS ?? 1000)
const USB_RESET_SETTLE_MS = Number(process.env.CARPLAY_NATIVE_RESET_SETTLE_MS ?? 500)
const WIFI_PAIR_DELAY_MS = Number(process.env.CARPLAY_NATIVE_WIFI_PAIR_DELAY_MS ?? 15000)
const USB_STOP_RESET_TIMEOUT_MS = Number(process.env.CARPLAY_NATIVE_STOP_RESET_TIMEOUT_MS ?? 2500)
const USB_CLOSE_TIMEOUT_MS = Number(process.env.CARPLAY_NATIVE_CLOSE_TIMEOUT_MS ?? 1000)
const USB_ACQUIRE_TIMEOUT_MS = Number(process.env.CARPLAY_NATIVE_ACQUIRE_TIMEOUT_MS ?? 15000)
const AUTO_START = process.env.CARPLAY_NATIVE_AUTOSTART === '1'
const H264_NAL_TYPES = {
  IDR: 5,
  SPS: 7,
  PPS: 8
}
const TOUCH_ACTION_NAMES = new Set(['down', 'move', 'up'])
const KEY_COMMANDS = new Set([
  'home',
  'back',
  'left',
  'right',
  'down',
  'selectDown',
  'selectUp',
  'play',
  'pause',
  'next',
  'prev',
  'frame'
])

let nativeModule = null
let usbModule = null
let NativeCarplay = null
let carplay = null
let activeWebUsbDevice = null
let config = null
let startPromise = null
let stopPromise = null
let httpServer = null
let videoStreamServer = null
let stopping = false
let videoFrameSequence = 0

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
  restartRequired: false,
  restartReason: null,
  configRevision: 0,
  appliedConfigRevision: 0,
  activeVideoConfig: null,
  pendingVideoConfig: null,
  activeResolution: null,
  pendingResolution: null,
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

const videoDiagnostics = {
  codec: 'h264',
  format: null,
  width: null,
  height: null,
  fps: null,
  totalFrames: 0,
  keyframeCount: 0,
  lastFrameAt: null,
  streamingActive: false,
  hasSps: false,
  hasPps: false,
  lastPayloadBytes: 0,
  lastNalTypes: [],
  binaryPacketsSent: 0,
  binaryBytesSent: 0,
  binaryClients: 0
}

const now = () => new Date().toISOString()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const io = new Server({
  cors: {
    origin: '*'
  }
})
const wsClients = new Set()
const videoStreamClients = new Set()

const sendWebSocketFrame = (socket, payload) => {
  if (socket.destroyed) return

  const data = Buffer.from(JSON.stringify(payload))
  let header
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length])
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }

  socket.write(Buffer.concat([header, data]))
}

const emitWebSocketEvent = (type, data) => {
  const payload = {
    type,
    timestamp: now(),
    data
  }

  for (const socket of wsClients) {
    try {
      sendWebSocketFrame(socket, payload)
    } catch {
      wsClients.delete(socket)
      socket.destroy()
    }
  }
}

const log = (event, details = {}) => {
  const payload = { timestamp: now(), event, ...details }
  console.log(JSON.stringify(payload))
  io.emit('sessionEvent', payload)
  emitWebSocketEvent('sessionEvent', payload)
  return payload
}

const emitStatus = () => {
  status.updatedAt = Date.now()
  io.emit('status', status)
  emitWebSocketEvent('status', status)
}

const emitConfig = () => {
  io.emit('config', config)
  emitWebSocketEvent('config', config)
}

const emitRuntimeMessage = (message) => {
  io.emit('runtimeMessage', message)
  emitWebSocketEvent('runtimeMessage', message)
}

const toResolutionValue = (value) => {
  if (value == null) return null
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

const getConfiguredVideoConfig = (candidate = config) => ({
  width: toResolutionValue(candidate?.width),
  height: toResolutionValue(candidate?.height),
  fps: toResolutionValue(candidate?.fps)
})

const getConfiguredResolution = (candidate = config) => ({
  width: getConfiguredVideoConfig(candidate).width,
  height: getConfiguredVideoConfig(candidate).height
})

const isSessionActive = () =>
  ['starting', 'waiting_for_dongle', 'waiting_for_phone', 'connected', 'stopping'].includes(status.session)

const hasOwn = (candidate, key) => Object.prototype.hasOwnProperty.call(candidate, key)

const getRequestHostUiCommandValue = () => {
  const mapping = nativeModule?.CommandMapping ?? nativeModule?.default?.CommandMapping
  return Number(mapping?.requestHostUI ?? 3)
}

const getCommandName = (value) => {
  const mapping = nativeModule?.CommandMapping ?? nativeModule?.default?.CommandMapping
  return mapping?.[value] ?? null
}

const isRequestHostUiCommand = (message) => {
  const value = Number(message?.value)
  return Number.isFinite(value) && value === getRequestHostUiCommandValue()
}

const emitOemExitRequested = (commandMessage) => {
  const commandValue = Number(commandMessage?.value)
  const payload = log('oemExitRequested', {
    source: 'node-carplay CommandMapping.requestHostUI',
    commandValue,
    commandName: getCommandName(commandValue) ?? 'requestHostUI',
    diagnostic: 'CarPlay OEM/My Car button requested host UI'
  })
  io.emit('oemExitRequested', payload)
  emitWebSocketEvent('oemExitRequested', payload)
}

const getVideoStreamStatus = () => ({
  binaryStreamAvailable: Boolean(videoStreamServer?.listening),
  transport: 'tcp',
  streamUrl: `tcp://${VIDEO_STREAM_HOST}:${VIDEO_STREAM_PORT}`,
  host: VIDEO_STREAM_HOST,
  port: VIDEO_STREAM_PORT,
  packetFormat: 'CPV1',
  packetHeaderBytes: 20,
  connectedClients: videoStreamClients.size,
  totalPacketsSent: videoDiagnostics.binaryPacketsSent,
  totalBytesSent: videoDiagnostics.binaryBytesSent
})

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

const toUint8Array = (value) => {
  if (value == null) return null
  if (value instanceof Uint8Array) return value
  if (Buffer.isBuffer(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return null
}

const findAnnexBStartCode = (data, offset) => {
  for (let i = offset; i <= data.length - 3; i += 1) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) return { index: i, length: 3 }
    if (i <= data.length - 4 && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      return { index: i, length: 4 }
    }
  }
  return null
}

const extractAnnexBNalus = (data) => {
  const nalus = []
  let start = findAnnexBStartCode(data, 0)
  if (!start) return null

  while (start) {
    const payloadStart = start.index + start.length
    const next = findAnnexBStartCode(data, payloadStart)
    const payloadEnd = next ? next.index : data.length
    if (payloadEnd > payloadStart) {
      nalus.push(data.subarray(payloadStart, payloadEnd))
    }
    start = next
  }

  return nalus.length > 0 ? nalus : null
}

const extractLengthPrefixedNalus = (data) => {
  for (const prefixLength of [4, 3, 2, 1]) {
    const nalus = []
    let offset = 0

    while (offset + prefixLength <= data.length) {
      let length = 0
      for (let i = 0; i < prefixLength; i += 1) {
        length = (length << 8) | data[offset + i]
      }

      offset += prefixLength
      if (length <= 0 || offset + length > data.length) {
        nalus.length = 0
        break
      }

      nalus.push(data.subarray(offset, offset + length))
      offset += length
    }

    if (nalus.length > 0 && offset === data.length) {
      return { nalus, format: `h264-length-prefixed-${prefixLength}` }
    }
  }

  return null
}

const extractH264Nalus = (data) => {
  const annexBNalus = extractAnnexBNalus(data)
  if (annexBNalus) {
    return { nalus: annexBNalus, format: 'h264-annexb' }
  }

  const lengthPrefixed = extractLengthPrefixedNalus(data)
  if (lengthPrefixed) {
    return lengthPrefixed
  }

  return { nalus: [data], format: 'h264-unknown' }
}

class BitReader {
  constructor(data) {
    this.data = data
    this.bitOffset = 0
  }

  readBit() {
    if (this.bitOffset >= this.data.length * 8) throw new Error('SPS bitstream ended early')
    const byte = this.data[this.bitOffset >> 3]
    const bit = 7 - (this.bitOffset & 7)
    this.bitOffset += 1
    return (byte >> bit) & 1
  }

  readBits(count) {
    let value = 0
    for (let i = 0; i < count; i += 1) {
      value = value * 2 + this.readBit()
    }
    return value
  }

  readUnsignedExpGolomb() {
    let zeros = 0
    while (this.readBit() === 0) {
      zeros += 1
      if (zeros > 31) throw new Error('Invalid SPS Exp-Golomb code')
    }
    return Math.pow(2, zeros) - 1 + (zeros > 0 ? this.readBits(zeros) : 0)
  }

  readSignedExpGolomb() {
    const value = this.readUnsignedExpGolomb()
    return value % 2 === 0 ? -(value / 2) : (value + 1) / 2
  }
}

const removeEmulationPreventionBytes = (data) => {
  const bytes = []
  for (let i = 0; i < data.length; i += 1) {
    if (i >= 2 && data[i] === 0x03 && data[i - 1] === 0x00 && data[i - 2] === 0x00) {
      continue
    }
    bytes.push(data[i])
  }
  return Uint8Array.from(bytes)
}

const skipHrdParameters = (reader) => {
  const cpbCount = reader.readUnsignedExpGolomb() + 1
  reader.readBits(4)
  reader.readBits(4)
  for (let i = 0; i < cpbCount; i += 1) {
    reader.readUnsignedExpGolomb()
    reader.readUnsignedExpGolomb()
    reader.readBit()
  }
  reader.readBits(5)
  reader.readBits(5)
  reader.readBits(5)
  reader.readBits(5)
}

const parseSpsInfo = (spsNalu) => {
  try {
    const rbsp = removeEmulationPreventionBytes(spsNalu.subarray(1))
    const reader = new BitReader(rbsp)
    const profileIdc = reader.readBits(8)
    reader.readBits(8)
    reader.readBits(8)
    reader.readUnsignedExpGolomb()

    let chromaFormatIdc = 1
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      chromaFormatIdc = reader.readUnsignedExpGolomb()
      if (chromaFormatIdc === 3) reader.readBit()
      reader.readUnsignedExpGolomb()
      reader.readUnsignedExpGolomb()
      reader.readBit()
      if (reader.readBit()) {
        const scalingListCount = chromaFormatIdc !== 3 ? 8 : 12
        for (let i = 0; i < scalingListCount; i += 1) {
          if (reader.readBit()) {
            let lastScale = 8
            let nextScale = 8
            const size = i < 6 ? 16 : 64
            for (let j = 0; j < size; j += 1) {
              if (nextScale !== 0) {
                nextScale = (lastScale + reader.readSignedExpGolomb() + 256) % 256
              }
              lastScale = nextScale === 0 ? lastScale : nextScale
            }
          }
        }
      }
    }

    reader.readUnsignedExpGolomb()
    const picOrderCntType = reader.readUnsignedExpGolomb()
    if (picOrderCntType === 0) {
      reader.readUnsignedExpGolomb()
    } else if (picOrderCntType === 1) {
      reader.readBit()
      reader.readSignedExpGolomb()
      reader.readSignedExpGolomb()
      const offsets = reader.readUnsignedExpGolomb()
      for (let i = 0; i < offsets; i += 1) {
        reader.readSignedExpGolomb()
      }
    }

    reader.readUnsignedExpGolomb()
    reader.readBit()
    const picWidthInMbsMinus1 = reader.readUnsignedExpGolomb()
    const picHeightInMapUnitsMinus1 = reader.readUnsignedExpGolomb()
    const frameMbsOnlyFlag = reader.readBit()
    if (!frameMbsOnlyFlag) reader.readBit()
    reader.readBit()

    let frameCropLeftOffset = 0
    let frameCropRightOffset = 0
    let frameCropTopOffset = 0
    let frameCropBottomOffset = 0
    if (reader.readBit()) {
      frameCropLeftOffset = reader.readUnsignedExpGolomb()
      frameCropRightOffset = reader.readUnsignedExpGolomb()
      frameCropTopOffset = reader.readUnsignedExpGolomb()
      frameCropBottomOffset = reader.readUnsignedExpGolomb()
    }

    const subWidthC = chromaFormatIdc === 0 || chromaFormatIdc === 3 ? 1 : 2
    const subHeightC = chromaFormatIdc === 1 ? 2 : 1
    const cropUnitX = chromaFormatIdc === 0 ? 1 : subWidthC
    const cropUnitY = chromaFormatIdc === 0 ? 2 - frameMbsOnlyFlag : subHeightC * (2 - frameMbsOnlyFlag)
    const width =
      (picWidthInMbsMinus1 + 1) * 16 - (frameCropLeftOffset + frameCropRightOffset) * cropUnitX
    const height =
      (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 -
      (frameCropTopOffset + frameCropBottomOffset) * cropUnitY

    let fps = null
    if (reader.readBit()) {
      if (reader.readBit()) {
        const aspectRatioIdc = reader.readBits(8)
        if (aspectRatioIdc === 255) {
          reader.readBits(16)
          reader.readBits(16)
        }
      }
      if (reader.readBit()) reader.readBit()
      if (reader.readBit()) {
        reader.readBits(3)
        reader.readBit()
        if (reader.readBit()) {
          reader.readBits(8)
          reader.readBits(8)
          reader.readBits(8)
        }
      }
      if (reader.readBit()) {
        reader.readUnsignedExpGolomb()
        reader.readUnsignedExpGolomb()
      }
      if (reader.readBit()) {
        const numUnitsInTick = reader.readBits(32)
        const timeScale = reader.readBits(32)
        reader.readBit()
        if (numUnitsInTick > 0 && timeScale > 0) {
          fps = timeScale / (2 * numUnitsInTick)
        }
      }
      if (reader.readBit()) skipHrdParameters(reader)
      if (reader.readBit()) skipHrdParameters(reader)
    }

    return { width, height, fps }
  } catch (error) {
    log('runtimeMessage', {
      type: 'videoDiagnosticsWarning',
      warning: getErrorMessage(error)
    })
    return null
  }
}

const resetVideoDiagnostics = () => {
  Object.assign(videoDiagnostics, {
    format: null,
    width: null,
    height: null,
    fps: null,
    totalFrames: 0,
    keyframeCount: 0,
    lastFrameAt: null,
    streamingActive: false,
    hasSps: false,
    hasPps: false,
    lastPayloadBytes: 0,
    lastNalTypes: [],
    binaryPacketsSent: videoDiagnostics.binaryPacketsSent,
    binaryBytesSent: videoDiagnostics.binaryBytesSent,
    binaryClients: videoStreamClients.size
  })
}

const getVideoStatus = () => ({
  available: videoDiagnostics.totalFrames > 0,
  codec: videoDiagnostics.codec,
  format: videoDiagnostics.format,
  width: videoDiagnostics.width,
  height: videoDiagnostics.height,
  fps: videoDiagnostics.fps,
  totalFrames: videoDiagnostics.totalFrames,
  keyframeCount: videoDiagnostics.keyframeCount,
  lastFrameAt: videoDiagnostics.lastFrameAt,
  streamingActive: status.receivingVideo && status.session === 'connected',
  hasSps: videoDiagnostics.hasSps,
  hasPps: videoDiagnostics.hasPps,
  lastPayloadBytes: videoDiagnostics.lastPayloadBytes,
  lastNalTypes: videoDiagnostics.lastNalTypes,
  ...getVideoStreamStatus()
})

const updateVideoDiagnostics = (message) => {
  const data = toUint8Array(message?.data)
  const observedAt = Date.now()

  videoDiagnostics.totalFrames += 1
  videoDiagnostics.lastFrameAt = observedAt
  videoDiagnostics.streamingActive = true

  if (!data) {
    videoDiagnostics.lastPayloadBytes = 0
    return null
  }

  videoDiagnostics.lastPayloadBytes = data.byteLength
  const { nalus, format } = extractH264Nalus(data)
  videoDiagnostics.format = format
  const nalTypes = []

  for (const nalu of nalus) {
    if (nalu.byteLength === 0) continue
    const nalType = nalu[0] & 0x1f
    nalTypes.push(nalType)

    if (nalType === H264_NAL_TYPES.IDR) {
      videoDiagnostics.keyframeCount += 1
    } else if (nalType === H264_NAL_TYPES.SPS) {
      videoDiagnostics.hasSps = true
      const info = parseSpsInfo(nalu)
      if (info) {
        videoDiagnostics.width = info.width
        videoDiagnostics.height = info.height
        if (info.fps) videoDiagnostics.fps = info.fps
      }
    } else if (nalType === H264_NAL_TYPES.PPS) {
      videoDiagnostics.hasPps = true
    }
  }

  videoDiagnostics.lastNalTypes = nalTypes.slice(0, 12)
  return {
    data,
    nalTypes,
    hasKeyframe: nalTypes.includes(H264_NAL_TYPES.IDR),
    hasConfig: nalTypes.includes(H264_NAL_TYPES.SPS) || nalTypes.includes(H264_NAL_TYPES.PPS),
    observedAt
  }
}

const writeVideoPacket = (socket, payload, flags, pts) => {
  const header = Buffer.alloc(20)
  header.write('CPV1', 0, 4, 'ascii')
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(flags, 6)
  header.writeBigUInt64BE(pts, 8)
  header.writeUInt32BE(payload.byteLength, 16)
  socket.write(Buffer.concat([header, payload]))
}

const broadcastVideoAccessUnit = (videoInfo) => {
  if (!videoInfo?.data || videoStreamClients.size === 0) return

  const payload = Buffer.from(videoInfo.data.buffer, videoInfo.data.byteOffset, videoInfo.data.byteLength)
  const flags = (videoInfo.hasKeyframe ? 1 : 0) | (videoInfo.hasConfig ? 2 : 0)
  const pts = process.hrtime.bigint() / 1000n
  videoFrameSequence += 1

  for (const socket of videoStreamClients) {
    try {
      writeVideoPacket(socket, payload, flags, pts)
    } catch (error) {
      log('runtimeMessage', {
        type: 'videoStreamWriteError',
        error: getErrorMessage(error)
      })
      videoStreamClients.delete(socket)
      socket.destroy()
    }
  }

  videoDiagnostics.binaryPacketsSent += 1
  videoDiagnostics.binaryBytesSent += payload.byteLength
  videoDiagnostics.binaryClients = videoStreamClients.size
}

const startVideoStreamServer = () => {
  videoStreamServer = net.createServer((socket) => {
    socket.setNoDelay(true)
    videoStreamClients.add(socket)
    videoDiagnostics.binaryClients = videoStreamClients.size
    log('videoStreamClientConnected', {
      clients: videoStreamClients.size,
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort
    })

    socket.on('close', () => {
      videoStreamClients.delete(socket)
      videoDiagnostics.binaryClients = videoStreamClients.size
      log('videoStreamClientDisconnected', {
        clients: videoStreamClients.size
      })
    })
    socket.on('error', (error) => {
      videoStreamClients.delete(socket)
      videoDiagnostics.binaryClients = videoStreamClients.size
      log('videoStreamClientError', {
        error: getErrorMessage(error)
      })
    })
  })

  videoStreamServer.on('error', (error) => {
    log('sessionError', {
      source: 'videoStream',
      error: getErrorMessage(error),
      diagnostic: `Unable to listen on ${VIDEO_STREAM_HOST}:${VIDEO_STREAM_PORT}`
    })
  })

  videoStreamServer.listen(VIDEO_STREAM_PORT, VIDEO_STREAM_HOST, () => {
    log('videoStreamListening', getVideoStreamStatus())
  })
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
    host: HOST,
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
  status.pendingVideoConfig = getConfiguredVideoConfig(config)
  status.pendingResolution = getConfiguredResolution(config)
  persistConfig()
  return config
}

const persistConfig = () => {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)
}

const validateDimension = (name, value) => {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    return `${name} must be a positive integer`
  }
  return null
}

const validateConfig = (candidate) => {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { valid: false, errors: ['config must be an object'] }
  }

  const errors = []
  if (hasOwn(candidate, 'width')) {
    const error = validateDimension('width', candidate.width)
    if (error) errors.push(error)
  }
  if (hasOwn(candidate, 'height')) {
    const error = validateDimension('height', candidate.height)
    if (error) errors.push(error)
  }
  if (hasOwn(candidate, 'fps')) {
    const error = validateDimension('fps', candidate.fps)
    if (error) errors.push(error)
  }

  return { valid: errors.length === 0, errors }
}

const normalizeConfigUpdate = (candidate) => {
  const update = { ...candidate }
  if (hasOwn(update, 'width')) {
    update.width = Number(update.width)
  }
  if (hasOwn(update, 'height')) {
    update.height = Number(update.height)
  }
  if (hasOwn(update, 'fps')) {
    update.fps = Number(update.fps)
  }
  return update
}

const setConfig = (update) => {
  const validation = validateConfig(update)
  if (!validation.valid) {
    throw new Error(validation.errors.join(', '))
  }
  const normalizedUpdate = normalizeConfigUpdate(update)
  const previousVideoConfig = getConfiguredVideoConfig(config)
  const previousResolution = getConfiguredResolution(config)
  config = {
    ...config,
    ...normalizedUpdate
  }
  const nextVideoConfig = getConfiguredVideoConfig(config)
  const nextResolution = getConfiguredResolution(config)
  const resolutionChanged =
    (hasOwn(normalizedUpdate, 'width') || hasOwn(normalizedUpdate, 'height')) &&
    (previousResolution.width !== nextResolution.width || previousResolution.height !== nextResolution.height)
  const fpsChanged = hasOwn(normalizedUpdate, 'fps') && previousVideoConfig.fps !== nextVideoConfig.fps

  status.configRevision += 1
  status.pendingVideoConfig = nextVideoConfig
  status.pendingResolution = nextResolution

  if ((resolutionChanged || fpsChanged) && isSessionActive()) {
    status.restartRequired = true
    status.restartReason = resolutionChanged && fpsChanged ? 'videoConfigChanged' : resolutionChanged ? 'resolutionChanged' : 'fpsChanged'
    log('configUpdated', {
      width: nextVideoConfig.width,
      height: nextVideoConfig.height,
      fps: nextVideoConfig.fps,
      restartRequired: true,
      diagnostic:
        'Width, height, and fps changes are applied on the next start/restart, not to the already-running session.'
    })
  } else {
    log('configUpdated', {
      width: nextVideoConfig.width,
      height: nextVideoConfig.height,
      fps: nextVideoConfig.fps,
      restartRequired: false
    })
  }

  persistConfig()
  emitConfig()
  emitStatus()
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
  const resetDevice = await requestWebUsbDongle({ timeoutMs: USB_ACQUIRE_TIMEOUT_MS })
  if (!resetDevice) {
    throw new Error(
      `Dongle was discovered but usb.webusb.requestDevice() did not return a device within ${USB_ACQUIRE_TIMEOUT_MS}ms`
    )
  }

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
        broadcastVideoAccessUnit(updateVideoDiagnostics(message?.message))
        setStatus({ receivingVideo: true })
        emitRuntimeMessage({ type, message: summarize(message?.message) })
        break
      case 'audio':
      case 'media':
        emitRuntimeMessage({ type, message: summarize(message?.message) })
        log('runtimeMessage', {
          type,
          message: summarize(message?.message)
        })
        break
      case 'command':
        if (isRequestHostUiCommand(message?.message)) {
          emitOemExitRequested(message.message)
        }
        emitRuntimeMessage({ type, message: summarize(message?.message) })
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
        emitRuntimeMessage({ type, message: summarize(message) })
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
  setStatus({
    appliedConfigRevision: status.configRevision,
    activeVideoConfig: getConfiguredVideoConfig(runtimeConfig),
    pendingVideoConfig: getConfiguredVideoConfig(config),
    activeResolution: getConfiguredResolution(runtimeConfig),
    pendingResolution: getConfiguredResolution(config),
    restartRequired: false,
    restartReason: null
  })
  log('runtimeConfigApplied', {
    configRevision: status.configRevision,
    ...getConfiguredVideoConfig(runtimeConfig)
  })
  scheduleWifiPair(runtimeConfig)

  if (!stopping && status.session !== 'connected' && status.session !== 'error') {
    log('waitingForPhone')
    setSession('waiting_for_phone', {
      deviceFound: true
    })
  }
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
      receivingVideo: false,
      pendingVideoConfig: getConfiguredVideoConfig(config),
      pendingResolution: getConfiguredResolution(config)
    })
    resetVideoDiagnostics()

    for (let attempt = 0; attempt <= START_RETRY_LIMIT && !stopping; attempt += 1) {
      if (attempt > 0) {
        log('startRetried', { attempt, maxRetries: START_RETRY_LIMIT })
      }

      try {
        await waitForDongle()
        if (stopping) return status
        setSession('starting', {
          deviceFound: true
        })
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
      stoppedAt: Date.now(),
      activeVideoConfig: null,
      pendingVideoConfig: getConfiguredVideoConfig(config),
      activeResolution: null
    })
    resetVideoDiagnostics()
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

const getNativeExport = (...names) => {
  for (const name of names) {
    const candidate = nativeModule?.[name] ?? nativeModule?.default?.[name]
    if (candidate != null) return candidate
  }
  return null
}

const assertInputRuntimeReady = () => {
  if (!carplay?.dongleDriver || typeof carplay.dongleDriver.send !== 'function') {
    throw new Error('CarPlay runtime is not active')
  }
  if (status.session !== 'connected') {
    throw new Error(`CarPlay input is only accepted while session is connected; current session is ${status.session}`)
  }
}

const resolveTouchAction = (actionName) => {
  const actionKey = typeof actionName === 'string' ? actionName.toLowerCase() : ''
  if (!TOUCH_ACTION_NAMES.has(actionKey)) {
    throw new Error('touch action must be one of: down, move, up')
  }

  const touchAction =
    getNativeExport('TouchAction', 'TouchActions', 'touchAction') ??
    nativeModule?.SendTouch?.TouchAction ??
    nativeModule?.SendTouch?.TouchActions
  if (!touchAction || typeof touchAction !== 'object') {
    throw new Error('node-carplay/node does not expose TouchAction')
  }

  const aliases = {
    down: ['Down', 'DOWN', 'down'],
    move: ['Move', 'MOVE', 'move'],
    up: ['Up', 'UP', 'up']
  }
  for (const alias of aliases[actionKey]) {
    if (touchAction[alias] != null) return touchAction[alias]
  }

  throw new Error(`node-carplay/node TouchAction does not expose ${actionKey}`)
}

const sendTouchInput = (body) => {
  assertInputRuntimeReady()
  const SendTouch = getNativeExport('SendTouch')
  if (typeof SendTouch !== 'function') {
    throw new Error('node-carplay/node does not expose SendTouch')
  }

  const x = Number(body.x)
  const y = Number(body.y)
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new Error('touch x and y must be finite normalized values from 0.0 to 1.0')
  }

  const action = String(body.action ?? '').toLowerCase()
  const touchAction = resolveTouchAction(action)
  carplay.dongleDriver.send(new SendTouch(x, y, touchAction))
  return {
    ok: true,
    type: 'touch',
    action,
    x,
    y,
    session: status.session
  }
}

const sendKeyInput = (body) => {
  assertInputRuntimeReady()
  const SendCommand = getNativeExport('SendCommand')
  if (typeof SendCommand !== 'function') {
    throw new Error('node-carplay/node does not expose SendCommand')
  }

  const command = String(body.command ?? '')
  if (!KEY_COMMANDS.has(command)) {
    throw new Error(
      `key command must be one of: ${Array.from(KEY_COMMANDS).join(', ')}`
    )
  }

  carplay.dongleDriver.send(new SendCommand(command))
  return {
    ok: true,
    type: 'key',
    command,
    session: status.session
  }
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

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': 'http://127.0.0.1',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  response.end(`${JSON.stringify(payload, null, 2)}\n`)
}

const readJsonBody = (request) =>
  new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'))
        request.destroy()
      }
    })
    request.on('end', () => {
      if (!body.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${getErrorMessage(error)}`))
      }
    })
    request.on('error', reject)
  })

const handleHttpOperation = async (response, handler) => {
  try {
    const result = await handler()
    sendJson(response, 200, result)
  } catch (error) {
    const message = getErrorMessage(error)
    log('sessionError', { error: message, stack: getErrorStack(error), source: 'http' })
    sendJson(response, 400, { error: message })
  }
}

const handleHttpRequest = async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${HOST}:${PORT}`}`)
  const method = request.method ?? 'GET'

  if (method === 'OPTIONS') {
    sendJson(response, 204, {})
    return
  }

  if (method === 'GET' && url.pathname === '/status') {
    sendJson(response, 200, status)
    return
  }

  if (method === 'GET' && url.pathname === '/config') {
    sendJson(response, 200, config)
    return
  }

  if (method === 'GET' && url.pathname === '/video/status') {
    sendJson(response, 200, getVideoStatus())
    return
  }

  if (method === 'POST' && url.pathname === '/start') {
    await handleHttpOperation(response, startSession)
    return
  }

  if (method === 'POST' && url.pathname === '/stop') {
    await handleHttpOperation(response, stopSession)
    return
  }

  if (method === 'POST' && url.pathname === '/restart') {
    await handleHttpOperation(response, restartSession)
    return
  }

  if (method === 'POST' && url.pathname === '/camera') {
    await handleHttpOperation(response, async () => {
      const body = await readJsonBody(request)
      return showCamera(body.visible)
    })
    return
  }

  if (method === 'POST' && url.pathname === '/input/touch') {
    await handleHttpOperation(response, async () => {
      const body = await readJsonBody(request)
      return sendTouchInput(body)
    })
    return
  }

  if (method === 'POST' && url.pathname === '/input/key') {
    await handleHttpOperation(response, async () => {
      const body = await readJsonBody(request)
      return sendKeyInput(body)
    })
    return
  }

  if (method === 'POST' && url.pathname === '/config') {
    await handleHttpOperation(response, async () => {
      const body = await readJsonBody(request)
      return setConfig(body)
    })
    return
  }

  sendJson(response, 404, {
    error: 'Not found',
    endpoints: [
      'GET /status',
      'GET /config',
      'GET /video/status',
      'POST /start',
      'POST /stop',
      'POST /restart',
      'POST /camera',
      'POST /input/touch',
      'POST /input/key',
      'POST /config'
    ]
  })
}

const acceptWebSocket = (request, socket) => {
  const key = request.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return
  }

  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      ''
    ].join('\r\n')
  )

  wsClients.add(socket)
  socket.on('close', () => wsClients.delete(socket))
  socket.on('error', () => {
    wsClients.delete(socket)
    socket.destroy()
  })
  socket.on('data', (buffer) => {
    const opcode = buffer[0] & 0x0f
    if (opcode === 0x8) {
      wsClients.delete(socket)
      socket.end()
    } else if (opcode === 0x9) {
      socket.write(Buffer.from([0x8a, 0x00]))
    }
  })

  sendWebSocketFrame(socket, {
    type: 'hello',
    timestamp: now(),
    data: {
      status,
      config
    }
  })
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
  for (const socket of wsClients) {
    socket.end()
  }
  wsClients.clear()
  for (const socket of videoStreamClients) {
    socket.end()
  }
  videoStreamClients.clear()
  io.close()
  httpServer?.close()
  videoStreamServer?.close()
}

const main = async () => {
  loadDependencies()
  loadConfig()
  registerSocketApi()
  httpServer = http.createServer(handleHttpRequest)
  httpServer.on('upgrade', (request, socket) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${HOST}:${PORT}`}`)
    if (url.pathname === '/events') {
      acceptWebSocket(request, socket)
    }
  })
  io.attach(httpServer)
  httpServer.listen(PORT, HOST)
  startVideoStreamServer()
  emitConfig()
  emitStatus()

  log('nativeRuntimeServiceListening', {
    host: HOST,
    port: PORT,
    httpBaseUrl: `http://${HOST}:${PORT}`,
    webSocketUrl: `ws://${HOST}:${PORT}/events`,
    socketIoUrl: `http://${HOST}:${PORT}`,
    videoStreamUrl: `tcp://${VIDEO_STREAM_HOST}:${VIDEO_STREAM_PORT}`,
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
