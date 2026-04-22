import { Server } from 'socket.io'
import { EventEmitter } from 'events'
import { Stream } from "socketmost/dist/modules/Messages";
import { RuntimeControl } from './RuntimeControl'
import { ExtraConfig } from '../shared/config'
import { CarplayStatus, CarplayStatusUpdate, RuntimeControlCommand, SessionAdapterEvent } from '../shared/control'

export enum MessageNames {
  Connection = 'connection',
  GetConfig = 'getConfig',
  SetConfig = 'setConfig',
  ValidateConfig = 'validateConfig',
  GetSettings = 'getSettings',
  SaveSettings = 'saveSettings',
  Config = 'config',
  Settings = 'settings',
  GetStatus = 'getStatus',
  SetStatus = 'setStatus',
  Status = 'status',
  StartSession = 'startSession',
  StopSession = 'stopSession',
  RestartSession = 'restartSession',
  ShowCamera = 'showCamera',
  SessionAdapterReady = 'sessionAdapterReady',
  ReportSessionEvent = 'reportSessionEvent',
  ControlCommand = 'controlCommand',
  Stream = 'stream'
}

export class Socket extends EventEmitter {
  io: Server
  control: RuntimeControl

  constructor(control: RuntimeControl) {
    super()
    this.control = control
    this.io = new Server({
      cors: {
        origin: '*'
      }
    })

    this.control.on('configChanged', (config: ExtraConfig) => {
      this.sendSettings(config)
    })
    this.control.on('statusChanged', (status: CarplayStatus) => {
      this.sendStatus(status)
    })
    this.control.on('command', (command: RuntimeControlCommand) => {
      this.io.emit(MessageNames.ControlCommand, command)
    })

    this.io.on(MessageNames.Connection, (socket) => {
      this.sendSettings()
      this.sendStatus()

      socket.on(MessageNames.GetConfig, (reply?: (config: ExtraConfig) => void) => {
        reply?.(this.control.getConfig())
        this.sendSettings()
      })
      socket.on(MessageNames.GetSettings, () => {
        this.sendSettings()
      })

      socket.on(MessageNames.SetConfig, (settings: Partial<ExtraConfig>, reply?: (config: ExtraConfig) => void) => {
        reply?.(this.control.setConfig(settings))
      })
      socket.on(MessageNames.ValidateConfig, (settings: Partial<ExtraConfig>, reply?: (result: { valid: boolean; errors: string[] }) => void) => {
        reply?.(this.control.validateConfig(settings))
      })
      socket.on(MessageNames.SaveSettings, (settings: ExtraConfig) => {
        this.control.setConfig(settings)
      })

      socket.on(MessageNames.GetStatus, (reply?: (status: CarplayStatus) => void) => {
        reply?.(this.control.getStatus())
        this.sendStatus()
      })

      socket.on(MessageNames.SetStatus, (status: CarplayStatusUpdate, reply?: (status: CarplayStatus) => void) => {
        reply?.(this.control.setStatus(status))
      })

      socket.on(MessageNames.StartSession, (reply?: (status: CarplayStatus) => void) => {
        reply?.(this.control.startSession())
      })

      socket.on(MessageNames.StopSession, (reply?: (status: CarplayStatus) => void) => {
        reply?.(this.control.stopSession())
      })

      socket.on(MessageNames.RestartSession, (reply?: (status: CarplayStatus) => void) => {
        reply?.(this.control.restartSession())
      })

      socket.on(MessageNames.ShowCamera, (visible?: boolean, reply?: (status: CarplayStatus) => void) => {
        reply?.(this.control.showCamera(visible))
      })

      socket.on(MessageNames.SessionAdapterReady, (reply?: (status: CarplayStatus) => void) => {
        reply?.(this.control.sessionAdapterReady())
      })

      socket.on(MessageNames.ReportSessionEvent, (event: SessionAdapterEvent, reply?: (status: CarplayStatus) => void) => {
        reply?.(this.control.reportSessionEvent(event))
      })

      socket.on(MessageNames.Stream, (stream: Stream) => {
        this.control.stream(stream)
      })
    })

    this.io.listen(4000)
  }

  sendSettings(config: ExtraConfig = this.control.getConfig()) {
    this.io.emit(MessageNames.Config, config)
    this.io.emit(MessageNames.Settings, config)
  }

  sendStatus(status: CarplayStatus = this.control.getStatus()) {
    this.io.emit(MessageNames.Status, status)
  }

  sendReverse(reverse: boolean) {
    this.control.setStatus({ reverse, cameraVisible: reverse })
    this.io.emit('reverse', reverse)
  }

  sendLights(lights: boolean) {
    this.control.setStatus({ lights })
    this.io.emit('lights', lights)
  }
}
