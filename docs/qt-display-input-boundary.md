# Qt Display/Input Boundary

This note documents the Qt-facing display/input boundary. The current service implementation includes safe metadata/input endpoints only. It does not add final CarPlay rendering, does not revive the Electron display path, and does not change the existing control/status API.

## Current Runtime Facts

- The native runtime service in `scripts/native-runtime-service.cjs` owns the USB/session lifecycle and already exposes the working local control surface on `127.0.0.1:4100`.
- `carplay.onmessage` receives native `node-carplay/node` messages. The current service handles `video`, `audio`, `media`, `command`, plug/unplug, and failure messages.
- On `video`, the service sets `receivingVideo: true` and publishes only a summarized `runtimeMessage`. It does not currently forward video bytes to Qt or another renderer.
- The previous renderer worker path shows that `video` payloads contain encoded H.264 access units in `message.message.data` as a `Uint8Array`.
- The previous WebCodecs renderer parsed SPS/PPS/IDR NAL units from that H.264 byte stream and configured a decoder from the SPS. That means the Qt-facing video boundary should preserve the encoded H.264 stream first, not invent a raw-RGBA frame path.

Relevant references:

- `scripts/native-runtime-service.cjs`: native service message handler and status/control API.
- `src/renderer/src/components/worker/CarPlay.worker.ts`: existing browser worker forwards `payload.data` from `type === "video"` into the render worker.
- `src/renderer/src/components/worker/render/Render.worker.ts`: existing renderer decodes H.264 with WebCodecs.
- `src/renderer/src/components/worker/render/lib/utils.ts`: SPS parsing confirms the payload can be treated as H.264 NAL data.
- `src/renderer/src/components/useCarplayTouch.ts`: existing touch normalization behavior.

## Recommended Qt-Facing Boundary

Keep the current HTTP/WebSocket control/status API intact. Add media/input surfaces beside it instead of mixing large binary video data into `/events`.

Recommended next boundary:

- Status/control: keep `GET /status`, `GET /config`, `POST /start`, `POST /stop`, `POST /restart`, `POST /camera`, and `ws://127.0.0.1:4100/events` unchanged.
- Video metadata: add a lightweight JSON endpoint/event that reports stream state, codec, width, height, fps/configured fps, frame count, keyframe count, and last frame time. This is safe before rendering.
- Video transport: add a separate local binary stream carrying encoded H.264 access units, preferably a loopback TCP or Unix domain socket. Each packet should have a tiny fixed header followed by the encoded access unit bytes.
- Input injection: add small HTTP endpoints for touch and key commands, then optionally mirror them on the existing Socket.IO API.

For the Raspberry Pi/Qt target, the lowest-risk first renderer path is encoded H.264 over a local binary socket into Qt/GStreamer or Qt Multimedia, not raw frames:

- It keeps bandwidth and CPU cost much lower than raw RGBA.
- It preserves what `node-carplay` already emits.
- It lets Qt use the Pi's native decode/display stack rather than Chromium/WebCodecs.
- It avoids a fragile shared-memory format before the decoder path is proven.

Defer shared memory until there is a measured reason to move beyond encoded H.264. Defer raw frames unless a native decoder bridge proves impossible.

## Proposed Minimal Interfaces

### Video Metadata

`GET /video/status`

```json
{
  "available": false,
  "codec": "h264",
  "format": null,
  "width": null,
  "height": null,
  "fps": null,
  "totalFrames": 0,
  "keyframeCount": 0,
  "lastFrameAt": null,
  "streamingActive": false,
  "hasSps": false,
  "hasPps": false,
  "lastPayloadBytes": 0,
  "lastNalTypes": [],
  "binaryStreamAvailable": false
}
```

The exact width/height/fps should come from config and/or the first SPS parse. Until that is implemented, report `null` rather than guessing.

After video frames are observed, a response should look more like:

```json
{
  "available": true,
  "codec": "h264",
  "format": "h264-annexb",
  "width": 800,
  "height": 480,
  "fps": 30,
  "totalFrames": 348,
  "keyframeCount": 12,
  "lastFrameAt": 1770000000000,
  "streamingActive": true,
  "hasSps": true,
  "hasPps": true,
  "lastPayloadBytes": 18542,
  "lastNalTypes": [7, 8, 5],
  "binaryStreamAvailable": false
}
```

`binaryStreamAvailable` is deliberately `false` in this phase. This endpoint is diagnostics only.

### Binary H.264 Stream

