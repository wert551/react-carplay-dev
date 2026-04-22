import { create } from 'zustand'
import { ExtraConfig } from "../../../shared/config";
import { Stream } from "socketmost/dist/modules/Messages";
import {
  CarplayStatusUpdate,
  DEFAULT_STATUS,
  DesiredSessionState,
  RuntimeControlCommand,
  SessionMetadata,
  SessionState
} from '../../../shared/control'
import { controlClient } from '../integration/controlClient'

interface CarplayStore {
  settings: null | ExtraConfig,
  saveSettings: (settings: Partial<ExtraConfig>) => Promise<void>
  getSettings: () => Promise<void>
  stream: (stream: Stream) => void
}

interface StatusStore {
  reverse: boolean,
  lights: boolean,
  isPlugged: boolean,
  deviceFound: boolean,
  receivingVideo: boolean,
  cameraVisible: boolean,
  rendererReady: boolean,
  desiredSession: DesiredSessionState,
  session: SessionState,
  lastError: string | null,
  pendingCommands: RuntimeControlCommand[],
  activeCommands: RuntimeControlCommand[],
  metadata: SessionMetadata,
  setPlugged: (plugged: boolean) => void,
  setReverse: (reverse: boolean) => void
  updateStatus: (status: CarplayStatusUpdate) => void
}

export const useCarplayStore = create<CarplayStore>()((set) =>({
  settings: null,
  saveSettings: async (settings) => {
    const nextConfig = await controlClient.setConfig(settings)
    set(() => ({settings: nextConfig}))
  },
  getSettings: async () => {
    const settings = await controlClient.getConfig()
    set(() => ({settings}))
  },
  stream: (stream) => {
    controlClient.stream(stream)
  }
}))

export const useStatusStore = create<StatusStore>()((set) => ({
  ...DEFAULT_STATUS,
  setPlugged: (plugged) => {
    set(() => ({isPlugged: plugged}))
    controlClient.setStatus({ isPlugged: plugged, session: plugged ? 'connected' : 'idle' })
  },
  setReverse: (reverse) => {
    set(() => ({reverse: reverse}))
    controlClient.setStatus({ reverse, cameraVisible: reverse })
  },
  updateStatus: (status) => {
    set((current) => ({
      ...status,
      metadata: {
        ...current.metadata,
        ...(status.metadata ?? {})
      }
    }))
    controlClient.setStatus(status)
  }
}))

controlClient.onConfigChanged((settings: ExtraConfig) => {
  console.log("received settings", settings)
  useCarplayStore.setState(() => ({settings: settings}))
})

controlClient.onStatusChanged((status) => {
  console.log("received status", status)
  useStatusStore.setState((current) => ({
    ...current,
    ...status,
    metadata: {
      ...current.metadata,
      ...(status.metadata ?? {})
    }
  }))
})

controlClient.getStatus().then((status) => {
  useStatusStore.setState((current) => ({
    ...current,
    ...status,
    metadata: {
      ...current.metadata,
      ...status.metadata
    }
  }))
}).catch((error) => {
  console.error('Failed to load CarPlay status', error)
})
