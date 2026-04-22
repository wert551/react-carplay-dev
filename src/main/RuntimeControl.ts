import { EventEmitter } from 'events'
import type { WebContents } from 'electron'
import type { Stream } from 'socketmost/dist/modules/Messages'
import { ConfigStore } from './ConfigStore'
import type { ExtraConfig } from '../shared/config'
import {
  CONTROL_CHANNELS,
  DEFAULT_STATUS
} from '../shared/control'
import type {
  CarplayStatus,
  CarplayStatusUpdate,
  RuntimeControlCommand,
  SessionAdapterEvent
} from '../shared/control'
import { logSessionEvent } from '../shared/sessionLog'

export class RuntimeControl extends EventEmitter {
  private status: CarplayStatus = {
    ...DEFAULT_STATUS,
    pendingCommands: [],
    activeCommands: [],
    metadata: { ...DEFAULT_STATUS.metadata }
  }
  private renderer: WebContents | null = null
  private commandCounter = 0

  constructor(private readonly configStore: ConfigStore) {
    super()
    const config = this.configStore.getConfig()
    this.status.desiredSession = config.startMode === 'auto' ? 'running' : 'stopped'
    logSessionEvent('runtime', 'runtime.initialized', {
      startMode: config.startMode,
      shellMode: config.shellMode,
      runtimeEngine: config.runtimeEngine,
      desiredSession: this.status.desiredSession
    })
    this.status.metadata.runtimeEngine = config.runtimeEngine
    this.configStore.on('configChanged', (config: ExtraConfig) => {
      logSessionEvent('runtime', 'runtime.config_changed', {
        startMode: config.startMode,
        shellMode: config.shellMode,
        runtimeEngine: config.runtimeEngine,
        showDebugSettings: config.showDebugSettings
      })
      this.applyStartupMode(config)
      this.sendToRenderer(CONTROL_CHANNELS.configChanged, config)
      this.emit('configChanged', config)
    })
  }

  attachRenderer(renderer: WebContents): void {
    this.renderer = renderer
    logSessionEvent('runtime', 'runtime.renderer_attached')
    renderer.once('destroyed', () => {
      if (this.renderer === renderer) {
        this.renderer = null
        const config = this.configStore.getConfig()
        logSessionEvent('runtime', 'runtime.renderer_destroyed', {
          runtimeEngine: config.runtimeEngine,
          desiredSession: this.status.desiredSession,
          pendingCommands: this.status.pendingCommands.length,
          activeCommands: this.status.activeCommands.length
        })
        if (config.runtimeEngine === 'browser-webusb') {
          this.setStatus({
            rendererReady: false,
            session: 'idle',
            deviceFound: false,
            isPlugged: false,
            receivingVideo: false,
            activeCommands: []
          })
        }
      }
    })
  }

  getConfig(): ExtraConfig {
    return this.configStore.getConfig()
  }

  setConfig(config: Partial<ExtraConfig>): ExtraConfig {
    return this.configStore.setConfig(config)
  }

  validateConfig(config: Partial<ExtraConfig>): { valid: boolean; errors: string[] } {
    const { valid, errors } = this.configStore.validate(config)
    return { valid, errors }
  }

  getStatus(): CarplayStatus {
    return this.status
  }

  setStatus(update: CarplayStatusUpdate): CarplayStatus {
    this.status = {
      ...this.status,
      ...update,
      metadata: {
        ...this.status.metadata,
        ...(update.metadata ?? {})
      },
      pendingCommands: update.pendingCommands ?? this.status.pendingCommands,
      activeCommands: update.activeCommands ?? this.status.activeCommands
    }
    logSessionEvent('runtime', 'runtime.status_changed', {
      session: this.status.session,
      desiredSession: this.status.desiredSession,
      rendererReady: this.status.rendererReady,
      pendingCommands: this.status.pendingCommands.length,
      activeCommands: this.status.activeCommands.length,
      lastError: this.status.lastError
    })
    this.sendToRenderer(CONTROL_CHANNELS.statusChanged, this.status)
    this.emit('statusChanged', this.status)
    return this.status
  }

  startSession(): CarplayStatus {
    this.setStatus({
      desiredSession: 'running',
      session: 'starting',
      lastError: null
    })
    this.queueCommand(this.createCommand('startSession'))
    return this.status
  }

