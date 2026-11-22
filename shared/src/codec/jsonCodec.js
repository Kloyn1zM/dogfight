import { PROTOCOL_VERSION } from '../sim/constants.js'
import { normalizeInput } from '../sim/physics.js'

export const jsonCodec = {
  name: 'json',
  isBinary: false,

  encodeInput(input) {
    return JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'input',
      seq: input.seq,
      tick: input.tick,
      turn: input.turn,
      thrust: Boolean(input.thrust),
      fire: Boolean(input.fire),
      fireHoming: Boolean(input.fireHoming),
    })
  },

  decodeInput(raw) {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!obj || obj.v !== PROTOCOL_VERSION || obj.type !== 'input') {
      throw new RangeError('Invalid JSON input packet')
    }
    return normalizeInput(obj)
  },

  encodeSnapshot(snapshot) {
    return JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'snapshot',
      tick: snapshot.tick,
      lastProcessedSeq: snapshot.lastProcessedSeq,
      matchTimeMs: snapshot.matchTimeMs,
      entities: snapshot.entities,
    })
  },

  decodeSnapshot(raw) {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!obj || obj.v !== PROTOCOL_VERSION || obj.type !== 'snapshot') {
      throw new RangeError('Invalid JSON snapshot packet')
    }
    return {
      tick: obj.tick,
      lastProcessedSeq: obj.lastProcessedSeq,
      matchTimeMs: obj.matchTimeMs,
      entities: obj.entities,
    }
  },
}
