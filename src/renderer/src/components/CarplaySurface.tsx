import React from 'react'
import { useLocation } from 'react-router-dom'
import { RotatingLines } from 'react-loader-spinner'
import { Typography } from '@mui/material'
import type { ExtraConfig } from '../../../shared/config'
import type { SessionState } from '../../../shared/control'

type CarplaySurfaceProps = {
  canvasRef: React.RefObject<HTMLCanvasElement>
  mainElem: React.RefObject<HTMLDivElement>
  sendTouchEvent: React.PointerEventHandler<HTMLDivElement>
  isPlugged: boolean
  deviceFound: boolean
  session: SessionState
  runtimeEngine: ExtraConfig['runtimeEngine']
}

export function CarplaySurface({
  canvasRef,
  mainElem,
  sendTouchEvent,
  isPlugged,
  deviceFound,
  session,
  runtimeEngine
}: CarplaySurfaceProps) {
  const { pathname } = useLocation()
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
              <Typography>{runtimeEngine === 'external' ? 'Waiting For External Runtime' : 'Searching For Dongle'}</Typography>
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
