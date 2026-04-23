import { app, shell, BrowserWindow, session, systemPreferences, IpcMainEvent, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { DEFAULT_CONFIG } from 'node-carplay/node'
import { Socket } from './Socket'

// comment below line to allow running on non linux devices
import {Canbus} from "./Canbus"

import { ExtraConfig, createDefaultConfig } from '../shared/config'
import type { VideoDecoderAcceleration, VideoRenderer } from '../shared/config'
import { CarplayStatusUpdate, CONTROL_CHANNELS, SessionAdapterEvent } from '../shared/control'
import { ConfigStore } from './ConfigStore'
import { RuntimeControl } from './RuntimeControl'
import { PiMost } from './PiMost'
// import CarplayNode, {DEFAULT_CONFIG, CarplayMessage} from "node-carplay/node";

let mainWindow: BrowserWindow
let configStore: ConfigStore
let runtimeControl: RuntimeControl

// comment below line to allow running on non linux devices
let canbus: null | Canbus = null
let piMost: null | PiMost = null

let socket: null | Socket = null

const isPiRuntimeProfile = () =>
  process.env.REACT_CARPLAY_PROFILE === 'pi' || process.env.REACT_CARPLAY_PI === '1'

const isPiSafeRuntimeProfile = () =>
  process.env.REACT_CARPLAY_PROFILE === 'pi-safe' || process.env.REACT_CARPLAY_PI_SAFE === '1'

const getPiVideoRenderer = (): VideoRenderer => {
  const renderer = process.env.REACT_CARPLAY_VIDEO_RENDERER
  switch (renderer) {
    case 'webgl':
    case 'webgl2':
    case 'webgpu':
      return renderer
    default:
      return 'webgl2'
  }
}

const getPiVideoDecoderAcceleration = (): VideoDecoderAcceleration => {
  const acceleration = process.env.REACT_CARPLAY_VIDEO_DECODER
  switch (acceleration) {
    case 'no-preference':
    case 'prefer-hardware':
    case 'prefer-software':
      return acceleration
    default:
      return 'prefer-hardware'
  }
}

const getPiGlProfile = () => {
  return process.env.REACT_CARPLAY_GL === 'egl-gles2' ? 'egl-gles2' : 'egl-angle'
}

const configureChromiumRuntime = () => {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  app.commandLine.appendSwitch('disable-webusb-security', 'true')

  if (isPiSafeRuntimeProfile()) {
    // Diagnostic fallback: disable Chromium's GPU process/rendering paths to confirm
    // whether Raspberry Pi GPU-process instability is the choppiness/crash source.
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('disable-gpu')
    app.commandLine.appendSwitch('disable-gpu-compositing')
    app.commandLine.appendSwitch('disable-gpu-rasterization')
    app.commandLine.appendSwitch('disable-accelerated-2d-canvas')
    app.commandLine.appendSwitch('disable-accelerated-video-decode')
    app.commandLine.appendSwitch('disable-zero-copy')
    app.commandLine.appendSwitch('disable-features', 'Vulkan,WebGPU,VaapiVideoDecoder,CanvasOopRasterization,UseSkiaRenderer')
    app.commandLine.appendSwitch('use-gl', 'disabled')
    app.commandLine.appendSwitch('use-angle', 'none')
    console.log('React-CarPlay Pi SAFE runtime profile enabled: Chromium GPU acceleration disabled for diagnostic fallback')
  } else if (isPiRuntimeProfile()) {
    const glProfile = getPiGlProfile()
    app.commandLine.appendSwitch('disable-features', 'Vulkan,WebGPU')
    app.commandLine.appendSwitch('ignore-gpu-blocklist')
    app.commandLine.appendSwitch('enable-gpu-rasterization')
    app.commandLine.appendSwitch('use-gl', glProfile)
    if (glProfile === 'egl-angle') {
      app.commandLine.appendSwitch('use-angle', 'default')
    } else {
      app.commandLine.appendSwitch('use-angle', 'none')
    }
    console.log(`React-CarPlay Pi runtime profile enabled: WebGPU/Vulkan disabled, WebGL via ${glProfile} preferred`)
  } else {
    app.commandLine.appendSwitch('enable-experimental-web-platform-features')
  }
}

const handleSettingsReq = (_: IpcMainEvent ) => {
  console.log("settings request")
  mainWindow?.webContents.send('settings', runtimeControl.getConfig())
}


configureChromiumRuntime()
console.log(app.commandLine.hasSwitch('disable-webusb-security'))
function createWindow(): void {
  const config = runtimeControl.getConfig()
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: config.width,
    height: config.height,
    kiosk: config.kiosk,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: true,
      nodeIntegrationInWorker: true,
      webSecurity: false
    }
  })
  runtimeControl.attachRenderer(mainWindow.webContents)
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  // mainWindow.webContents.session.setDevicePermissionHandler((details) => {
  //   if (true) {
  //     if (details.device.vendorId === 4884 && details.device.productId === 5408) {
  //       // Always allow this type of device (this allows skipping the call to `navigator.hid.requestDevice` first)
  //       return true
  //     }
  //   }
  //   return false
  // })

  mainWindow.webContents.session.setPermissionCheckHandler(() => {
      return true
  })

  mainWindow.webContents.session.setDevicePermissionHandler((details) => {
    if(details.device.vendorId === 4884) {
      return true
    } else {
      return false
    }

  })


  mainWindow.webContents.session.on('select-usb-device', (event, details, callback) => {
    event.preventDefault()
    const selectedDevice = details.deviceList.find((device) => {
      return device.vendorId === 4884 && (device.productId === 5408 || device.productId === 5409)
    })

    callback(selectedDevice?.deviceId)
  })
  // app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })



  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  if (process.platform === 'darwin' && typeof systemPreferences.askForMediaAccess === 'function') {
    systemPreferences.askForMediaAccess("microphone")
  }
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    details.responseHeaders!['Cross-Origin-Opener-Policy'] = ['same-origin'];
    details.responseHeaders!['Cross-Origin-Embedder-Policy'] = ['require-corp'];
    callback({ responseHeaders: details.responseHeaders });
  });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required")
