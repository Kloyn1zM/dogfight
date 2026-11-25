import { Worker } from 'node:worker_threads'
import {
  MatchWorld,
  TICK_DT,
  asEntityId,
  asSeq,
  binaryCodec,
  createReusableSnapshotBuffer,
  decodeSnapshotBinaryInto,
  type EntityId,
  type InputCommand,
} from '@dogfight/shared'

type StepInput = Pick<InputCommand, 'turn' | 'thrust' | 'fire' | 'fireHoming'>

function buildBinarySnapshot(shipCount: number, asteroids: number): {
  bytes: Uint8Array
  entityCount: number
} {
  const world = new MatchWorld({ seed: 2026, targetAsteroids: asteroids })
  const inputs = new Map<EntityId, StepInput>()
  for (let i = 1; i <= shipCount; i += 1) {
    const id = asEntityId(i)
    world.addShip(id)
    inputs.set(id, {
      turn: i % 2 === 0 ? 1 : -1,
      thrust: true,
      fire: true,
      fireHoming: i % 4 === 0,
    })
  }
  for (let t = 0; t < 45; t += 1) {
    world.step(TICK_DT, inputs)
  }
  const snap = world.getSnapshot(asSeq(45))
  const raw = binaryCodec.encodeSnapshot(snap)
  if (!(raw instanceof ArrayBuffer)) {
    throw new Error('Expected ArrayBuffer from binaryCodec')
  }
  return { bytes: new Uint8Array(raw), entityCount: snap.entities.length }
}

const WORKER_SCRIPT = `
const { parentPort } = require('node:worker_threads');

parentPort.on('message', (buf) => {
  const view = new DataView(buf);
  const count = view.getUint16(14, true);
  const tick = view.getUint32(2, true);
  const lastProcessedSeq = view.getUint32(6, true);
  const matchTimeMs = view.getUint32(10, true);
  const entities = new Array(count);
  let offset = 16;
  for (let i = 0; i < count; i += 1) {
    const id = view.getUint16(offset, true);
    const kindCode = view.getUint8(offset + 2);
    const flags = view.getUint8(offset + 3);
    const x = view.getFloat32(offset + 4, true);
    const y = view.getFloat32(offset + 8, true);
    const vx = view.getFloat32(offset + 12, true);
    const vy = view.getFloat32(offset + 16, true);
    const angle = view.getInt16(offset + 20, true) / 1000;
    const metaA = view.getUint16(offset + 22, true);
    const metaB = view.getUint16(offset + 24, true);
    entities[i] = { id, kindCode, flags, x, y, vx, vy, angle, metaA, metaB };
    offset += 26;
  }
  parentPort.postMessage({ tick, lastProcessedSeq, matchTimeMs, entities });
});
`

async function benchScenario(
  label: string,
  shipCount: number,
  asteroids: number,
  iterations: number,
) {
  const { bytes, entityCount } = buildBinarySnapshot(shipCount, asteroids)
  const pooledBuf = createReusableSnapshotBuffer()

  // Warmup main-thread pooled decode
  for (let i = 0; i < 50; i += 1) {
    decodeSnapshotBinaryInto(bytes.buffer, pooledBuf)
  }

  const tMain0 = performance.now()
  for (let i = 0; i < iterations; i += 1) {
    decodeSnapshotBinaryInto(bytes.buffer, pooledBuf)
  }
  const mainTotalMs = performance.now() - tMain0
  const mainAvgUs = (mainTotalMs * 1000) / iterations

  // Worker thread with Transferable ArrayBuffer + structured clone return
  const worker = new Worker(WORKER_SCRIPT, { eval: true })

  const sendOnce = (): Promise<{ mainPostUs: number; rttUs: number }> =>
    new Promise((resolve, reject) => {
      const copy = bytes.slice().buffer
      const t0 = performance.now()
      const onMsg = () => {
        const t2 = performance.now()
        worker.off('error', onErr)
        resolve({ mainPostUs: (t1 - t0) * 1000, rttUs: (t2 - t0) * 1000 })
      }
      const onErr = (err: Error) => {
        worker.off('message', onMsg)
        reject(err)
      }
      worker.once('message', onMsg)
      worker.once('error', onErr)
      worker.postMessage(copy, [copy])
      const t1 = performance.now()
    })

  // Warmup worker
  for (let i = 0; i < 20; i += 1) {
    await sendOnce()
  }

  let postSumUs = 0
  let rttSumUs = 0
  for (let i = 0; i < iterations; i += 1) {
    const res = await sendOnce()
    postSumUs += res.mainPostUs
    rttSumUs += res.rttUs
  }

  await worker.terminate()

  const workerPostUs = postSumUs / iterations
  const workerRttUs = rttSumUs / iterations

  return {
    scenario: label,
    entities: entityCount,
    bytes: bytes.byteLength,
    mainPooledDecodeUs: Number(mainAvgUs.toFixed(2)),
    workerPostUs: Number(workerPostUs.toFixed(2)),
    workerRttUs: Number(workerRttUs.toFixed(2)),
    verdict:
      workerRttUs < mainAvgUs ? 'Worker faster' : 'Main thread faster',
  }
}

console.log(
  '=== Web Worker Experiment: Pooled Main-Thread Decode vs Transferable Worker ===',
)
const rows = [
  await benchScenario('8 bots (typical match)', 9, 8, 300),
  await benchScenario('32 ships (heavy match)', 32, 24, 300),
  await benchScenario('128 ships (extreme stress)', 128, 60, 200),
]
console.table(rows)
