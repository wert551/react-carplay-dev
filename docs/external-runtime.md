# External Runtime Boundary

The Raspberry Pi runtime has proven that the dongle and iPhone session can connect successfully through the current React-CarPlay code path. The Electron/Chromium display path has not proven suitable as the final in-car renderer: Pi testing shows `dma_buf` export failures, `ReadPixels` stalls, GPU process instability, and unacceptable choppiness even in the GPU-disabled fallback profile.

Treat this repo as a stable CarPlay session/control reference and external runtime boundary. Keep the Electron app runnable for development and debugging, but do not treat the current Chromium renderer as the production display target for the car.

## Reusable Pieces

- `src/shared/config.ts`: Central config shape, validation, startup mode, shell mode, runtime engine mode, renderer/debug fields, key bindings, camera, microphone, MOST, and CAN settings.
- `src/main/ConfigStore.ts`: JSON-backed config persistence in Electron user data. The schema and validation are reusable even if persistence later moves into Qt.
- `src/shared/control.ts`: Runtime control API, session states, desired session state, command model, status model, and structured session adapter events.
- `src/main/RuntimeControl.ts`: Authoritative desired/actual session state machine, command queueing, command dispatch, adapter-ready handling, and structured status updates.
- `src/main/Socket.ts`: Current external Socket.IO bridge on port `4000` for config, status, commands, and session events.
- `src/shared/sessionLog.ts`: Developer-oriented session timing/status logging.
- `src/main/Canbus.ts`, `src/main/PiMost.ts`, `src/main/Socket.ts`: Useful references for wiring vehicle/reverse/lights/MOST state into the runtime status model.
- The observed browser/WebUSB flow in `src/renderer/src/session/useCarplaySessionAdapter.ts` and `src/renderer/src/components/worker/CarPlay.worker.ts`: Useful as a behavioral reference for dongle search, dongle found, waiting for phone, phone connected, stop/restart, touch, frame, audio, and key command sequencing.

## Electron/Chromium-Specific Pieces

- `src/renderer/src/session/useCarplaySessionAdapter.ts`: Browser/WebUSB adapter. It depends on `navigator.usb`, React lifecycle, renderer workers, browser `MessageChannel`, and Chromium runtime behavior.
- `src/renderer/src/components/worker/CarPlay.worker.ts`: Active browser session executor. It uses `node-carplay/web`, `findDevice`, WebUSB-oriented device access, worker messaging, and browser transferables.
- `src/renderer/src/components/worker/render/*`: Chromium display path. It depends on WebCodecs, `VideoDecoder`, `VideoFrame`, `OffscreenCanvas`, WebGL/WebGL2/WebGPU, and Chromium GPU/compositor behavior.
- `src/renderer/src/components/useCarplayAudio.ts`: Browser audio path. It uses browser media devices, `WebMicrophone`, `MessagePort`, SharedArrayBuffer/ring buffers, and PCM playback in the renderer.
- `src/preload/index.ts` and Electron IPC handlers in `src/main/index.ts`: Standalone Electron shell integration. Useful for debugging, not a final Qt production boundary.
- React settings/admin UI under `src/renderer/src/components/Settings.tsx` and related components: Debug/admin fallback only. The Qt app should own normal settings UX.

## External Control Surface

The current external bridge is Socket.IO on `localhost:4000`. It is intentionally simple and suitable as a reference contract for a future IPC, local HTTP, WebSocket, or native bridge.

Control requests:

- `getConfig`
- `setConfig`
- `validateConfig`
- `getStatus`
- `setStatus`
- `startSession`
- `stopSession`
- `restartSession`
- `showCamera`
- `sessionAdapterReady`
- `reportSessionEvent`

Published updates:

- `config`
- `settings`
- `status`
- `controlCommand`
- `reverse`
- `lights`

Runtime adapter events reported through `reportSessionEvent`:

- `adapterReady`
- `commandAccepted`
- `commandRejected`
- `waitingForDongle`
- `dongleFound`
- `waitingForPhone`
- `phoneConnected`
- `phoneDisconnected`
- `sessionStopped`
- `sessionError`
- `cameraVisibilityChanged`

The command/event flow should stay one directional:

1. Qt or another host calls `startSession`, `stopSession`, `restartSession`, or `showCamera`.
2. `RuntimeControl` updates desired/actual state and emits `controlCommand`.
3. A session adapter/runtime process accepts or rejects the command with `reportSessionEvent`.
4. The adapter/runtime reports lifecycle events back to `RuntimeControl`.
5. Qt subscribes to `status` updates and renders its own UX.

## Recommended Qt/Native Direction

The Qt app should own:

- All normal settings UI.
- Start/stop/restart policy.
- Which page is visible and when CarPlay should run.
- Reverse camera UX.
- Final video presentation.
- Final audio routing and microphone capture policy.

The next runtime step should be a separate CarPlay runtime process or service that owns USB/session work outside Chromium. It should reuse the existing `RuntimeControl` contract but replace the active renderer/WebUSB executor with a native or Node-backed adapter.

Minimum practical target:

