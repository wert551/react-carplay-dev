import { Stream } from 'socketmost/dist/modules/Messages'
import Grid from '@mui/material/Unstable_Grid2'
import React, { useState } from 'react'
import { Button, TextField } from '@mui/material'
import type { ExtraConfig } from '../../../shared/config'

interface SettingsProps {
  setSettings: (key: keyof ExtraConfig, value: unknown) => void,
  setOpenStream: React.Dispatch<React.SetStateAction<boolean>>
}

type StreamForm = Record<keyof Stream, string>

function MostStream({ setSettings, setOpenStream }: SettingsProps) {
  const [stream, setStream] = useState<StreamForm>({
    fBlockID: '-1',
    instanceID: '-1',
    sinkNr: '-1',
    sourceAddrHigh: '-1',
    sourceAddrLow: '-1'
  })

  const updateStream = (key: keyof Stream, value: string) => {
    setStream((prevState) => ({ ...prevState, [key]: value }))
  }

  const handleSave = () => {
    const parsedNumeric: Stream = {
      fBlockID: parseInt(stream.fBlockID, 10),
      instanceID: parseInt(stream.instanceID, 10),
      sinkNr: parseInt(stream.sinkNr, 10),
      sourceAddrHigh: parseInt(stream.sourceAddrHigh, 10),
      sourceAddrLow: parseInt(stream.sourceAddrLow, 10)
    }
    setSettings('most', {stream: {...parsedNumeric}})
    setSettings('piMost', true)
    setOpenStream(false)
  }

  return (
    <Grid spacing={2} container sx={{ marginTop: '5%' }}>
      <Grid xs={4}>
        <TextField
          label={'FBLOCK-ID'}
          value={stream.fBlockID}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            updateStream('fBlockID', event.target.value)
          }}
          error={!Number.isFinite(parseInt(stream.fBlockID, 10))}
          helperText={Number.isFinite(parseInt(stream.fBlockID, 10)) ? '' : 'Format must be in hex'}
        />
      </Grid>
      <Grid xs={4}>
        <TextField
          label={'INSTANCE-ID'}
          value={stream.instanceID}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            updateStream('instanceID', event.target.value)
          }}
          error={!Number.isFinite(parseInt(stream.instanceID, 10))}
          helperText={Number.isFinite(parseInt(stream.instanceID, 10)) ? '' : 'Format must be in hex'}
        />
      </Grid>
      <Grid xs={4}>
        <TextField
          label={'SINK NUMBER'}
          value={stream.sinkNr}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            updateStream('sinkNr', event.target.value)
          }}
          error={!Number.isFinite(parseInt(stream.sinkNr, 10))}
          helperText={Number.isFinite(parseInt(stream.sinkNr, 10)) ? '' : 'Format must be in hex'}
        />
      </Grid>
      <Grid xs={6}>
        <TextField
          label={'SOURCE ADDRESS HIGH'}
          value={stream.sourceAddrHigh}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            updateStream('sourceAddrHigh', event.target.value)
          }}
          error={!Number.isFinite(parseInt(stream.sourceAddrHigh, 10))}
          helperText={Number.isFinite(parseInt(stream.sourceAddrHigh, 10)) ? '' : 'Format must be in hex'}
        />
      </Grid>
      <Grid xs={6}>
        <TextField
          label={'SOURCE ADDRESS LOW'}
          value={stream.sourceAddrLow}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            updateStream('sourceAddrLow', event.target.value)
          }}
          error={!Number.isFinite(parseInt(stream.sourceAddrLow, 10))}
          helperText={Number.isFinite(parseInt(stream.sourceAddrLow, 10)) ? '' : 'Format must be in hex'}
        />
      </Grid>
      <Grid xs={12}>
        <Button
          disabled={
            !(
              parseInt(stream.fBlockID, 10) > -1 &&
              parseInt(stream.instanceID, 10) > -1 &&
              parseInt(stream.sinkNr, 10) > -1 &&
              parseInt(stream.sourceAddrHigh, 10) > -1 &&
              parseInt(stream.sourceAddrLow, 10) > -1
            )
          }
          onClick={() => handleSave()}
        >
          SAVE
        </Button>
      </Grid>
    </Grid>
  )
}

export default MostStream