app.whenReady().then(() => {
  initializeServices()

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')
  // const carplay = new CarplayNode(DEFAULT_CONFIG)
  //
  // carplay.start()
  // carplay.onmessage = (message: CarplayMessage) => {
  //
  //   if (message.type === 'audio') {
  //     mainWindow.webContents.send('audioData', message.message)
  //   }
  // }
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      }
    })
  })

  registerIpcHandlers()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

const initializeServices = () => {
  const configPath = join(app.getPath('userData'), 'config.json')
  const defaults = createDefaultConfig(DEFAULT_CONFIG)
  configStore = new ConfigStore(configPath, defaults)
  configStore.load()
  if (isPiSafeRuntimeProfile()) {
    configStore.setConfig({
      videoRenderer: 'webgl',
      videoDecoderAcceleration: 'prefer-software'
    })
  } else if (isPiRuntimeProfile()) {
    configStore.setConfig({
      videoRenderer: getPiVideoRenderer(),
      videoDecoderAcceleration: getPiVideoDecoderAcceleration()
    })
  }
  runtimeControl = new RuntimeControl(configStore)
  socket = new Socket(runtimeControl)
  configureOptionalHardware(runtimeControl.getConfig())
  runtimeControl.on('configChanged', (config: ExtraConfig) => {
    configureOptionalHardware(config)
  })
  console.log(`React-CarPlay config path: ${configStore.getConfigPath()}`)
}

const configureOptionalHardware = (config: ExtraConfig) => {
  if (config.piMost && !piMost) {
    piMost = new PiMost(runtimeControl)
  }

  // comment below if statement to allow running on non linux devices
  if (config.canbus && !canbus && socket) {
    console.log("Configuring can", config.canConfig)
    canbus = new Canbus('can0', socket, config.canConfig)
    canbus.on('lights', (data) => {
      console.log('lights', data)
    })
  }
}

const registerIpcHandlers = () => {
  ipcMain.on('getSettings', handleSettingsReq)
  ipcMain.on('saveSettings', saveSettings)
  ipcMain.on('quit', quit)

  ipcMain.handle(CONTROL_CHANNELS.getConfig, () => runtimeControl.getConfig())
  ipcMain.handle(CONTROL_CHANNELS.setConfig, (_, settings: Partial<ExtraConfig>) => {
    return runtimeControl.setConfig(settings)
  })
  ipcMain.handle(CONTROL_CHANNELS.validateConfig, (_, settings: Partial<ExtraConfig>) => {
    return runtimeControl.validateConfig(settings)
  })
  ipcMain.handle(CONTROL_CHANNELS.getStatus, () => runtimeControl.getStatus())
  ipcMain.handle(CONTROL_CHANNELS.setStatus, (_, status: CarplayStatusUpdate) => {
    return runtimeControl.setStatus(status)
  })
  ipcMain.handle(CONTROL_CHANNELS.startSession, () => runtimeControl.startSession())
  ipcMain.handle(CONTROL_CHANNELS.stopSession, () => runtimeControl.stopSession())
  ipcMain.handle(CONTROL_CHANNELS.restartSession, () => runtimeControl.restartSession())
  ipcMain.handle(CONTROL_CHANNELS.showCamera, (_, visible?: boolean) => {
    return runtimeControl.showCamera(visible)
  })
  ipcMain.handle(CONTROL_CHANNELS.sessionAdapterReady, () => runtimeControl.sessionAdapterReady())
  ipcMain.handle(CONTROL_CHANNELS.reportSessionEvent, (_, event: SessionAdapterEvent) => {
    return runtimeControl.reportSessionEvent(event)
  })
  ipcMain.on(CONTROL_CHANNELS.stream, (_, stream) => {
    runtimeControl.stream(stream)
  })
  ipcMain.on(CONTROL_CHANNELS.quit, quit)
}

const saveSettings = (_: IpcMainEvent, settings: ExtraConfig) => {
  console.log("saving settings", settings)
  runtimeControl.setConfig(settings)
}

// const startMostStream = (_: IpcMainEvent, most: Stream) => {
//   console.log("stream request")
//   if(piMost) {
//     piMost.stream(most)
//   }
// }

const quit = (_: IpcMainEvent) => {
  app.quit()
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.
