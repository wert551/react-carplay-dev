import CarplayWeb, {
  CarplayMessage,
  DongleConfig,
  SendAudio,
  SendCommand,
  SendTouch,
  findDevice
} from 'node-carplay/web'
import { Command } from '../components/worker/types'

let carplayWeb: CarplayWeb | null = null
let config: Partial<DongleConfig> | null = null

const toTransferableBuffer = (data: ArrayBufferView): ArrayBuffer => {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && data.buffer instanceof ArrayBuffer) {
    return data.buffer
  }

  if (data.buffer instanceof ArrayBuffer) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  }

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer
}

const handleMessage = (message: CarplayMessage) => {
  const { type, message: payload } = message
  if (type === 'video') {
    postMessage(message, [toTransferableBuffer(payload.data as ArrayBufferView)])
  } else if (type === 'audio' && payload.data) {
    postMessage(message, [toTransferableBuffer(payload.data)])
  } else {
    postMessage(message)
  }
}

onmessage = async (event: MessageEvent<Command>) => {
  switch (event.data.type) {
    case 'start':
      if (carplayWeb) return
      config = event.data.payload.config
      const device = await findDevice()
      if (device) {
        carplayWeb = new CarplayWeb(config)
        carplayWeb.onmessage = handleMessage
        carplayWeb.start(device)
      }
      break
    case 'touch':
      if (config && carplayWeb) {
        const { x, y, action } = event.data.payload
        const data = new SendTouch(x, y, action)
        carplayWeb.dongleDriver.send(data)
      }
      break
    case 'stop':
      await carplayWeb?.stop()
      carplayWeb = null
      break
    case 'microphoneInput':
      if (carplayWeb) {
        const data = new SendAudio(event.data.payload)
        carplayWeb.dongleDriver.send(data)
      }
      break
    case 'frame':
      if (carplayWeb) {
        const data = new SendCommand('frame')
        carplayWeb.dongleDriver.send(data)
      }
  }
}

export {}
