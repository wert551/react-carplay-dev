import React, { Suspense } from "react";
//import './App.css'
import { ExtraConfig} from "../../../shared/config";
import { useStatusStore } from "../store/store";
import { logSessionEvent } from '../../../shared/sessionLog'
import { CarplaySurface } from './CarplaySurface'

const BrowserWebUsbCarplay = React.lazy(() => import('./BrowserWebUsbCarplay'))

interface CarplayProps {
  settings: ExtraConfig,
  command: string,
  commandCounter: number
}

function Carplay({ settings, command, commandCounter }: CarplayProps) {
  if (settings.runtimeEngine === 'external') {
    return <ExternalRuntimeCarplaySurface />
  }

  return (
    <Suspense fallback={null}>
      <BrowserWebUsbCarplay settings={settings} command={command} commandCounter={commandCounter} />
    </Suspense>
  )
}

function ExternalRuntimeCarplaySurface() {
  const [isPlugged, deviceFound, session] = useStatusStore(state => [state.isPlugged, state.deviceFound, state.session])
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const mainElem = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    logSessionEvent('adapter', 'adapter.disabled', {
      reason: 'runtimeEngine external; WebUSB adapter is not started'
    })
  }, [])

  const sendTouchEvent = React.useCallback(() => {
    // External runtime mode intentionally does not use browser/WebUSB touch forwarding.
  }, [])

  return (
    <CarplaySurface
      canvasRef={canvasRef}
      mainElem={mainElem}
      sendTouchEvent={sendTouchEvent}
      isPlugged={isPlugged}
      deviceFound={deviceFound}
      session={session}
      runtimeEngine={'external'}
    />
  )
}

export default React.memo(Carplay)