  stopSession(): CarplayStatus {
    this.setStatus({
      desiredSession: 'stopped',
      session: 'stopping'
    })
    this.queueCommand(this.createCommand('stopSession'))
    return this.status
  }

  restartSession(): CarplayStatus {
    this.setStatus({
      desiredSession: 'running',
      session: 'starting',
      lastError: null
    })
    this.queueCommand(this.createCommand('restartSession'))
    return this.status
  }

  showCamera(visible = true): CarplayStatus {
    this.setStatus({ cameraVisible: visible, reverse: visible })
    this.queueCommand(this.createCommand('showCamera', { visible }))
    return this.status
  }

  sessionAdapterReady(): CarplayStatus {
    const config = this.configStore.getConfig()
    logSessionEvent('runtime', 'runtime.adapter_ready', {
      startMode: config.startMode,
      desiredSession: this.status.desiredSession,
      session: this.status.session,
      pendingCommands: this.status.pendingCommands.length
    })
    this.setStatus({
      rendererReady: true,
      metadata: {
        adapterReadyAt: Date.now(),
        runtimeEngine: config.runtimeEngine
      }
    })

    if (config.runtimeEngine === 'external') {
      logSessionEvent('runtime', 'runtime.external_engine_selected', {
        desiredSession: this.status.desiredSession,
        pendingCommands: this.status.pendingCommands.length
      })
    }

    if (
      this.status.desiredSession === 'running' &&
      this.status.session === 'idle' &&
      this.status.pendingCommands.length === 0
    ) {
      this.startSession()
    } else {
      this.flushPendingCommands()
    }

    return this.status
  }

  reportSessionEvent(event: SessionAdapterEvent): CarplayStatus {
    const timestamp = event.timestamp ?? Date.now()
    logSessionEvent('runtime', 'runtime.adapter_event', { event })

    switch (event.type) {
      case 'adapterReady':
        return this.sessionAdapterReady()
      case 'commandAccepted':
        return this.setStatus({
          activeCommands: this.status.activeCommands.filter((command) => command.commandId !== event.commandId),
          metadata: {
            lastCommandId: event.commandId,
            lastEventAt: timestamp,
            lastAcceptedCommandId: event.commandId
          }
        })
      case 'commandRejected':
        return this.setStatus({
          session: 'error',
          lastError: event.error,
          activeCommands: this.status.activeCommands.filter((command) => command.commandId !== event.commandId),
          metadata: {
            lastCommandId: event.commandId,
            lastEventAt: timestamp,
            lastRejectedCommandId: event.commandId
          }
        })
      case 'waitingForDongle':
        if (this.shouldIgnoreStartProgress(event.type)) return this.status
        return this.setStatus({
          session: 'waiting_for_dongle',
          deviceFound: false,
          isPlugged: false,
          receivingVideo: false,
          lastError: null,
          metadata: {
            lastEventAt: timestamp
          }
        })
      case 'dongleFound':
        if (this.shouldIgnoreStartProgress(event.type)) return this.status
        return this.setStatus({
          session: 'waiting_for_phone',
          deviceFound: true,
          receivingVideo: true,
          lastError: null,
          metadata: {
            lastEventAt: timestamp
          }
        })
      case 'waitingForPhone':
        if (this.shouldIgnoreStartProgress(event.type)) return this.status
        return this.setStatus({
          session: 'waiting_for_phone',
          deviceFound: true,
          lastError: null,
          metadata: {
            lastEventAt: timestamp
          }
        })
      case 'phoneConnected':
        if (this.shouldIgnoreStartProgress(event.type)) return this.status
        return this.setStatus({
          session: 'connected',
          deviceFound: true,
          isPlugged: true,
          receivingVideo: true,
          lastError: null,
          metadata: {
            lastEventAt: timestamp
          }
        })
      case 'phoneDisconnected':
        return this.setStatus({
          session: this.status.desiredSession === 'running' ? 'waiting_for_phone' : 'idle',
          isPlugged: false,
          metadata: {
            lastEventAt: timestamp
          }
        })
      case 'sessionStopped':
        return this.setStatus({
          session: 'idle',
          deviceFound: false,
          isPlugged: false,
          receivingVideo: false,
          metadata: {
            lastEventAt: timestamp
          }
        })
      case 'sessionError':
        return this.setStatus({
          session: 'error',
          lastError: event.error,
          metadata: {
            lastEventAt: timestamp
          }
        })
      case 'cameraVisibilityChanged':
        return this.setStatus({
          cameraVisible: event.visible,
          reverse: event.visible,
          metadata: {
            lastEventAt: timestamp
          }
        })
    }
  }

