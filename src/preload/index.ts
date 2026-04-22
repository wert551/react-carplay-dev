import { IpcRendererEvent, contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ExtraConfig} from "../shared/config";
import { CONTROL_CHANNELS } from '../shared/control'
import type { CarplayStatusUpdate, RuntimeControlApi, SessionAdapterEvent } from '../shared/control'
import { Stream } from "socketmost/dist/modules/Messages";

type ApiCallback = (event: IpcRendererEvent, ...args: any[]) => void
type PlainCallback<T> = (payload: T) => void

export interface Api {
  settings: (callback: ApiCallback) => void
  reverse: (callback: ApiCallback) => void
  getSettings: () => void
  saveSettings: (settings: ExtraConfig) => void
  stream: (stream: Stream) =>  void
  quit: () =>  void
}

const subscribe = <T>(channel: string, callback: PlainCallback<T>) => {
  const listener = (_: IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Custom APIs for renderer
const api: Api = {
  settings: (callback: ApiCallback) => ipcRenderer.on('settings', callback),
  reverse: (callback: ApiCallback) => ipcRenderer.on('reverse', callback),
  getSettings: () => ipcRenderer.send('getSettings'),
  saveSettings: (settings: ExtraConfig) => ipcRenderer.send('saveSettings', settings),
  stream: (stream: Stream) => ipcRenderer.send(CONTROL_CHANNELS.stream, stream),
  quit: () => ipcRenderer.send('quit')
}

const carplayControl: RuntimeControlApi = {
  getConfig: () => ipcRenderer.invoke(CONTROL_CHANNELS.getConfig),
  setConfig: (config: Partial<ExtraConfig>) => ipcRenderer.invoke(CONTROL_CHANNELS.setConfig, config),
  validateConfig: (config: Partial<ExtraConfig>) => ipcRenderer.invoke(CONTROL_CHANNELS.validateConfig, config),
  getStatus: () => ipcRenderer.invoke(CONTROL_CHANNELS.getStatus),
  setStatus: (status: CarplayStatusUpdate) => ipcRenderer.invoke(CONTROL_CHANNELS.setStatus, status),
  startSession: () => ipcRenderer.invoke(CONTROL_CHANNELS.startSession),
  stopSession: () => ipcRenderer.invoke(CONTROL_CHANNELS.stopSession),
  restartSession: () => ipcRenderer.invoke(CONTROL_CHANNELS.restartSession),
  showCamera: (visible = true) => ipcRenderer.invoke(CONTROL_CHANNELS.showCamera, visible),
  sessionAdapterReady: () => ipcRenderer.invoke(CONTROL_CHANNELS.sessionAdapterReady),
  reportSessionEvent: (event: SessionAdapterEvent) => ipcRenderer.invoke(CONTROL_CHANNELS.reportSessionEvent, event),
  stream: (stream: unknown) => ipcRenderer.send(CONTROL_CHANNELS.stream, stream),
  quit: () => ipcRenderer.send(CONTROL_CHANNELS.quit),
  onConfigChanged: (callback) => subscribe(CONTROL_CHANNELS.configChanged, callback),
  onStatusChanged: (callback) => subscribe(CONTROL_CHANNELS.statusChanged, callback),
  onCommand: (callback) => subscribe(CONTROL_CHANNELS.command, callback)
}

try {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
  contextBridge.exposeInMainWorld('carplayControl', carplayControl)
  contextBridge.exposeInMainWorld('electronAPI', {
    settings: (callback: ApiCallback) => ipcRenderer.on('settings', callback),
    getSettings: () => ipcRenderer.send('getSettings'),
    saveSettings: (settings: ExtraConfig) => ipcRenderer.send('saveSettings', settings),
    stream: (stream: Stream) => ipcRenderer.send(CONTROL_CHANNELS.stream, stream),
    quit: () => ipcRenderer.send('quit')
  })
} catch (error) {
  console.error(error)
}

