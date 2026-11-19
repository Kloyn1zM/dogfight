/**
 * Менеджер Web Audio API.
 * - AudioContext створюється і декодує буфери під час екрану завантаження.
 * - Розблоковується (resume) після першого кліку користувача (кнопка «Приєднатися»).
 * - Підписується на EventTarget-шину World — симуляція нічого не знає про звук.
 */
export function createAudioManager() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext
  const ctx = new AudioCtx()
  let buffers = {}
  let muted = false

  async function unlock() {
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }
  }

  function setBuffers(decodedSounds) {
    buffers = decodedSounds || {}
  }

  function play(name, { volume = 0.45, playbackRate = 1 } = {}) {
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

  function attachWorld(world) {
    const onFired = (e) => {
      const homing = Boolean(e.detail?.homing)
      play('shoot', {
        volume: homing ? 0.55 : 0.35,
        playbackRate: homing ? 0.72 : 1 + (Math.random() - 0.5) * 0.12,
      })
    }
    const onHit = () => {
      play('hit', { volume: 0.45 })
    }
    const onExploded = (e) => {
      const big = Boolean(e.detail?.big)
      play('explosion', {
        volume: big ? 0.65 : 0.45,
        playbackRate: big ? 0.8 : 1.1,
      })
    }
    const onPickup = () => {
      play('shoot', { volume: 0.4, playbackRate: 1.55 })
    }

    world.events.addEventListener('fired', onFired)
    world.events.addEventListener('hit', onHit)
    world.events.addEventListener('exploded', onExploded)
    world.events.addEventListener('pickup', onPickup)

    return () => {
      world.events.removeEventListener('fired', onFired)
      world.events.removeEventListener('hit', onHit)
      world.events.removeEventListener('exploded', onExploded)
      world.events.removeEventListener('pickup', onPickup)
    }
  }

  return {
    ctx,
    unlock,
    setBuffers,
    play,
    attachWorld,
    toggleMute() {
      muted = !muted
      return muted
    },
    isMuted: () => muted,
  }
}