Use a separate local-only socket, for example `127.0.0.1:4101`.

Packet shape:

```text
u32be magic      "CPV1"
u16be version    1
u16be flags      bit 0 = keyframe, bit 1 = config
u64be pts        monotonic frame counter or timestamp
u32be length     payload byte length
bytes payload    one encoded H.264 access unit from node-carplay
```

The service should forward exactly the current `message.message.data` bytes first. If SPS parsing later proves the data is packetized rather than Annex B for a chosen Qt decoder, add one explicit conversion step in the service and report that in `/video/status.format`.

### Touch Input

`POST /input/touch`

```json
{
  "action": "down",
  "x": 0.5,
  "y": 0.5
}
```

Accepted actions should map to the existing `node-carplay` `TouchAction` values:

- `down`
- `move`
- `up`

Coordinates should remain normalized `0.0..1.0`, matching the existing React hook behavior. Qt should normalize from its CarPlay surface size before sending.

Successful response:

```json
{
  "ok": true,
  "type": "touch",
  "action": "down",
  "x": 0.5,
  "y": 0.5,
  "session": "connected"
}
```

Failure response examples:

```json
{
  "error": "CarPlay input is only accepted while session is connected; current session is idle"
}
```

```json
{
  "error": "node-carplay/node does not expose SendTouch"
}
```

### Key Commands

`POST /input/key`

```json
{
  "command": "home"
}
```

Use the already-proven command names from the worker type:

- `left`
- `right`
- `selectDown`
- `selectUp`
- `back`
- `down`
- `home`
- `play`
- `pause`
- `next`
- `prev`
- `frame`

Service implementation should send these through `new SendCommand(command)` when `node-carplay/node` exposes `SendCommand`.

Successful response:

```json
{
  "ok": true,
  "type": "key",
  "command": "home",
  "session": "connected"
}
```

Failure response example:

```json
{
  "error": "key command must be one of: home, back, left, right, down, selectDown, selectUp, play, pause, next, prev, frame"
}
```

## Pi Shell Test Commands

Start the native runtime service:

```sh
cd ~/react-carplay-dev
npm run native:runtime
```

Or start and autostart the session:

```sh
cd ~/react-carplay-dev
npm run native:runtime:auto
```

Query video diagnostics:

```sh
curl http://127.0.0.1:4100/video/status
```

Send touch input:

```sh
curl -X POST http://127.0.0.1:4100/input/touch \
  -H 'Content-Type: application/json' \
  -d '{"action":"down","x":0.5,"y":0.5}'
curl -X POST http://127.0.0.1:4100/input/touch \
  -H 'Content-Type: application/json' \
  -d '{"action":"up","x":0.5,"y":0.5}'
```

Send key input:

```sh
curl -X POST http://127.0.0.1:4100/input/key \
  -H 'Content-Type: application/json' \
  -d '{"command":"home"}'
curl -X POST http://127.0.0.1:4100/input/key \
  -H 'Content-Type: application/json' \
  -d '{"command":"frame"}'
```

Optional helper script:

```sh
npm run native:io -- videoStatus
npm run native:io -- touch down 0.5 0.5
npm run native:io -- touch up 0.5 0.5
npm run native:io -- key home
```

## Input Hooks That Already Exist

The old browser worker already proves the command objects:

- Touch: `new SendTouch(x, y, action)` then `carplayWeb.dongleDriver.send(data)`.
- Frame request: `new SendCommand("frame")`.
- Key command: `new SendCommand(command)`.
- Microphone/audio input: `new SendAudio(...)`, deliberately out of scope for this display/input pass.

The native service already imports and uses `SendCommand` for `wifiPair`. The next implementation should similarly resolve `SendTouch` and `SendCommand` from `node-carplay/node`, fail cleanly if missing, and expose capability booleans in status or `/video/status`.

## Recommended Next Implementation Step

Do the next phase in this order:

1. Done: add diagnostics only with `GET /video/status`, video byte counters, keyframe counters, SPS/PPS detection, and SPS-derived width/height/fps when available.
2. Done: add `POST /input/touch` and `POST /input/key`, guarded by exported `SendTouch`/`SendCommand` availability and active connected session state.
3. Next: add a local binary H.264 stream on a separate socket and a tiny CLI client that counts packets and writes a short capture file for inspection.
4. After the stream is verified on the Pi, add the Qt-side receiver/decoder surface.

This keeps Qt's current service controls stable while proving each missing display/input boundary separately.
