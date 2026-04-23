#!/usr/bin/env node

const http = require('node:http')

const HOST = process.env.CARPLAY_NATIVE_HOST ?? '127.0.0.1'
const PORT = Number(process.env.CARPLAY_NATIVE_PORT ?? 4100)
const command = process.argv[2] ?? 'videoStatus'
const args = process.argv.slice(3)

const requestJson = (method, path, body) =>
  new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body))
    const request = http.request(
      {
        host: HOST,
        port: PORT,
        method,
        path,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': payload.length
              }
            : {})
        },
        timeout: 5000
      },
      (response) => {
        let data = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          data += chunk
        })
        response.on('end', () => {
          let parsed = null
          try {
            parsed = data.trim() ? JSON.parse(data) : null
          } catch {
            parsed = data
          }
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            statusCode: response.statusCode,
            body: parsed
          })
        })
      }
    )

    request.on('timeout', () => {
      request.destroy(new Error(`Timed out connecting to http://${HOST}:${PORT}${path}`))
    })
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })

const usage = () => ({
  ok: false,
  error:
    'Usage: native:io videoStatus | native:io touch <down|move|up> <x> <y> | native:io key <command>'
})

const main = async () => {
  let response
  if (command === 'videoStatus') {
    response = await requestJson('GET', '/video/status')
  } else if (command === 'touch') {
    if (args.length !== 3) {
      console.log(JSON.stringify(usage(), null, 2))
      process.exit(1)
    }
    response = await requestJson('POST', '/input/touch', {
      action: args[0],
      x: Number(args[1]),
      y: Number(args[2])
    })
  } else if (command === 'key') {
    if (args.length !== 1) {
      console.log(JSON.stringify(usage(), null, 2))
      process.exit(1)
    }
    response = await requestJson('POST', '/input/key', {
      command: args[0]
    })
  } else {
    console.log(JSON.stringify(usage(), null, 2))
    process.exit(1)
  }

  console.log(JSON.stringify(response, null, 2))
  process.exit(response.ok ? 0 : 1)
}

main().catch((error) => {
  console.log(
    JSON.stringify(
      {
        ok: false,
        error: error.message
      },
      null,
      2
    )
  )
  process.exit(1)
})
