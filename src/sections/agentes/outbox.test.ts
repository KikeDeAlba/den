import { describe, expect, it } from 'vitest'
import { binaryBytes, createOutbox } from './outbox.ts'

interface Call {
  id: number
  bytes: number[]
  done(): void
  fail(error: unknown): void
}

function recorder(): { calls: Call[]; send(id: number, bytes: Uint8Array): Promise<void> } {
  const calls: Call[] = []
  return {
    calls,
    send(id, bytes) {
      return new Promise<void>((done, fail) => calls.push({ id, bytes: [...bytes], done, fail }))
    },
  }
}

function flush(): Promise<void> {
  return new Promise((done) => setTimeout(done, 0))
}

describe('createOutbox', () => {
  it('sends one write at a time and keeps the order', async () => {
    const wire = recorder()
    const outbox = createOutbox((id, bytes) => wire.send(id, bytes))
    outbox.push(1, new Uint8Array([1]))
    outbox.push(1, new Uint8Array([2]))
    outbox.push(1, new Uint8Array([3]))
    expect(wire.calls.map((call) => call.bytes)).toEqual([[1]])
    wire.calls[0]?.done()
    await flush()
    expect(wire.calls.map((call) => call.bytes)).toEqual([[1], [2, 3]])
    wire.calls[1]?.done()
    await flush()
    expect(wire.calls).toHaveLength(2)
  })

  it('never sends more than the limit in one write', async () => {
    const wire = recorder()
    const outbox = createOutbox((id, bytes) => wire.send(id, bytes), 4)
    outbox.push(2, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    for (let index = 0; index < 3; index += 1) {
      wire.calls[index]?.done()
      await flush()
    }
    expect(wire.calls.map((call) => call.bytes)).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10]])
  })

  it('drops what is pending when a write fails and recovers on the next input', async () => {
    const wire = recorder()
    const outbox = createOutbox((id, bytes) => wire.send(id, bytes))
    outbox.push(3, new Uint8Array([1]))
    outbox.push(3, new Uint8Array([2]))
    wire.calls[0]?.fail(new Error('gone'))
    await flush()
    expect(wire.calls).toHaveLength(1)
    outbox.push(3, new Uint8Array([4]))
    expect(wire.calls.at(-1)?.bytes).toEqual([4])
  })

  it('keeps each session in its own queue', () => {
    const wire = recorder()
    const outbox = createOutbox((id, bytes) => wire.send(id, bytes))
    outbox.push(1, new Uint8Array([1]))
    outbox.push(2, new Uint8Array([2]))
    expect(wire.calls.map((call) => call.id)).toEqual([1, 2])
  })
})

describe('binaryBytes', () => {
  it('keeps every byte of a binary report as one byte', () => {
    expect([...binaryBytes('\x1b[M\xff\x80\x21')]).toEqual([0x1b, 0x5b, 0x4d, 0xff, 0x80, 0x21])
  })
})
