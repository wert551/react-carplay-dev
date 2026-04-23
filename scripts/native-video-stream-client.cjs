#!/usr/bin/env node

const fs = require('node:fs')
const net = require('node:net')

const HOST = process.env.CARPLAY_NATIVE_VIDEO_HOST ?? process.env.CARPLAY_NATIVE_HOST ?? '127.0.0.1'
const PORT = Number(process.env.CARPLAY_NATIVE_VIDEO_PORT ?? Number(process.env.CARPLAY_NATIVE_PORT ?? 4100) + 1)
const TARGET_PACKETS = Number(process.argv[2] ?? process.env.CARPLAY_NATIVE_VIDEO_TEST_PACKETS ?? 120)
const OUTPUT_PATH = process.argv[3] ?? process.env.CARPLAY_NATIVE_VIDEO_CAPTURE
const TIMEOUT_MS = Number(process.env.CARPLAY_NATIVE_VIDEO_TEST_TIMEOUT_MS ?? 10000)
const HEADER_BYTES = 20

let buffer = Buffer.alloc(0)
let packets = 0
let keyframes = 0
let configPackets = 0
let bytes = 0
let firstPts = null
let lastPts = null
let output = null
let timeout = null
let finished = false

if (OUTPUT_PATH) {
  output = fs.createWriteStream(OUTPUT_PATH)
}

const resetTimeout = (socket) => {
  if (timeout) clearTimeout(timeout)
  timeout = setTimeout(() => {
    finish(socket, 1, `Timed out after ${TIMEOUT_MS}ms waiting for video packets`)
  }, TIMEOUT_MS)
}

const finish = (socket, exitCode = 0, error = null) => {
  if (finished) return
  finished = true
  if (timeout) clearTimeout(timeout)
  output?.end()
  socket.destroy()
  console.log(
    JSON.stringify(
      {
        ok: exitCode === 0,
        error,
        host: HOST,
        port: PORT,
        packetFormat: 'CPV1',
        packets,
        keyframes,
        configPackets,
        bytes,
        firstPts: firstPts == null ? null : firstPts.toString(),
        lastPts: lastPts == null ? null : lastPts.toString(),
        capturePath: OUTPUT_PATH ?? null
      },
      null,
      2
    )
  )
  process.exit(exitCode)
}

const parsePackets = (socket) => {
  while (buffer.length >= HEADER_BYTES) {
    if (buffer.subarray(0, 4).toString('ascii') !== 'CPV1') {
      finish(socket, 1, 'Invalid packet magic')
      return
    }

    const version = buffer.readUInt16BE(4)
    if (version !== 1) {
      finish(socket, 1, `Unsupported packet version ${version}`)
      return
    }

    const flags = buffer.readUInt16BE(6)
    const pts = buffer.readBigUInt64BE(8)
    const length = buffer.readUInt32BE(16)
    if (buffer.length < HEADER_BYTES + length) return

    const payload = buffer.subarray(HEADER_BYTES, HEADER_BYTES + length)
    buffer = buffer.subarray(HEADER_BYTES + length)

    packets += 1
    if (flags & 1) keyframes += 1
    if (flags & 2) configPackets += 1
    bytes += payload.length
    if (firstPts == null) firstPts = pts
    lastPts = pts
    if (output) output.write(payload)

    if (packets >= TARGET_PACKETS) {
      finish(socket)
      return
    }
  }
}

const socket = net.createConnection({ host: HOST, port: PORT }, () => {
  resetTimeout(socket)
})

socket.on('data', (chunk) => {
  resetTimeout(socket)
  buffer = Buffer.concat([buffer, chunk])
  parsePackets(socket)
})

socket.on('error', (error) => {
  finish(socket, 1, error.message)
})

socket.on('close', () => {
  if (packets < TARGET_PACKETS) {
    finish(socket, 1, 'Socket closed before target packet count')
  }
})
