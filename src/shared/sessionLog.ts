export type SessionLogEvent =
  | 'runtime.initialized'
  | 'runtime.config_changed'
  | 'runtime.renderer_attached'
  | 'runtime.renderer_destroyed'
  | 'runtime.command_queued'
  | 'runtime.command_dispatched'
  | 'runtime.command_deferred'
  | 'runtime.adapter_ready'
  | 'runtime.adapter_event'
  | 'runtime.status_changed'
  | 'adapter.ready'
  | 'adapter.command_received'
  | 'adapter.command_accepted'
  | 'adapter.command_rejected'
  | 'adapter.dongle_search_started'
  | 'adapter.dongle_found'
  | 'adapter.dongle_not_found'
  | 'adapter.usb_open_started'
  | 'adapter.usb_open_dispatched'
  | 'adapter.usb_open_completed'
  | 'adapter.waiting_for_phone'
  | 'adapter.phone_connected'
  | 'adapter.phone_disconnected'
  | 'adapter.session_stopped'
  | 'adapter.session_error'
  | 'adapter.camera_visibility_changed'

export type SessionLogDetails = Record<string, unknown>

const now = () => Date.now()

export const logSessionEvent = (
  source: 'runtime' | 'adapter',
  event: SessionLogEvent,
  details: SessionLogDetails = {}
) => {
  const timestamp = now()
  console.info('[carplay-session]', {
    source,
    event,
    timestamp,
    ...details
  })
}
