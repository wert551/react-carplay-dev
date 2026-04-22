import { io, Socket } from 'socket.io-client'
import type { ExtraConfig } from '../../../shared/config'
import type {
  CarplayStatus,
  CarplayStatusUpdate,
  RuntimeControlApi,
  RuntimeControlCommand,
  SessionAdapterEvent,
  Unsubscribe
} from '../../../shared/control'

const SOCKET_URL = 'http://localhost:4000'
const REQUEST_TIMEOUT_MS = 3000

let socket: Socket | null = null

const getElectronControl = (): RuntimeControlApi | undefined => window.carplayControl

const getSocket = (): Socket => {
  if (!socket) {
    socket = io(SOCKET_URL)
  }
  return socket
}

const socketRequest = <T>(event: string, ...payload: unknown[]): Promise<T> => {
  return new Promise((resolve, reject) => {
    const client = getSocket() as any
    client.timeout(REQUEST_TIMEOUT_MS).emit(event, ...payload, (error: Error | null, response: T) => {
      if (error) {
        reject(error)
        return
      }
      resolve(response)
    })
  })
}

const subscribeSocket = <T>(event: string, callback: (payload: T) => void): Unsubscribe => {
  const client = getSocket()
  client.on(event, callback)
  return () => {
    client.off(event, callback)
  }
}

class SocketControlClient implements RuntimeControlApi {
  getConfig(): Promise<ExtraConfig> {
    return socketRequest('getConfig')
  }

  setConfig(config: Partial<ExtraConfig>): Promise<ExtraConfig> {
    return socketRequest('setConfig', config)
  }

  validateConfig(config: Partial<ExtraConfig>): Promise<{ valid: boolean; errors: string[] }> {
    return socketRequest('validateConfig', config)
  }

  getStatus(): Promise<CarplayStatus> {
    return socketRequest('getStatus')
  }

  setStatus(status: CarplayStatusUpdate): Promise<CarplayStatus> {
    return socketRequest('setStatus', status)
  }

  startSession(): Promise<CarplayStatus> {
    return socketRequest('startSession')
  }

  stopSession(): Promise<CarplayStatus> {
    return socketRequest('stopSession')
  }

  restartSession(): Promise<CarplayStatus> {
    return socketRequest('restartSession')
  }

  showCamera(visible = true): Promise<CarplayStatus> {
    return socketRequest('showCamera', visible)
  }

  sessionAdapterReady(): Promise<CarplayStatus> {
    return socketRequest('sessionAdapterReady')
  }

  reportSessionEvent(event: SessionAdapterEvent): Promise<CarplayStatus> {
    return socketRequest('reportSessionEvent', event)
  }

  stream(stream: unknown): void {
    getSocket().emit('stream', stream)
  }

  quit(): void {
    window.api?.quit()
  }

  onConfigChanged(callback: (config: ExtraConfig) => void): Unsubscribe {
    const unsubscribeConfig = subscribeSocket<ExtraConfig>('config', callback)
    const unsubscribeSettings = subscribeSocket<ExtraConfig>('settings', callback)
    return () => {
      unsubscribeConfig()
      unsubscribeSettings()
    }
  }

  onStatusChanged(callback: (status: CarplayStatusUpdate) => void): Unsubscribe {
    const unsubscribeStatus = subscribeSocket<CarplayStatus>('status', callback)
    const unsubscribeReverse = subscribeSocket<boolean>('reverse', (reverse) => {
      callback({
        reverse
      })
    })
    return () => {
      unsubscribeStatus()
      unsubscribeReverse()
    }
  }

  onCommand(callback: (command: RuntimeControlCommand) => void): Unsubscribe {
    return subscribeSocket('controlCommand', callback)
  }
}

const socketControlClient = new SocketControlClient()

export const controlClient: RuntimeControlApi = new Proxy(socketControlClient, {
  get(target, property: string | symbol) {
    const electronControl = getElectronControl()
    const source = electronControl ?? target
    const value = source[property as keyof RuntimeControlApi]

    if (typeof value === 'function') {
      return value.bind(source)
    }

    return value
  }
})
