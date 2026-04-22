import { RingBuffer } from 'ringbuf.js'

const DEFAULT_BUFFER_SECONDS = 1
const WORKLET_URL = '/audio.worklet.js'

export class PcmPlayer {
  constructor(frequency, channels) {
    this.frequency = frequency
    this.channels = channels
    this.context = null
    this.gainNode = null
    this.workletNode = null
    this.startPromise = null
    this.pendingVolume = { value: 1, duration: 0 }
    this.sab = RingBuffer.getStorageForCapacity(
      Math.max(128 * channels, Math.ceil(frequency * channels * DEFAULT_BUFFER_SECONDS)),
      Int16Array
    )
  }

  async start() {
    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = this.initAudio()
    return this.startPromise
  }

  async initAudio() {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext
    this.context = new AudioContextCtor({
      sampleRate: this.frequency
    })

    await this.context.audioWorklet.addModule(WORKLET_URL)

    this.gainNode = this.context.createGain()
    this.workletNode = new AudioWorkletNode(this.context, 'pcm-worklet-processor', {
      outputChannelCount: [this.channels],
      processorOptions: {
        sab: this.sab,
        channels: this.channels
      }
    })

    this.workletNode.connect(this.gainNode)
    this.gainNode.connect(this.context.destination)
    this.volume(this.pendingVolume.value, this.pendingVolume.duration)

    if (this.context.state === 'suspended') {
      await this.context.resume()
    }
  }

  stop() {
    this.workletNode?.disconnect()
    this.gainNode?.disconnect()
    this.context?.close()
    this.workletNode = null
    this.gainNode = null
    this.context = null
    this.startPromise = null
  }

  volume(value, duration = 0) {
    this.pendingVolume = { value, duration }

    if (!this.gainNode || !this.context) {
      return
    }

    const now = this.context.currentTime
    this.gainNode.gain.cancelScheduledValues(now)

    if (duration > 0) {
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now)
      this.gainNode.gain.linearRampToValueAtTime(value, now + duration / 1000)
    } else {
      this.gainNode.gain.setValueAtTime(value, now)
    }
  }
}
