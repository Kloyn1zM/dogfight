import type { TypedBus } from '@dogfight/shared'
import type { GameEvents } from './net/netWorld.ts'

export interface AudioManager {
  readonly ctx: AudioContext
  unlock(): Promise<void>
  setBuffers(decodedSounds: Readonly<Record<string, AudioBuffer>>): void
  play(name: string, opts?: { volume?: number; playbackRate?: number }): void
  attachBus(bus: TypedBus<GameEvents>): () => void
  toggleMute(): boolean
  isMuted(): boolean
}

export function createAudioManager(): AudioManager {
  const ctx = new AudioContext()
  let buffers: Readonly<Record<string, AudioBuffer>> = {}
  let muted = false

  async function unlock(): Promise<void> {
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }
  }

  function setBuffers(
    decodedSounds: Readonly<Record<string, AudioBuffer>>,
  ): void {
    buffers = decodedSounds
  }

  function play(
    name: string,
    {
      volume = 0.45,
      playbackRate = 1,
    }: { volume?: number; playbackRate?: number } = {},
  ): void {
    if (muted || ctx.state !== 'running') return
    const buffer = buffers[name]
    if (!buffer) return

    const source = ctx.createBufferSource()
    const gain = ctx.createGain()
    source.buffer = buffer
    source.playbackRate.value = playbackRate
    gain.gain.value = volume
    source.connect(gain)
    gain.connect(ctx.destination)
    source.start()
  }

  function attachBus(bus: TypedBus<GameEvents>): () => void {
    const offs = [
      bus.on('fired', ({ homing }) => {
        play('shoot', {
          volume: homing ? 0.55 : 0.35,
          playbackRate: homing ? 0.72 : 1 + (Math.random() - 0.5) * 0.12,
        })
      }),
      bus.on('hit', () => {
        play('hit', { volume: 0.45 })
      }),
      bus.on('exploded', ({ big }) => {
        play('explosion', {
          volume: big ? 0.65 : 0.45,
          playbackRate: big ? 0.8 : 1.1,
        })
      }),
      bus.on('pickup', () => {
        play('shoot', { volume: 0.4, playbackRate: 1.55 })
      }),
    ]
    return () => {
      for (const off of offs) off()
    }
  }

  return {
    ctx,
    unlock,
    setBuffers,
    play,
    attachBus,
    toggleMute() {
      muted = !muted
      return muted
    },
    isMuted: () => muted,
  }
}
