import { useEffect, useState } from "react";
import { HashRouter as Router, Route, Routes } from "react-router-dom";
import Settings from "./components/Settings";
import './App.css'
import Info from "./components/Info";
import Home from "./components/Home";
import Nav from "./components/Nav";
import Carplay from './components/Carplay'
import Camera from './components/Camera'
import { Box, Modal } from '@mui/material'
import { useCarplayStore, useStatusStore } from "./store/store";
import { ThemeProvider, createTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import type { KeyBindings } from '../../shared/config'

// rm -rf node_modules/.vite; npm run dev


const style = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  height: '95%',
  width: '95%',
  boxShadow: 24,
  display: "flex"
};

function App() {
  const [commandCounter, setCommandCounter] = useState(0)
  const [keyCommand, setKeyCommand] = useState('')
  const [reverse, setReverse, receivingVideo] = useStatusStore(state => [state.reverse, state.setReverse, state.receivingVideo])
  const settings = useCarplayStore((state) => state.settings)
  const getSettings = useCarplayStore((state) => state.getSettings)
  const isHosted = settings?.shellMode === 'hosted'
  const showDebugSettings = settings?.showDebugSettings !== false

  const prefersDarkMode = useMediaQuery('(prefers-color-scheme: dark)');

  const theme = createTheme({
    palette: {
      mode: prefersDarkMode ? 'dark': "light",
    }
  });

  useEffect(() => {
    getSettings()
  }, [getSettings])

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown)

    return () => document.removeEventListener('keydown', onKeyDown)
  }, [settings]);


  const onKeyDown = (event: KeyboardEvent) => {
    if(!settings) return
    if(Object.values(settings.bindings).includes(event.code)) {
      let action = (Object.keys(settings.bindings) as Array<keyof KeyBindings>).find(key =>
        settings.bindings[key] === event.code
      )
      console.log(action)
      if(action !== undefined) {
        setKeyCommand(action)
        setCommandCounter(prev => prev +1)
        if(action === 'selectDown') {
          console.log('select down')
          setTimeout(() => {
            setKeyCommand('selectUp')
            setCommandCounter(prev => prev +1)
          }, 200)
        }
      }
    }
  }

  return (
    <ThemeProvider theme={theme}>
      <Router>
        <div
          style={{ height: '100%', touchAction: 'none' }}
          id={'main'}
          className="App"

        >
          {!isHosted ? <Nav receivingVideo={receivingVideo} settings={settings}/> : null}
          {settings ? <Carplay settings={settings} command={keyCommand} commandCounter={commandCounter}/> : null}
          <Routes>
            <Route path={"/"} element={<Home />} />
            <Route path={"/settings"} element={settings && showDebugSettings ? <Settings settings={settings}/> : null} />
            <Route path={"/info"} element={!isHosted ? <Info /> : null} />
            <Route path={"/camera"} element={<Camera settings={settings}/>} />
          </Routes>
          <Modal
            open={reverse}
            onClick={()=> setReverse(false)}
          >
            <Box sx={style}>
              <Camera settings={settings}/>
            </Box>
          </Modal>
        </div>
      </Router>
    </ThemeProvider>
  )
}

export default App
