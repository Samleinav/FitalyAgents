import { describe, expect, it, vi } from 'vitest'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { InMemoryContextStore } from '../context/in-memory-context-store.js'
import { InMemoryDraftStore } from '../safety/draft-store.js'
import { HandoffBuilder } from './handoff-builder.js'
import type { HandoffMemoryStore } from './handoff-builder.js'

describe('HandoffBuilder', () => {
  it('builds a handoff packet with context, recent turns, draft, and memory hits', async () => {
    const bus = new InMemoryBus()
    const contextStore = new InMemoryContextStore()
    const draftStore = new InMemoryDraftStore({ bus })
    const memoryStore: HandoffMemoryStore = {
      query: vi.fn().mockResolvedValue([
        {
          text: 'Ana prefers pickup near the front counter.',
          wing: 'customer',
          room: 'customer_ana',
          similarity: 0.91,
        },
      ]),
    }

    await contextStore.patch('session-1', {
      customer_id: 'customer_ana',
      store_id: 'store_1',
      last_user_text: 'I have been waiting too long.',
      last_response: 'I can bring a manager over.',
      sentiment_alert_level: 'frustrated',
    })
    await contextStore.setAmbient('session-1', {
      conversation_snippets: [
        {
          speaker_id: 'customer_ana',
          text: 'The line is not moving.',
          timestamp: 10,
        },
      ],
      timestamp: 10,
    })
    const draftId = await draftStore.create('session-1', {
      intent_id: 'refund_create',
      items: { amount: 120 },
    })

    const builder = new HandoffBuilder({
      contextStore,
      draftStore,
      memoryStore,
      maxConversationTurns: 5,
    })

    const handoff = await builder.build('session-1', 'manager_ana', 'manager', 'InteractionAgent')

    expect(handoff).toMatchObject({
      event: 'SESSION_HANDOFF',
      session_id: 'session-1',
      from_agent_id: 'InteractionAgent',
      to_human_id: 'manager_ana',
      to_role: 'manager',
      context_snapshot: {
        customer_id: 'customer_ana',
        sentiment_alert_level: 'frustrated',
      },
      pending_draft: {
        id: draftId,
        intent_id: 'refund_create',
      },
      memory_context: [
        {
          text: 'Ana prefers pickup near the front counter.',
          similarity: 0.91,
        },
      ],
    })
    expect(handoff.conversation_summary.map((turn) => turn.text)).toEqual([
      'The line is not moving.',
      'I have been waiting too long.',
      'I can bring a manager over.',
    ])
    expect(memoryStore.query).toHaveBeenCalledWith(expect.stringContaining('waiting'), {
      room: 'session-1',
      n: 3,
    })

    draftStore.dispose()
  })

  it('caps conversation turns and tolerates memory failures', async () => {
    const contextStore = new InMemoryContextStore()
    const memoryStore: HandoffMemoryStore = {
      query: vi.fn().mockRejectedValue(new Error('memory offline')),
    }

    await contextStore.patch('session-1', {
      conversation_summary: [
        { role: 'customer', text: 'one', timestamp: 1 },
        { role: 'agent', text: 'two', timestamp: 2 },
        { role: 'customer', text: 'three', timestamp: 3 },
      ],
    })

    const builder = new HandoffBuilder({
      contextStore,
      memoryStore,
      maxConversationTurns: 2,
    })

    const handoff = await builder.build('session-1', null, 'manager', 'InteractionAgent')

    expect(handoff.conversation_summary.map((turn) => turn.text)).toEqual(['two', 'three'])
    expect(handoff.memory_context).toBeUndefined()
  })

  it('caps memory hits even if the memory backend returns too many', async () => {
    const contextStore = new InMemoryContextStore()
    const memoryStore: HandoffMemoryStore = {
      query: vi.fn().mockResolvedValue([
        { text: 'first', wing: 'session', room: 'session-1', similarity: 0.9 },
        { text: 'second', wing: 'session', room: 'session-1', similarity: 0.8 },
        { text: 'third', wing: 'session', room: 'session-1', similarity: 0.7 },
      ]),
    }

    await contextStore.set('session-1', 'last_user_text', 'Need manager help')

    const builder = new HandoffBuilder({
      contextStore,
      memoryStore,
      maxMemoryHits: 2,
    })

    const handoff = await builder.build('session-1', 'manager_1', 'manager', 'InteractionAgent')

    expect(handoff.memory_context?.map((hit) => hit.text)).toEqual(['first', 'second'])
  })
})
