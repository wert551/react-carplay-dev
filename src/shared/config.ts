import type { DongleConfig } from 'node-carplay/node'
import type { Stream } from 'socketmost/dist/modules/Messages'

export type Most = {
  stream?: Stream
}

export interface KeyBindings {
  left: string
  right: string
  selectDown: string
  back: string
  down: string
  home: string
  play: string
  pause: string
  next: string
  prev: string
}

export interface CanMessage {
  canId: number
  byte: number
  mask: number
}

export interface CanConfig {
  reverse?: CanMessage
  lights?: CanMessage
}

export type StartMode = 'auto' | 'manual'
export type ShellMode = 'standalone' | 'hosted'

export type ExtraConfig = DongleConfig & {
  kiosk: boolean
  camera: string
  microphone: string
  piMost: boolean
  canbus: boolean
  startMode: StartMode
  shellMode: ShellMode
  showDebugSettings: boolean
  bindings: KeyBindings
  most?: Most
  canConfig?: CanConfig
}

export type ConfigValidationResult = {
  valid: boolean
  errors: string[]
  config: ExtraConfig
}

export const DEFAULT_BINDINGS: KeyBindings = {
  left: 'ArrowLeft',
  right: 'ArrowRight',
  selectDown: 'Space',
  back: 'Backspace',
  down: 'ArrowDown',
  home: 'KeyH',
  play: 'KeyP',
  pause: 'KeyO',
  next: 'KeyM',
  prev: 'KeyN'
}

export const createDefaultConfig = (dongleDefaults: DongleConfig): ExtraConfig => ({
  ...dongleDefaults,
  kiosk: true,
  camera: '',
  microphone: '',
  piMost: false,
  canbus: false,
  startMode: 'auto',
  shellMode: 'standalone',
  showDebugSettings: true,
  bindings: DEFAULT_BINDINGS,
  most: {},
  canConfig: {}
})

export const normalizeConfig = (
  input: Partial<ExtraConfig> | null | undefined,
  defaults: ExtraConfig
): ExtraConfig => {
  const candidate = input ?? {}

  return {
    ...defaults,
    ...candidate,
    bindings: {
      ...defaults.bindings,
      ...(candidate.bindings ?? {})
    },
    most: {
      ...(defaults.most ?? {}),
      ...(candidate.most ?? {})
    },
    canConfig: {
      ...(defaults.canConfig ?? {}),
      ...(candidate.canConfig ?? {})
    }
  }
}

export const validateConfig = (
  input: Partial<ExtraConfig> | null | undefined,
  defaults: ExtraConfig
): ConfigValidationResult => {
  const config = normalizeConfig(input, defaults)
  const errors: string[] = []

  ;['width', 'height', 'fps', 'dpi', 'mediaDelay'].forEach((key) => {
    const value = (config as Record<string, unknown>)[key]
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
      errors.push(`${key} must be a positive number`)
    }
  })

  ;['kiosk', 'piMost', 'canbus'].forEach((key) => {
    if (typeof (config as Record<string, unknown>)[key] !== 'boolean') {
      errors.push(`${key} must be a boolean`)
    }
  })

  if (!['auto', 'manual'].includes(config.startMode)) {
    errors.push('startMode must be "auto" or "manual"')
  }

  if (!['standalone', 'hosted'].includes(config.shellMode)) {
    errors.push('shellMode must be "standalone" or "hosted"')
  }

  if (typeof config.showDebugSettings !== 'boolean') {
    errors.push('showDebugSettings must be a boolean')
  }

  ;['camera', 'microphone'].forEach((key) => {
    if (typeof (config as Record<string, unknown>)[key] !== 'string') {
      errors.push(`${key} must be a string`)
    }
  })

  Object.entries(config.bindings).forEach(([key, value]) => {
    if (typeof value !== 'string' || value.length === 0) {
      errors.push(`bindings.${key} must be a non-empty key code`)
    }
  })

  return {
    valid: errors.length === 0,
    errors,
    config
  }
}
