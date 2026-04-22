export declare class PcmPlayer {
  readonly sab: SharedArrayBuffer

  constructor(frequency: number, channels: number)

  start(): Promise<void>
  stop(): void
  volume(value: number, duration?: number): void
}
