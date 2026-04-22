# External Runtime Architecture Notes

Qt WebEngine on Raspberry Pi does not expose `navigator.usb`, so the hosted renderer cannot be the active CarPlay USB engine. The hosted page should be treated as a display/control surface only.

## Current Engine Modes

`runtimeEngine` in `config.json` selects the runtime executor:

- `browser-webusb`: existing standalone Electron/browser path. The renderer starts the WebUSB session adapter and uses `node-carplay/web`.
- `external`: hosted/Qt-oriented path. The renderer does not start the WebUSB adapter. A separate runtime process is expected to connect to the control bridge, execute USB/session work, and report session events.

Standalone defaults stay conservative:

```json
{
  "startMode": "auto",
  "shellMode": "standalone",
  "runtimeEngine": "browser-webusb",
  "showDebugSettings": true
}
```

For a Qt-hosted setup, prefer:

```json
{
  "startMode": "manual",
  "shellMode": "hosted",
  "runtimeEngine": "external",
  "showDebugSettings": false
}
```

## External Runtime Contract

An external runtime can use the existing Socket.IO bridge on port `4000`.

Control requests:

- `getConfig`
- `setConfig`
- `validateConfig`
- `getStatus`
- `startSession`
- `stopSession`
- `restartSession`
- `showCamera`

Runtime adapter lifecycle:

- call `sessionAdapterReady` when the external USB/session engine is ready to receive commands
- listen for `controlCommand`
- acknowledge commands with `reportSessionEvent { type: "commandAccepted", commandId }`
- reject commands with `reportSessionEvent { type: "commandRejected", commandId, error }`
- report lifecycle transitions with `reportSessionEvent`

Important session events:

- `waitingForDongle`
- `dongleFound`
- `waitingForPhone`
- `phoneConnected`
- `phoneDisconnected`
- `sessionStopped`
- `sessionError`
- `cameraVisibilityChanged`

## Native Runtime Feasibility

The dependency tree includes `node-carplay` and the native `usb` package, and the app already imports `node-carplay/node` for `DEFAULT_CONFIG`. That strongly suggests a Node/native runtime is possible in Electron main or a separate Node process.

This pass does not move the active session into Node because the installed dependency source is not present in this workspace, so the exact native video/audio/control API cannot be verified safely. The next implementation pass should inspect `node-carplay/node` locally on the Pi and implement an external runtime process that maps its messages into the event contract above.

## Recommended Qt Integration Shape

Run three conceptual pieces:

- Qt/QML app owns user settings and high-level UX.
- External Node/native CarPlay runtime owns USB/session work and talks to React-CarPlay runtime control over IPC/Socket.IO/local bridge.
- Hosted renderer displays the CarPlay surface and receives status/config through the same control bridge, but does not call WebUSB.

This avoids relying on Qt WebEngine WebUSB support and keeps the renderer embeddable.
