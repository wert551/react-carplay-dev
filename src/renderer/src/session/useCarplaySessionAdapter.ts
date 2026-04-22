import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CommandMapping,
  findDevice,
  requestDevice
} from 'node-carplay/web'
import type { ExtraConfig } from '../../../shared/config'
import type { RuntimeControlCommand, SessionAdapterEvent } from '../../../shared/control'
import { logSessionEvent } from '../../../shared/sessionLog'
import { controlClient } from '../integration/controlClient'
import { useCarplayStore, useStatusStore } from '../store/store'
import useCarplayAudio from '../components/useCarplayAudio'
import { useCarplayTouch } from '../components/useCarplayTouch'
import type { CarPlayWorker } from '../components/worker/types'
import { InitEvent } from '../components/worker/render/RenderEvents'

const width = window.innerWidth
const height = window.innerHeight
const RETRY_DELAY_MS = 15000

type UseCarplaySessionAdapterProps = {
  settings: ExtraConfig
  command: string
  commandCounter: number
}

const reportSessionEvent = (event: SessionAdapterEvent) => {
  controlClient.reportSessionEvent(event).catch((error) => {
    console.error('Failed to report CarPlay session event', event, error)
  })
}

export const useCarplaySessionAdapter = ({
  settings,
  command,
  commandCounter
}: UseCarplaySessionAdapterProps) => {
  const navigate = useNavigate()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mainElem = useRef<HTMLDivElement>(null)
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const sessionTimingRef = useRef({
    startCommandAt: 0,
    dongleSearchStartedAt: 0,
    usbOpenStartedAt: 0,
    waitingForPhoneAt: 0
  })
  const [canvasElement, setCanvasElement] = useState<HTMLCanvasElement | null>(null)
  const stream = useCarplayStore((state) => state.stream)

  const channels = useMemo(
    () => ({
      video: new MessageChannel(),
      microphone: new MessageChannel()
    }),
    []
  )

  const config = useMemo(
    () => ({
      fps: settings.fps,
      width,
      height,
      mediaDelay: settings.mediaDelay
    }),
    [settings.fps, settings.mediaDelay]
  )

  const report = useCallback((event: SessionAdapterEvent) => {
    reportSessionEvent(event)
  }, [])

  const acceptCommand = useCallback(
    (controlCommand: RuntimeControlCommand) => {
      logSessionEvent('adapter', 'adapter.command_accepted', {
        commandId: controlCommand.commandId,
        type: controlCommand.type
      })
      report({ type: 'commandAccepted', commandId: controlCommand.commandId })
    },
    [report]
  )

  const rejectCommand = useCallback(
    (controlCommand: RuntimeControlCommand, error: unknown) => {
      logSessionEvent('adapter', 'adapter.command_rejected', {
        commandId: controlCommand.commandId,
        type: controlCommand.type,
        error: error instanceof Error ? error.message : String(error)
      })
      report({
        type: 'commandRejected',
        commandId: controlCommand.commandId,
        error: error instanceof Error ? error.message : String(error)
      })
    },
    [report]
  )

  const renderWorker = useMemo(() => {
    if (!canvasElement) return

    const worker = new Worker(
      new URL('../components/worker/render/Render.worker.ts', import.meta.url),
      { type: 'module' }
    )
    const canvas = canvasElement.transferControlToOffscreen()
    worker.postMessage(new InitEvent(canvas, channels.video.port2), [
      canvas,
      channels.video.port2
    ])
    return worker
  }, [canvasElement, channels.video])

  useLayoutEffect(() => {
    if (canvasRef.current) {
      setCanvasElement(canvasRef.current)
    }
  }, [])

  const carplayWorker = useMemo(() => {
    const worker = new Worker(
      new URL('../components/worker/CarPlay.worker.ts', import.meta.url),
      { type: 'module' }
    ) as CarPlayWorker
    const payload = {
      videoPort: channels.video.port1,
      microphonePort: channels.microphone.port1
    }
    worker.postMessage({ type: 'initialise', payload }, [
      channels.video.port1,
      channels.microphone.port1
    ])
    return worker
  }, [channels.microphone, channels.video])

  const { processAudio, getAudioPlayer, startRecording, stopRecording } =
    useCarplayAudio(carplayWorker, channels.microphone.port2, settings.microphone)

  const clearRetryTimeout = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
  }, [])

  const checkDevice = useCallback(
    async (request = false) => {
      if (!navigator.usb) {
        const error = 'navigator.usb unavailable'
        logSessionEvent('adapter', 'adapter.session_error', { reason: error })
        report({ type: 'sessionError', error })
        return
      }
      sessionTimingRef.current.dongleSearchStartedAt = Date.now()
      logSessionEvent('adapter', 'adapter.dongle_search_started', {
        requestUserPrompt: request
      })
      report({ type: 'waitingForDongle' })
      const device = request ? await requestDevice() : await findDevice()
      if (device) {
        logSessionEvent('adapter', 'adapter.dongle_found', {
          elapsedMs: Date.now() - sessionTimingRef.current.dongleSearchStartedAt
        })
        report({ type: 'dongleFound' })
        sessionTimingRef.current.usbOpenStartedAt = Date.now()
        logSessionEvent('adapter', 'adapter.usb_open_started')
        carplayWorker.postMessage({ type: 'start', payload: { config } })
        logSessionEvent('adapter', 'adapter.usb_open_dispatched', {
          elapsedMs: Date.now() - sessionTimingRef.current.usbOpenStartedAt
        })
        sessionTimingRef.current.waitingForPhoneAt = Date.now()
        logSessionEvent('adapter', 'adapter.waiting_for_phone')
        report({ type: 'waitingForPhone' })
      } else {
        logSessionEvent('adapter', 'adapter.dongle_not_found', {
          elapsedMs: Date.now() - sessionTimingRef.current.dongleSearchStartedAt
        })
        report({ type: 'waitingForDongle' })
      }
    },
    [carplayWorker, config, report]
  )

  const stopSession = useCallback(async () => {
    clearRetryTimeout()
    carplayWorker.postMessage({ type: 'stop' })
    logSessionEvent('adapter', 'adapter.session_stopped')
    report({ type: 'sessionStopped' })
  }, [carplayWorker, clearRetryTimeout, report])

  const restartSession = useCallback(async () => {
    await stopSession()
    await checkDevice()
  }, [checkDevice, stopSession])

  useEffect(() => {
    return controlClient.onCommand((controlCommand) => {
      try {
        logSessionEvent('adapter', 'adapter.command_received', {
          commandId: controlCommand.commandId,
          type: controlCommand.type
        })
        acceptCommand(controlCommand)
        switch (controlCommand.type) {
          case 'startSession':
            sessionTimingRef.current.startCommandAt = Date.now()
            checkDevice().catch((error) => rejectCommand(controlCommand, error))
            break
          case 'stopSession':
            stopSession().catch((error) => rejectCommand(controlCommand, error))
            break
          case 'restartSession':
            restartSession().catch((error) => rejectCommand(controlCommand, error))
            break
          case 'showCamera':
            logSessionEvent('adapter', 'adapter.camera_visibility_changed', {
              visible: controlCommand.visible
            })
            report({ type: 'cameraVisibilityChanged', visible: controlCommand.visible })
            if (controlCommand.visible) {
              navigate('/camera')
            }
            break
        }
      } catch (error) {
        rejectCommand(controlCommand, error)
      }
    })
  }, [acceptCommand, checkDevice, navigate, rejectCommand, report, restartSession, stopSession])

  useEffect(() => {
    logSessionEvent('adapter', 'adapter.ready', {
      startMode: settings.startMode,
      shellMode: settings.shellMode
    })
    controlClient.sessionAdapterReady().catch((error) => {
      console.error('Failed to mark CarPlay session adapter ready', error)
    })
  }, [settings.shellMode, settings.startMode])

  useEffect(() => {
    carplayWorker.onmessage = (ev) => {
      const { type } = ev.data
      switch (type) {
        case 'plugged':
          logSessionEvent('adapter', 'adapter.usb_open_completed', {
            elapsedMs: sessionTimingRef.current.usbOpenStartedAt
              ? Date.now() - sessionTimingRef.current.usbOpenStartedAt
              : null
          })
          logSessionEvent('adapter', 'adapter.phone_connected', {
            elapsedSinceStartCommandMs: sessionTimingRef.current.startCommandAt
              ? Date.now() - sessionTimingRef.current.startCommandAt
              : null,
            elapsedSinceWaitingForPhoneMs: sessionTimingRef.current.waitingForPhoneAt
              ? Date.now() - sessionTimingRef.current.waitingForPhoneAt
              : null
          })
          report({ type: 'phoneConnected' })
          if (settings.piMost && settings?.most?.stream) {
            console.log('setting most stream')
            stream(settings.most.stream)
          }
          break
        case 'unplugged':
          logSessionEvent('adapter', 'adapter.phone_disconnected')
          report({ type: 'phoneDisconnected' })
          break
        case 'requestBuffer':
          clearRetryTimeout()
          getAudioPlayer(ev.data.message)
          break
        case 'audio':
          clearRetryTimeout()
          processAudio(ev.data.message)
          break
        case 'media':
          // TODO: implement
          break
        case 'command':
          const {
            message: { value }
          } = ev.data
          switch (value) {
            case CommandMapping.startRecordAudio:
              startRecording()
              break
            case CommandMapping.stopRecordAudio:
              stopRecording()
              break
            case CommandMapping.requestHostUI:
              navigate('/settings')
          }
          break
        case 'failure':
          logSessionEvent('adapter', 'adapter.session_error', {
            reason: 'Carplay initialization failed'
          })
          report({ type: 'sessionError', error: 'Carplay initialization failed' })
          if (retryTimeoutRef.current == null) {
            console.error(
              `Carplay initialization failed -- Reloading page in ${RETRY_DELAY_MS}ms`
            )
            retryTimeoutRef.current = setTimeout(() => {
              window.location.reload()
            }, RETRY_DELAY_MS)
          }
          break
      }
    }
  }, [
    carplayWorker,
    clearRetryTimeout,
    getAudioPlayer,
    navigate,
    processAudio,
    renderWorker,
    report,
    settings,
    startRecording,
    stopRecording,
    stream
  ])

  useEffect(() => {
    const element = mainElem?.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      carplayWorker.postMessage({ type: 'frame' })
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [carplayWorker])

  useEffect(() => {
    carplayWorker.postMessage({ type: 'keyCommand', command })
  }, [carplayWorker, command, commandCounter])

  useEffect(() => {
    if (!navigator.usb) {
      logSessionEvent('adapter', 'adapter.session_error', {
        reason: 'navigator.usb unavailable'
      })
      return
    }

    navigator.usb.onconnect = async () => {
      if (useStatusStore.getState().desiredSession === 'running') {
        checkDevice().catch((error) => {
          report({ type: 'sessionError', error: error instanceof Error ? error.message : String(error) })
        })
      }
    }

    navigator.usb.ondisconnect = async () => {
      const device = await findDevice()
      if (!device) {
        logSessionEvent('adapter', 'adapter.phone_disconnected', {
          reason: 'usb_disconnect'
        })
        carplayWorker.postMessage({ type: 'stop' })
        report({ type: 'phoneDisconnected' })
        report({
          type: useStatusStore.getState().desiredSession === 'running'
            ? 'waitingForDongle'
            : 'sessionStopped'
        })
      }
    }
  }, [carplayWorker, checkDevice, report])

  const sendTouchEvent = useCarplayTouch(carplayWorker, width, height)

  return {
    canvasRef,
    mainElem,
    sendTouchEvent
  }
}
