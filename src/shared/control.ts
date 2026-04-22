import type { ExtraConfig } from './config'

export type SessionState =
  | 'idle'
  | 'starting'
  | 'waiting_for_dongle'
  | 'waiting_for_phone'
  | 'connected'
  | 'stopping'
  | 'error'

export type DesiredSessionState = 'stopped' | 'running'

export type SessionMetadata = {
  adapterReadyAt: number | null
  lastCommandAt: number | null
  lastEventAt: number | null
  lastCommandId: string | null
  lastAcceptedCommandId: string | null
  lastRejectedCommandId: string | null
}

export type CarplayStatus = {
  reverse: boolean
  lights: boolean
  isPlugged: boolean
  deviceFound: boolean
  receivingVideo: boolean
  cameraVisible: boolean
  rendererReady: boolean
  desiredSession: DesiredSessionState
  session: SessionState
  lastError: string | null
  pendingCommands: RuntimeControlCommand[]
  activeCommands: RuntimeControlCommand[]
  metadata: SessionMetadata
}

export type CarplayStatusUpdate = Omit<Partial<CarplayStatus>, 'metadata'> & {
  metadata?: Partial<SessionMetadata>
}

export type RuntimeControlCommand =
  | { commandId: string; type: 'startSession'; requestedAt: number }
  | { commandId: string; type: 'stopSession'; requestedAt: number }
  | { commandId: string; type: 'restartSession'; requestedAt: number }
  | { commandId: string; type: 'showCamera'; visible: boolean; requestedAt: number }

export type SessionAdapterEvent =
  | { type: 'adapterReady'; timestamp?: number }
  | { type: 'commandAccepted'; commandId: string; timestamp?: number }
  | { type: 'commandRejected'; commandId: string; error: string; timestamp?: number }
  | { type: 'waitingForDongle'; timestamp?: number }
  | { type: 'dongleFound'; timestamp?: number }
  | { type: 'waitingForPhone'; timestamp?: number }
  | { type: 'phoneConnected'; timestamp?: number }
  | { type: 'phoneDisconnected'; timestamp?: number }
  | { type: 'sessionStopped'; timestamp?: number }
  | { type: 'sessionError'; error: string; timestamp?: number }
  | { type: 'cameraVisibilityChanged'; visible: boolean; timestamp?: number }

export type ConfigChangeListener = (config: ExtraConfig) => void
export type StatusChangeListener = (status: CarplayStatusUpdate) => void
export type ControlCommandListener = (command: RuntimeControlCommand) => void
export type Unsubscribe = () => void

export interface RuntimeControlApi {
  getConfig: () => Promise<ExtraConfig>
  setConfig: (config: Partial<ExtraConfig>) => Promise<ExtraConfig>
  validateConfig: (config: Partial<ExtraConfig>) => Promise<{ valid: boolean; errors: string[] }>
  getStatus: () => Promise<CarplayStatus>
  setStatus: (status: CarplayStatusUpdate) => Promise<CarplayStatus>
  startSession: () => Promise<CarplayStatus>
  stopSession: () => Promise<CarplayStatus>
  restartSession: () => Promise<CarplayStatus>
  showCamera: (visible?: boolean) => Promise<CarplayStatus>
  sessionAdapterReady: () => Promise<CarplayStatus>
  reportSessionEvent: (event: SessionAdapterEvent) => Promise<CarplayStatus>
  stream: (stream: unknown) => void
  quit: () => void
  onConfigChanged: (callback: ConfigChangeListener) => Unsubscribe
  onStatusChanged: (callback: StatusChangeListener) => Unsubscribe
  onCommand: (callback: ControlCommandListener) => Unsubscribe
}

export const DEFAULT_STATUS: CarplayStatus = {
  reverse: false,
  lights: false,
  isPlugged: false,
  deviceFound: false,
  receivingVideo: false,
  cameraVisible: false,
  rendererReady: false,
  desiredSession: 'stopped',
  session: 'idle',
  lastError: null,
  pendingCommands: [],
  activeCommands: [],
  metadata: {
    adapterReadyAt: null,
    lastCommandAt: null,
    lastEventAt: null,
    lastCommandId: null,
    lastAcceptedCommandId: null,
    lastRejectedCommandId: null
  }
}

export const CONTROL_CHANNELS = {
  getConfig: 'control:getConfig',
  setConfig: 'control:setConfig',
  validateConfig: 'control:validateConfig',
  getStatus: 'control:getStatus',
  setStatus: 'control:setStatus',
  startSession: 'control:startSession',
  stopSession: 'control:stopSession',
  restartSession: 'control:restartSession',
  showCamera: 'control:showCamera',
  sessionAdapterReady: 'control:sessionAdapterReady',
  reportSessionEvent: 'control:reportSessionEvent',
  command: 'control:command',
  configChanged: 'control:configChanged',
  statusChanged: 'control:statusChanged',
  stream: 'control:stream',
  quit: 'control:quit'
} as const