  stream(stream: Stream): void {
    this.emit('stream', stream)
  }

  private createCommand(
    type: 'startSession' | 'stopSession' | 'restartSession',
    payload?: never
  ): RuntimeControlCommand
  private createCommand(type: 'showCamera', payload: { visible: boolean }): RuntimeControlCommand
  private createCommand(
    type: RuntimeControlCommand['type'],
    payload: { visible?: boolean } = {}
  ): RuntimeControlCommand {
    this.commandCounter += 1
    const baseCommand = {
      commandId: `session-${Date.now()}-${this.commandCounter}`,
      requestedAt: Date.now()
    }

    if (type === 'showCamera') {
      return {
        ...baseCommand,
        type,
        visible: payload.visible ?? true
      }
    }

    return {
      ...baseCommand,
      type
    }
  }

  private queueCommand(command: RuntimeControlCommand): void {
    const pendingCommands = this.nextPendingCommands(command)
    logSessionEvent('runtime', 'runtime.command_queued', {
      commandId: command.commandId,
      type: command.type,
      rendererReady: this.status.rendererReady,
      pendingCommands: pendingCommands.length
    })
    this.setStatus({
      pendingCommands,
      metadata: {
        lastCommandAt: command.requestedAt,
        lastCommandId: command.commandId
      }
    })
    this.flushPendingCommands()
  }

  private flushPendingCommands(): void {
    if (!this.status.rendererReady || this.status.pendingCommands.length === 0) {
      if (this.status.pendingCommands.length > 0) {
        logSessionEvent('runtime', 'runtime.command_deferred', {
          rendererReady: this.status.rendererReady,
          pendingCommands: this.status.pendingCommands.length
        })
      }
      return
    }

    const pendingCommands = [...this.status.pendingCommands]
    this.setStatus({ pendingCommands: [] })
    pendingCommands.forEach((command) => this.dispatchCommand(command))
  }

  private dispatchCommand(command: RuntimeControlCommand): void {
    logSessionEvent('runtime', 'runtime.command_dispatched', {
      commandId: command.commandId,
      type: command.type
    })
    this.setStatus({
      activeCommands: [...this.status.activeCommands, command]
    })
    this.sendToRenderer(CONTROL_CHANNELS.command, command)
    this.emit('command', command)
  }

  private nextPendingCommands(command: RuntimeControlCommand): RuntimeControlCommand[] {
    if (command.type === 'showCamera') {
      return [
        ...this.status.pendingCommands.filter((queued) => queued.type !== 'showCamera'),
        command
      ]
    }

    return [
      ...this.status.pendingCommands.filter(
        (queued) =>
          !['startSession', 'stopSession', 'restartSession'].includes(queued.type)
      ),
      command
    ]
  }

  private applyStartupMode(config: ExtraConfig): void {
    this.setStatus({
      metadata: {
        runtimeEngine: config.runtimeEngine
      }
    })

    if (config.startMode === 'manual' && this.status.session === 'idle') {
      this.setStatus({ desiredSession: 'stopped' })
      return
    }

    if (
      config.startMode === 'auto' &&
      this.status.desiredSession === 'stopped' &&
      this.status.session === 'idle'
    ) {
      this.setStatus({ desiredSession: 'running' })
      if (this.status.rendererReady) {
        this.startSession()
      }
    }
  }

  private shouldIgnoreStartProgress(eventType: SessionAdapterEvent['type']): boolean {
    const ignore =
      this.status.desiredSession === 'stopped' &&
      ['waitingForDongle', 'dongleFound', 'waitingForPhone', 'phoneConnected'].includes(eventType)

    if (ignore) {
      logSessionEvent('runtime', 'runtime.adapter_event', {
        ignored: true,
        eventType,
        desiredSession: this.status.desiredSession,
        session: this.status.session
      })
    }

    return ignore
  }

  private sendToRenderer(channel: string, payload: unknown): void {
    if (this.renderer && !this.renderer.isDestroyed()) {
      this.renderer.send(channel, payload)
    }
  }
}
