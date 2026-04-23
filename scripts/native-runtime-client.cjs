#!/usr/bin/env node

const { io } = require('socket.io-client')

const HOST = process.env.CARPLAY_NATIVE_HOST ?? '127.0.0.1'
const PORT = Number(process.env.CARPLAY_NATIVE_PORT ?? 4100)
const command = process.argv[2] ?? 'getStatus'
const rawArg = process.argv[3]

const parseArg = () => {
  if (rawArg == null) return undefined
  if (rawArg === 'true') return true
  if (rawArg === 'false') return false
  try {
    return JSON.parse(rawArg)
  } catch {
    return rawArg
  }
}

const socket = io(`http://${HOST}:${PORT}`, {
  reconnection: false,
  timeout: 5000
})

const finish = (payload, exitCode = 0) => {
  console.log(JSON.stringify(payload, null, 2))
  socket.close()
  process.exit(exitCode)
}

socket.on('connect', () => {
  const arg = parseArg()
  const callback = (response) => {
    finish(response, response?.ok === false ? 1 : 0)
  }

  switch (command) {
    case 'getConfig':
    case 'getStatus':
    case 'startSession':
    case 'stopSession':
    case 'restartSession':
      socket.emit(command, callback)
      break
    case 'setConfig':
    case 'validateConfig':
    case 'showCamera':
      socket.emit(command, arg, callback)
      break
    default:
      finish(
        {
          ok: false,
          error:
            'Unknown command. Use getConfig, setConfig, validateConfig, getStatus, startSession, stopSession, restartSession, or showCamera.'
        },
        1
      )
      break
  }
})

socket.on('connect_error', (error) => {
  finish(
    {
      ok: false,
      error: `Unable to connect to native runtime service at http://${HOST}:${PORT}: ${error.message}`
    },
    1
  )
})
