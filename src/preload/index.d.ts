import { ElectronAPI } from '@electron-toolkit/preload'
import { Api } from "./index";
import { RuntimeControlApi } from '../shared/control'

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
    carplayControl?: RuntimeControlApi
    electronAPI: Api
  }
}
