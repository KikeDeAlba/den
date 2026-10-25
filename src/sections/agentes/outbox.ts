export const INPUT_LIMIT = 256 * 1024

export type SendBytes = (id: number, bytes: Uint8Array) => Promise<void>

export interface Outbox {
  push(id: number, bytes: Uint8Array): void
  drop(id: number): void
}

interface Queue {
  parts: Uint8Array[]
  running: boolean
}

function slices(bytes: Uint8Array, limit: number): Uint8Array[] {
  const list: Uint8Array[] = []
  for (let start = 0; start < bytes.length; start += limit) list.push(bytes.subarray(start, start + limit))
  return list
}

function take(parts: Uint8Array[], limit: number): Uint8Array {
  let size = 0
  let count = 0
  for (const part of parts) {
    if (count > 0 && size + part.length > limit) break
    size += part.length
    count += 1
  }
  const batch = new Uint8Array(size)
  let offset = 0
  for (const part of parts.splice(0, count)) {
    batch.set(part, offset)
    offset += part.length
  }
  return batch
}

export function createOutbox(send: SendBytes, limit = INPUT_LIMIT): Outbox {
  const queues = new Map<number, Queue>()

  async function drain(id: number, queue: Queue): Promise<void> {
    queue.running = true
    try {
      while (queue.parts.length > 0) {
        try {
          await send(id, take(queue.parts, limit))
        } catch {
          queue.parts.length = 0
        }
      }
    } finally {
      queue.running = false
      if (queues.get(id) === queue && queue.parts.length === 0) queues.delete(id)
    }
  }

  return {
    push(id, bytes) {
      if (bytes.length === 0) return
      let queue = queues.get(id)
      if (queue === undefined) {
        queue = { parts: [], running: false }
        queues.set(id, queue)
      }
      queue.parts.push(...slices(bytes, limit))
      if (!queue.running) void drain(id, queue)
    },
    drop(id) {
      const queue = queues.get(id)
      if (queue !== undefined) queue.parts.length = 0
      queues.delete(id)
    },
  }
}
