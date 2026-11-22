import {
  MatchWorld,
  TICK_DT,
  TICK_RATE,
  binaryCodec,
  jsonCodec,
} from '@dogfight/shared'

// Симулюємо реалістичний матч на 4 гравців + астероїди + кулі
const world = new MatchWorld({ seed: 2026, targetAsteroids: 6 })
for (let id = 1; id <= 4; id += 1) {
  world.addShip(id)
}

const inputs = new Map([
  [1, { turn: 1, thrust: true, fire: true, fireHoming: false }],
  [2, { turn: -1, thrust: true, fire: true, fireHoming: false }],
  [3, { turn: 0, thrust: true, fire: true, fireHoming: true }],
  [4, { turn: 1, thrust: false, fire: true, fireHoming: false }],
])

for (let i = 0; i < 45; i += 1) {
  world.step(TICK_DT, inputs)
}

const snapshot = world.getSnapshot(45)
const sampleInput = {
  seq: 45,
  tick: 45,
  turn: 1,
  thrust: true,
  fire: true,
  fireHoming: false,
}

const ITERATIONS = 10000

function bench(codec) {
  // Прогрів JIT
  for (let i = 0; i < 1000; i += 1) {
    codec.decodeSnapshot(codec.encodeSnapshot(snapshot))
    codec.decodeInput(codec.encodeInput(sampleInput))
  }

  const encodedSnap = codec.encodeSnapshot(snapshot)
  const encodedInp = codec.encodeInput(sampleInput)
  const snapBytes =
    typeof encodedSnap === 'string'
      ? Buffer.byteLength(encodedSnap, 'utf8')
      : encodedSnap.byteLength
  const inpBytes =
    typeof encodedInp === 'string'
      ? Buffer.byteLength(encodedInp, 'utf8')
      : encodedInp.byteLength

  const t0 = performance.now()
  for (let i = 0; i < ITERATIONS; i += 1) {
    codec.decodeSnapshot(codec.encodeSnapshot(snapshot))
  }
  const totalMs = performance.now() - t0
  const avgUs = (totalMs * 1000) / ITERATIONS

  return {
    codec: codec.name,
    entities: snapshot.entities.length,
    bytesPerSnapshot: snapBytes,
    downKBpsAt30Hz: Number(((snapBytes * TICK_RATE) / 1024).toFixed(2)),
    upKBpsAt30Hz: Number(((inpBytes * TICK_RATE) / 1024).toFixed(2)),
    encodeDecodeUs: Number(avgUs.toFixed(2)),
  }
}

const rows = [bench(jsonCodec), bench(binaryCodec)]
console.table(rows)
const ratio = (rows[0].bytesPerSnapshot / rows[1].bytesPerSnapshot).toFixed(2)
console.log(`Binary is ${ratio}x smaller per snapshot than JSON.`)
