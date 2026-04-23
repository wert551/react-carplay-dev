#!/usr/bin/env node

const crypto = require('node:crypto')
const net = require('node:net')

const HOST = process.env.CARPLAY_NATIVE_HOST ?? '127.0.0.1'
const PORT = Number(process.env.CARPLAY_NATIVE_PORT ?? 4100)
const FILTER = process.argv[2] ?? 'all'

const matchesFilter = (payload) => {
  if (FILTER === 'all') return true
  return payload?.type === FILTER || payload?.data?.event === FILTER
}

const makeClientFrame = (opcode, payload = Buffer.alloc(0)) => {
  const length = payload.length
  const mask = crypto.randomBytes(4)
  let header

  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length])
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }

  const masked = Buffer.alloc(length)
  for (let i = 0; i < length; i += 1) {
    masked[i] = payload[i] ^ mask[i % 4]
  }

  return Buffer.concat([header, mask, masked])
}

const parseFrames = (state, onPayload) => {
  while (state.buffer.length >= 2) {
    const first = state.buffer[0]
    const second = state.buffer[1]
    const opcode = first & 0x0f
    const masked = Boolean(second & 0x80)
    let length = second & 0x7f
    let offset = 2

    if (length === 126) {
      if (state.buffer.length < offset + 2) return
      length = state.buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (state.buffer.length < offset + 8) return
      const bigLength = state.buffer.readBigUInt64BE(offset)
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('WebSocket frame too large')
      }
      length = Number(bigLength)
      offset += 8
    }

    const maskOffset = offset
    if (masked) offset += 4
    if (state.buffer.length < offset + length) return

    let payload = state.buffer.subarray(offset, offset + length)
    if (masked) {
      const mask = state.buffer.subarray(maskOffset, maskOffset + 4)
      const unmasked = Buffer.alloc(length)
      for (let i = 0; i < length; i += 1) {
        unmasked[i] = payload[i] ^ mask[i % 4]
      }
      payload = unmasked
    }

    state.buffer = state.buffer.subarray(offset + length)

    if (opcode === 0x1) {
      onPayload(payload.toString('utf8'))
    } else if (opcode === 0x8) {
      state.socket.end()
      return
    } else if (opcode === 0x9) {
      state.socket.write(makeClientFrame(0x0a, payload))
    }
  }
}

const socket = net.connect(PORT, HOST)
const key = crypto.randomBytes(16).toString('base64')
const state = {
  socket,
  buffer: Buffer.alloc(0),
  handshakeComplete: false
}

socket.on('connect', () => {
  socket.write(
    [
      'GET /events HTTP/1.1',
      `Host: ${HOST}:${PORT}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      ''
    ].join('\r\n')
  )
})

socket.on('data', (chunk) => {
  state.buffer = Buffer.concat([state.buffer, chunk])

  if (!state.handshakeComplete) {
    const headerEnd = state.buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return

    const headers = state.buffer.subarray(0, headerEnd).toString('utf8')
    if (!headers.startsWith('HTTP/1.1 101')) {
      throw new Error(`Unexpected WebSocket handshake response: ${headers.split('\r\n')[0]}`)
    }

    state.buffer = state.buffer.subarray(headerEnd + 4)
    state.handshakeComplete = true
  }

  parseFrames(state, (text) => {
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { type: 'raw', data: text }
    }

    if (matchesFilter(payload)) {
      console.log(JSON.stringify(payload, null, 2))
    }
  })
})

socket.on('error', (error) => {
  console.error(`Unable to connect to ws://${HOST}:${PORT}/events: ${error.message}`)
  process.exit(1)
})

process.on('SIGINT', () => {
  socket.write(makeClientFrame(0x8))
  socket.end()
})
