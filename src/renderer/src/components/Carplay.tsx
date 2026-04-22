import React from "react";
import { RotatingLines } from 'react-loader-spinner'
//import './App.css'
import { useLocation } from "react-router-dom";
import { ExtraConfig} from "../../../shared/config";
import { useStatusStore } from "../store/store";
import { Typography } from "@mui/material";
import { useCarplaySessionAdapter } from '../session/useCarplaySessionAdapter'

interface CarplayProps {
  settings: ExtraConfig,
  command: string,
  commandCounter: number
}

function Carplay({ settings, command, commandCounter }: CarplayProps) {
  const [isPlugged, deviceFound, session] = useStatusStore(state => [state.isPlugged, state.deviceFound, state.session])
  const { pathname } = useLocation()
  const { canvasRef, mainElem, sendTouchEvent } = useCarplaySessionAdapter({
    settings,
    command,
    commandCounter
  })
  // const pathname = "/"
  console.log(pathname)

  const isLoading = !isPlugged

  return (
    <div
      style={pathname === '/' ? { height: '100%', touchAction: 'none' } : { height: '1px' }}
      id={'main'}
      className="App"
      ref={mainElem}
    >
      {(deviceFound === false || isLoading) && pathname === '/' && (
        <div
          style={{
            position: 'absolute',
            width: '100%',
            height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center'
          }}
        >
          {deviceFound === false && (
            <div>
              <Typography>Searching For Dongle</Typography>
              <RotatingLines
                strokeColor="grey"
                strokeWidth="5"
                animationDuration="0.75"
                width="96"
                visible={true}
              />
            </div>
          )}
          {deviceFound && (
            <div>
              <Typography>{session === 'error' ? 'CarPlay Session Error' : 'Searching For Phone'}</Typography>
              <RotatingLines
                strokeColor="grey"
                strokeWidth="5"
                animationDuration="0.75"
                width="96"
                visible={true}
              />
            </div>
          )}
        </div>
      )}
      <div
        id="videoContainer"
        onPointerDown={sendTouchEvent}
        onPointerMove={sendTouchEvent}
        onPointerUp={sendTouchEvent}
        onPointerCancel={sendTouchEvent}
        onPointerOut={sendTouchEvent}
        style={{
          height: '100%',
          width: '100%',
          padding: 0,
          margin: 0,
          display: 'flex',
          visibility: isPlugged ? 'visible' : 'hidden'
        }}
      >
        <canvas
          ref={canvasRef}
          id={'video'}
          style={isPlugged ? { height: '100%' } : { height: '0%' }}
        />
      </div>
    </div>
  )
}

export default React.memo(Carplay)
