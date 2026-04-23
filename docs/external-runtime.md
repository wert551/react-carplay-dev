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

## Native Runtime Service

The probe has been promoted into a small native runtime service for the next Qt integration phase:

```sh
npm run native:runtime
```

Or start the service and immediately request a session:

```sh
npm run native:runtime:auto
```

Control it from another terminal:

```sh
npm run native:control -- getStatus
npm run native:control -- startSession
npm run native:control -- stopSession
npm run native:control -- restartSession
npm run native:control -- showCamera true
npm run native:control -- setConfig '{"startMode":"manual"}'
```

The service listens on `127.0.0.1:4100` by default. Override with `CARPLAY_NATIVE_HOST` and `CARPLAY_NATIVE_PORT`.

Supported request events:

- `getConfig`
- `setConfig`
- `validateConfig`
- `getStatus`
- `startSession`
- `stopSession`
- `restartSession`
- `showCamera`

Published events:

- `config`
- `status`
- `sessionEvent`
- `runtimeMessage`

Important environment variables:

- `CARPLAY_NATIVE_CONFIG=/path/to/config.json`: Config file path. Defaults to `~/.config/react-carplay/config.json`.
- `CARPLAY_NATIVE_HOST=127.0.0.1`: Local bind host. Keep this loopback-only for in-car use unless you intentionally expose it.
- `CARPLAY_NATIVE_PORT=4100`: Shared local service port for HTTP, WebSocket, and Socket.IO.
- `CARPLAY_NATIVE_AUTOSTART=1`: Start a session when the service boots.
- `CARPLAY_NATIVE_START_RETRIES=2`: Retry startup after recoverable reset/re-enumeration failures.
- `CARPLAY_NATIVE_REDISCOVERY_TIMEOUT_MS=30000`: Maximum time to wait for dongle re-enumeration.
- `CARPLAY_NATIVE_STOP_RESET_TIMEOUT_MS=2500`: Reset timeout used during shutdown to settle pending USB transfers.
- `CARPLAY_NATIVE_CLOSE_TIMEOUT_MS=1000`: Close timeout used during shutdown after reset.

### Qt-Friendly HTTP API

The native service also exposes ordinary local HTTP endpoints on the same host and port:

```text
http://127.0.0.1:4100
```

Endpoints:

- `GET /status`
- `GET /config`
- `POST /start`
- `POST /stop`
- `POST /restart`
- `POST /camera`
- `POST /config`

Examples:

```sh
curl http://127.0.0.1:4100/status
curl http://127.0.0.1:4100/config
curl -X POST http://127.0.0.1:4100/start
curl -X POST http://127.0.0.1:4100/stop
curl -X POST http://127.0.0.1:4100/restart
curl -X POST http://127.0.0.1:4100/camera \
  -H 'Content-Type: application/json' \
  -d '{"visible":true}'
curl -X POST http://127.0.0.1:4100/config \
  -H 'Content-Type: application/json' \
  -d '{"startMode":"manual","runtimeEngine":"external"}'
```

Successful responses return the current resource directly. For example, `GET /status` and `POST /start` return a status object:

```json
{
  "desiredSession": "running",
  "session": "waiting_for_phone",
  "isPlugged": false,
  "deviceFound": true,
  "receivingVideo": false,
  "cameraVisible": false,
  "lastError": null,
  "metadata": {
    "runtimeEngine": "native-node",
    "configPath": "/home/pi/.config/react-carplay/config.json",
    "port": 4100
  },
  "messageCounts": {
    "audio": 0,
    "video": 0,
    "media": 0,
    "command": 0,
    "nativeMessage": 0
  }
}
```

`GET /config` and `POST /config` return the active config JSON. Errors return HTTP `400` with:

```json
{
  "error": "config must be an object"
}
```

### Qt-Friendly WebSocket Events

Plain WebSocket clients can subscribe to pushed updates at:

```text
ws://127.0.0.1:4100/events
```

Each pushed frame is JSON:

```json
{
  "type": "status",
  "timestamp": "2026-04-22T12:00:00.000Z",
  "data": {
    "session": "connected",
    "desiredSession": "running",
    "isPlugged": true,
    "deviceFound": true
  }
}
```

Event `type` values:

- `hello`: Initial snapshot containing `status` and `config`.
- `status`: Full status object.
- `config`: Full config object.
- `sessionEvent`: Structured lifecycle/log event.
- `runtimeMessage`: Summarized native `command`, `media`, `audio`, or `video` message.

Example `sessionEvent`:

```json
{
  "type": "sessionEvent",
  "timestamp": "2026-04-22T12:00:01.000Z",
  "data": {
    "timestamp": "2026-04-22T12:00:01.000Z",
    "event": "phoneConnected"
  }
}
```

Example `runtimeMessage`:

```json
{
  "type": "runtimeMessage",
  "timestamp": "2026-04-22T12:00:02.000Z",
  "data": {
    "type": "audio",
    "message": {
      "type": "AudioData",
      "byteLength": 4096
    }
  }
}
```

### Native Startup Patch

The native service uses the same patched startup path proven by the probe:

1. Find the dongle.
2. Open it only for reset.
3. Call `WebUSBDevice.reset()`.
4. Treat `LIBUSB_ERROR_NOT_FOUND` / device disappearance during reset as expected on Raspberry Pi.
5. Drop the stale handle.
6. Wait for the dongle to re-enumerate.
7. Reacquire and reopen the fresh WebUSB device.
8. Call `carplay.dongleDriver.initialise(device)`.
9. Call `carplay.dongleDriver.start(config)`.

This keeps the patch local to this repo for now instead of editing `node_modules`.

### Native Shutdown Patch

Upstream `CarplayNode.stop()` calls through to `DongleDriver.close()`, which can throw on Raspberry Pi with:

```text
Can't close device with a pending request
```

That happens because `DongleDriver` has an active `transferIn` read loop. The native service does not treat that close path as authoritative. During `stopSession` it:

1. Clears the CarPlay pair timer, frame interval, and dongle heartbeat interval.
2. Detaches the driver from its active device/endpoints so no new writes are issued through stale state.
3. Resets the active WebUSB device to settle or abort pending USB transfers.
4. Attempts a bounded close.
5. Treats a pending-request close failure as `usbCloseDeferred`, not as `sessionError`.
6. Drops stale references and emits `sessionStopped`.

This makes service-level stop deterministic even while the underlying WebUSB close implementation is imperfect. The dongle may re-enumerate after stop, which is expected.

### Native Message Inventory

The native path currently exposes these `node-carplay/node` messages through `runtimeMessage` and structured logs:

- `command`: CarPlay command messages from the dongle/session.
- `media`: Media metadata/state messages.
- `audio`: PCM audio payload metadata; the service summarizes payloads and does not route audio yet.
- `video`: H.264 video payload metadata; the service marks `receivingVideo` and summarizes payloads but does not transport/render video yet.
- `plugged` / `unplugged`: Mapped to `phoneConnected` / `phoneDisconnected`.
- `failure`: Mapped to `sessionError`.

What still needs a Qt-facing contract:

- Video transport from native runtime to Qt/native renderer.
- Audio output routing from native runtime to ALSA/Pulse/PipeWire/MOST or Qt.
- Microphone input policy and injection.
- Touch and key command injection into `dongleDriver.send(...)`.

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
