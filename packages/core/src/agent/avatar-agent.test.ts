import { describe, expect, it } from 'vitest'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { AvatarAgent } from './avatar-agent.js'
import { MockAvatarRenderer } from './avatar-renderer-mock.js'
import type { AvatarCommand, IAvatarRenderer } from './avatar-types.js'

function createAvatarAgent(options: { handleSpeech?: boolean } = {}) {
  const bus = new InMemoryBus()
  const renderer = new MockAvatarRenderer()
  const agent = new AvatarAgent({
    bus,
    renderer,
    handleSpeech: options.handleSpeech,
    intentExpressionMap: {
      order_confirmed: 'happy',
      complaint: 'empathetic',
      product_search: 'helpful',
    },
  })

  return { agent, bus, renderer }
}

describe('AvatarAgent', () => {
  it('orients to the primary target and shows waiting when the queue is non-empty', async () => {
    const { agent, renderer } = createAvatarAgent()

    await agent.onEvent('bus:TARGET_GROUP_CHANGED', {
      event: 'TARGET_GROUP_CHANGED',
      store_id: 'store_1',
      primary: 'cust_ana',
      queued: ['cust_ben'],
      ambient: [],
      speakers: [],
      timestamp: Date.now(),
    })

    expect(renderer.commands).toEqual([
      { type: 'look_at', target_id: 'cust_ana' },
      { type: 'state', state: 'waiting' },
      { type: 'expression', expression: 'warm' },
    ])
  })

  it('maps task intents to configured expressions', async () => {
    const { agent, renderer } = createAvatarAgent()

    await agent.onEvent('bus:TASK_AVAILABLE', {
      event: 'TASK_AVAILABLE',
      session_id: 'session-1',
      intent_id: 'product_search',
    })

    expect(renderer.commands).toEqual([
      { type: 'state', state: 'thinking' },
      { type: 'expression', expression: 'helpful' },
    ])
  })

  it('renders avatar speech chunks when enabled', async () => {
    const { agent, renderer } = createAvatarAgent()

    await agent.onEvent('bus:AVATAR_SPEAK', {
      event: 'AVATAR_SPEAK',
      session_id: 'session-1',
      speaker_id: 'cust_ana',
      turn_id: 'turn-1',
      intent_id: 'order_confirmed',
      text: 'Your order is ready.',
      is_final: true,
      timestamp: Date.now(),
    })

    expect(renderer.commands).toEqual([
      { type: 'state', state: 'speaking' },
      { type: 'expression', expression: 'happy' },
      {
        type: 'speak',
        text: 'Your order is ready.',
        is_final: true,
        session_id: 'session-1',
        speaker_id: 'cust_ana',
        turn_id: 'turn-1',
      },
    ])
  })

  it('can handle speech visually without sending speak commands', async () => {
    const { agent, renderer } = createAvatarAgent({ handleSpeech: false })

    await agent.onEvent('bus:AVATAR_SPEAK', {
      event: 'AVATAR_SPEAK',
      session_id: 'session-1',
      turn_id: 'turn-1',
      text: 'External TTS handles this.',
      is_final: false,
      timestamp: Date.now(),
    })

    expect(renderer.commands).toEqual([
      { type: 'state', state: 'speaking' },
      { type: 'expression', expression: 'neutral' },
    ])
  })

  it('returns to listening after response end when a primary target exists', async () => {
    const { agent, renderer } = createAvatarAgent()

    await agent.onEvent('bus:TARGET_GROUP_CHANGED', {
      event: 'TARGET_GROUP_CHANGED',
      store_id: 'store_1',
      primary: 'cust_ana',
      queued: [],
      ambient: [],
      speakers: [],
      timestamp: Date.now(),
    })
    renderer.clear()

    await agent.onEvent('bus:RESPONSE_END', {
      event: 'RESPONSE_END',
      session_id: 'session-1',
      turn_id: 'turn-1',
      reason: 'end_turn',
      timestamp: Date.now(),
    })

    expect(renderer.commands).toEqual([
      { type: 'state', state: 'listening' },
      { type: 'expression', expression: 'neutral' },
    ])
  })

  it('isolates renderer failures from the agent pipeline', async () => {
    class FailingRenderer implements IAvatarRenderer {
      readonly connected = true
      readonly commands: AvatarCommand[] = []

      async connect(): Promise<void> {}
      disconnect(): void {}

      async send(command: AvatarCommand): Promise<void> {
        this.commands.push(command)
        throw new Error('renderer unavailable')
      }
    }

    const bus = new InMemoryBus()
    const renderer = new FailingRenderer()
    const agent = new AvatarAgent({ bus, renderer })

    await expect(
      agent.onEvent('bus:DISPATCH_FALLBACK', {
        event: 'DISPATCH_FALLBACK',
        session_id: 'session-1',
        text: 'unclear',
      }),
    ).resolves.toBeUndefined()
    expect(renderer.commands).toHaveLength(2)
  })
})
