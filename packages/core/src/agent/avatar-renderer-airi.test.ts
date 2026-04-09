import { describe, expect, it } from 'vitest'
import {
  AIRIRenderer,
  type AIRIWebSocketConstructor,
  type AIRIWebSocketLike,
} from './avatar-renderer-airi.js'

class FakeSocket implements AIRIWebSocketLike {
  static readonly instances: FakeSocket[] = []
  readonly sent: string[] = []
  readyState = 0
  onopen: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  close(): void {
    this.readyState = 3
    this.onclose?.({})
  }

  send(data: string): void {
    this.sent.push(data)
  }

  static reset(): void {
    FakeSocket.instances.length = 0
  }
}

const WebSocketCtor: AIRIWebSocketConstructor = FakeSocket

describe('AIRIRenderer', () => {
  it('connects to AIRI over the configured WebSocket URL', async () => {
    FakeSocket.reset()
    const renderer = new AIRIRenderer({
      url: 'ws://airi.local:6006',
      WebSocketCtor,
    })

    const connecting = renderer.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()
    await connecting

    expect(socket.url).toBe('ws://airi.local:6006')
    expect(renderer.connected).toBe(true)
  })

  it('translates avatar commands into AIRI messages', async () => {
    FakeSocket.reset()
    const renderer = new AIRIRenderer({ WebSocketCtor })

    const connecting = renderer.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()
    await connecting

    await renderer.send({ type: 'state', state: 'thinking' })
    await renderer.send({ type: 'expression', expression: 'happy' })
    await renderer.send({
      type: 'speak',
      text: 'Your order is ready.',
      is_final: true,
      session_id: 'session-1',
      speaker_id: 'cust_ana',
      turn_id: 'turn-1',
    })
    await renderer.send({ type: 'look_at', target_id: 'cust_ana' })

    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'state', value: 'thinking' },
      { type: 'expression', value: 'happy' },
      {
        type: 'speak',
        text: 'Your order is ready.',
        final: true,
        session_id: 'session-1',
        speaker_id: 'cust_ana',
        turn_id: 'turn-1',
      },
      { type: 'look_at', target_id: 'cust_ana' },
    ])
  })

  it('queues commands until the socket connects', async () => {
    FakeSocket.reset()
    const renderer = new AIRIRenderer({ WebSocketCtor })

    await renderer.send({ type: 'state', state: 'waiting' })

    const connecting = renderer.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()
    await connecting

    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'state', value: 'waiting' },
    ])
  })
})
