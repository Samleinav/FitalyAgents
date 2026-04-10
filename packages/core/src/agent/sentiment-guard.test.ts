import { describe, expect, it } from 'vitest'
import { InMemoryBus } from '../bus/in-memory-bus.js'
import { InMemoryContextStore } from '../context/in-memory-context-store.js'
import type { SessionSentimentAlert, SentimentLevel } from '../types/index.js'
import { SentimentGuard } from './sentiment-guard.js'

function createGuard(config?: ConstructorParameters<typeof SentimentGuard>[0]['config']) {
  const bus = new InMemoryBus()
  const contextStore = new InMemoryContextStore()
  const alerts: SessionSentimentAlert[] = []
  bus.subscribe('bus:SESSION_SENTIMENT_ALERT', (data) => alerts.push(data as SessionSentimentAlert))

  const guard = new SentimentGuard({ bus, contextStore, config })
  return { alerts, bus, contextStore, guard }
}

describe('SentimentGuard', () => {
  it('publishes SESSION_SENTIMENT_ALERT after consecutive tense samples', async () => {
    const { alerts, bus, contextStore, guard } = createGuard()
    await guard.start()

    await bus.publish('bus:AMBIENT_CONTEXT', {
      event: 'AMBIENT_CONTEXT',
      session_id: 'session_1',
      speaker_id: 'cust_ana',
      text: 'I am still waiting and this is becoming a problem.',
      timestamp: Date.now(),
    })

    expect(alerts).toHaveLength(0)

    await bus.publish('bus:AMBIENT_CONTEXT', {
      event: 'AMBIENT_CONTEXT',
      session_id: 'session_1',
      speaker_id: 'cust_ana',
      text: 'This is not working, I am frustrated.',
      timestamp: Date.now(),
    })

    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({
      event: 'SESSION_SENTIMENT_ALERT',
      session_id: 'session_1',
      level: 'frustrated',
      consecutive_count: 2,
      speaker_id: 'cust_ana',
    })

    await expect(
      contextStore.get<SentimentLevel>('session_1', 'sentiment_alert_level'),
    ).resolves.toBe('frustrated')
  })

  it('does not duplicate alerts until the sentiment run resets', async () => {
    const { alerts, bus, guard } = createGuard()
    await guard.start()

    await bus.publish('bus:AMBIENT_CONTEXT', {
      event: 'AMBIENT_CONTEXT',
      session_id: 'session_1',
      text: 'Estoy esperando y hay un problema.',
      timestamp: Date.now(),
    })
    await bus.publish('bus:AMBIENT_CONTEXT', {
      event: 'AMBIENT_CONTEXT',
      session_id: 'session_1',
      text: 'Esto es una estafa.',
      timestamp: Date.now(),
    })
    await bus.publish('bus:AMBIENT_CONTEXT', {
      event: 'AMBIENT_CONTEXT',
      session_id: 'session_1',
      text: 'No vuelvo a esta tienda.',
      timestamp: Date.now(),
    })

    expect(alerts).toHaveLength(1)

    await bus.publish('bus:AMBIENT_CONTEXT', {
      event: 'AMBIENT_CONTEXT',
      session_id: 'session_1',
      text: 'Ok, gracias.',
      timestamp: Date.now(),
    })
    await bus.publish('bus:AMBIENT_CONTEXT', {
      event: 'AMBIENT_CONTEXT',
      session_id: 'session_1',
      text: 'Otra vez no funciona.',
      timestamp: Date.now(),
    })
    await bus.publish('bus:AMBIENT_CONTEXT', {
      event: 'AMBIENT_CONTEXT',
      session_id: 'session_1',
      text: 'Estoy molesto.',
      timestamp: Date.now(),
    })

    expect(alerts).toHaveLength(2)
  })

  it('uses explicit sentiment hints when available', () => {
    const { guard } = createGuard()

    expect(guard.classifySentiment('All words are calm.', 'angry')).toBe('angry')
    expect(guard.classifySentiment('This is ridiculous.', 'neutral')).toBe('angry')
    expect(guard.classifySentiment('Perfecto, gracias.', null)).toBe('positive')
  })

  it('caps the sliding window', async () => {
    const { bus, guard } = createGuard({ windowSize: 3, alertThreshold: 4 })
    await guard.start()

    for (let i = 0; i < 5; i += 1) {
      await bus.publish('bus:AMBIENT_CONTEXT', {
        event: 'AMBIENT_CONTEXT',
        session_id: 'session_1',
        text: `problem ${i}`,
        timestamp: Date.now() + i,
      })
    }

    expect(guard.getWindow('session_1')).toHaveLength(3)
  })

  it('supports a stricter minimum alert level', async () => {
    const { alerts, bus, guard } = createGuard({ minAlertLevel: 'frustrated' })
    await guard.start()

    await bus.publish('bus:AMBIENT_CONTEXT', {
      event: 'AMBIENT_CONTEXT',
      session_id: 'session_1',
      text: 'I am concerned about this issue.',
      timestamp: Date.now(),
    })
    await bus.publish('bus:AMBIENT_CONTEXT', {
      event: 'AMBIENT_CONTEXT',
      session_id: 'session_1',
      text: 'I am still waiting.',
      timestamp: Date.now(),
    })

    expect(alerts).toHaveLength(0)
  })
})
