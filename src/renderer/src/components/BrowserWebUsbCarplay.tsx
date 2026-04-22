import { useLocation } from 'react-router-dom'
import type { ExtraConfig } from '../../../shared/config'
import { useStatusStore } from '../store/store'
import { useCarplaySessionAdapter } from '../session/useCarplaySessionAdapter'
import { CarplaySurface } from './CarplaySurface'

type BrowserWebUsbCarplayProps = {
  settings: ExtraConfig
  command: string
  commandCounter: number
}

function BrowserWebUsbCarplay({ settings, command, commandCounter }: BrowserWebUsbCarplayProps) {
  const [isPlugged, deviceFound, session] = useStatusStore(state => [state.isPlugged, state.deviceFound, state.session])
  const { pathname } = useLocation()
  const { canvasRef, mainElem, sendTouchEvent } = useCarplaySessionAdapter({
    settings,
    command,
    commandCounter
  })
  console.log(pathname)

  return (
    <CarplaySurface
      canvasRef={canvasRef}
      mainElem={mainElem}
      sendTouchEvent={sendTouchEvent}
      isPlugged={isPlugged}
      deviceFound={deviceFound}
      session={session}
      runtimeEngine={settings.runtimeEngine}
    />
  )
}

export default BrowserWebUsbCarplay