- A Node/native or other native service opens the dongle, drives the CarPlay session, and maps session messages into `SessionAdapterEvent`.
- Qt calls the same control methods: `getConfig`, `setConfig`, `getStatus`, `startSession`, `stopSession`, `restartSession`, and `showCamera`.
- Qt receives structured status/session updates.
- Qt receives or owns a native-friendly video/audio transport rather than relying on Chromium WebCodecs/WebGL.

## Known Blockers To Reusing The Current Session Executor

- The working executor is currently browser/WebUSB-based, so it cannot run inside Qt WebEngine because `navigator.usb` is missing.
- The working video presentation path is Chromium-specific and has shown unacceptable Pi GPU/compositor behavior.
- The current audio/microphone path is browser-specific and should be replaced or bridged for a native Qt deployment.
- A true non-Chromium runtime requires verifying the installed `node-carplay/node` API on the Pi. This repo imports `node-carplay/node` for `DEFAULT_CONFIG`, and the dependency tree includes native `usb`, but the active session implementation still uses `node-carplay/web`.
- There is no native video/audio transport contract yet. The current control/status contract is ready; the media transport contract is the next missing boundary.

## Headless Native Runtime Probe

Use the Node probe to test whether the installed `node-carplay/node` entry point can drive a CarPlay session outside Electron, Chromium, WebUSB, WebCodecs, and WebGL:

```sh
npm run probe:node-runtime
```

Optional environment variables:

- `CARPLAY_PROBE_TIMEOUT_MS=120000`: Stop the probe automatically after two minutes.
- `CARPLAY_PROBE_CONFIG=/path/to/config.json`: Overlay a specific JSON config file on top of `node-carplay/node`'s `DEFAULT_CONFIG`.
- `CARPLAY_PROBE_NATIVE_START_MODE=patched`: Use the local probe wrapper that resets, drops the stale handle, rediscovers, reopens, then starts `DongleDriver` directly. This is the default.
- `CARPLAY_PROBE_NATIVE_START_MODE=upstream`: Use `CarplayNode.start()` exactly as exported by `node-carplay/node` for comparison.
- `CARPLAY_PROBE_START_RETRIES=2`: Retry native startup after a reset/re-enumeration failure.
- `CARPLAY_PROBE_REDISCOVERY_TIMEOUT_MS=15000`: Maximum time to wait for the dongle to reappear after reset.
- `CARPLAY_PROBE_POLL_INTERVAL_MS=1000`: Dongle polling interval.
- `CARPLAY_PROBE_RESET_SETTLE_MS=500`: Short delay after reset before rediscovery starts.
- `CARPLAY_PROBE_WIFI_PAIR_DELAY_MS=15000`: Delay before sending the fallback `wifiPair` command.

The probe logs JSON lines with lifecycle names that match the runtime session model:

- `waitingForDongle`
- `dongleFound`
- `waitingForPhone`
- `resetStarted`
- `resetLostDevice`
- `dongleRediscovered`
- `deviceReopened`
- `startRetried`
- `phoneConnected`
- `phoneDisconnected`
- `sessionStopped`
- `sessionError`

Interpretation:

- If it reaches `dongleFound`, native USB enumeration is working outside Chromium.
- If it reaches `phoneConnected`, a non-browser session runtime is viable enough to become the next external runtime-service candidate.
- The locked dependency currently resolves to `rhysmorgan134/node-CarPlay` commit `25fb26a33db033b60f6f9dd5e7fac82ab5a53f5c`. In that source, `src/node/CarplayNode.ts` has the brittle reset path inside `CarplayNode.start()`: it opens the first WebUSB device, calls `device.reset()`, then only afterwards tries to close and rediscover. On Raspberry Pi, `WebUSBDevice.reset()` can throw `LIBUSB_ERROR_NOT_FOUND` because the reset itself made the dongle disappear, so the upstream method never reaches its rediscovery code.
- In the default `patched` mode, the probe avoids `CarplayNode.start()` and performs the missing recovery locally: reset, discard stale handle, wait for USB re-enumeration, reacquire a fresh WebUSB device, reopen it, then call `carplay.dongleDriver.initialise(device)` and `carplay.dongleDriver.start(config)`.
- If the patched path reaches `deviceReopened` and then `phoneConnected`, the stale-handle/reset blocker is solved well enough to build a real native runtime service.
- If the patched path reaches `deviceReopened` but fails during `dongleDriver.initialise()` or `dongleDriver.start()`, the next patch point is lower in `src/modules/DongleDriver.ts`.
- If it logs `sessionError` saying no usable native constructor or no `start()` method exists, the installed `node-carplay/node` package is not currently a complete drop-in runtime and needs a wrapper, patch, or replacement native executor before Qt can control it as the active backend.
- If it can start but media frames/audio are not exposed in a native-friendly way, session ownership may be viable while video/audio transport remains the next missing contract.

## Suggested Config For Qt-Oriented Runs

Use the centralized config API to set:

```json
{
  "startMode": "manual",
  "shellMode": "hosted",
  "runtimeEngine": "external",
  "showDebugSettings": false
}
```

For now, Electron remains useful as:

- A known-good dongle/session reference.
- A config/control/status server prototype.
- A debug/admin shell.
- A behavioral reference for the external runtime adapter that should replace the Chromium/WebUSB session executor.
