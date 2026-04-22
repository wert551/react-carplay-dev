import { EventEmitter } from 'events'
import * as fs from 'fs'
import { dirname } from 'path'
import {
  ConfigValidationResult,
  ExtraConfig,
  normalizeConfig,
  validateConfig
} from '../shared/config'

export class ConfigStore extends EventEmitter {
  private config: ExtraConfig | null = null

  constructor(
    private readonly configPath: string,
    private readonly defaults: ExtraConfig
  ) {
    super()
  }

  load(): ExtraConfig {
    fs.mkdirSync(dirname(this.configPath), { recursive: true })

    if (!fs.existsSync(this.configPath)) {
      this.config = this.defaults
      this.persist(this.config)
      return this.config
    }

    try {
      const rawConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf-8')) as Partial<ExtraConfig>
      const validation = validateConfig(rawConfig, this.defaults)
      this.config = validation.config
      this.persist(this.config)
      if (!validation.valid) {
        console.warn('Loaded config with validation warnings', validation.errors)
      }
      return this.config
    } catch (error) {
      console.error('Failed to read config; recreating defaults', error)
      this.config = this.defaults
      this.persist(this.config)
      return this.config
    }
  }

  getConfig(): ExtraConfig {
    return this.config ?? this.load()
  }

  getConfigPath(): string {
    return this.configPath
  }

  validate(candidate: Partial<ExtraConfig>): ConfigValidationResult {
    return validateConfig(candidate, this.defaults)
  }

  setConfig(update: Partial<ExtraConfig>): ExtraConfig {
    const nextConfig = normalizeConfig(
      {
        ...this.getConfig(),
        ...update
      },
      this.defaults
    )
    const validation = validateConfig(nextConfig, this.defaults)

    if (!validation.valid) {
      throw new Error(`Invalid React-CarPlay config: ${validation.errors.join(', ')}`)
    }

    this.config = validation.config
    this.persist(this.config)
    this.emit('configChanged', this.config)
    return this.config
  }

  private persist(config: ExtraConfig): void {
    fs.writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`)
  }
}
