import { describe, expect, it, vi } from 'vitest'
import { InMemoryBus, InMemoryContextStore, InMemorySessionManager } from 'fitalyagents'
import { InteractionRuntimeAgent } from './interaction-runtime-agent.js'
import { SessionRepository, DraftRepository } from '../storage/repositories/index.js'
import { buildSpeakerSessionId } from '../bootstrap/speaker-session.js'
import {
  cleanupTempDir,
  closeTestDb,
  createTempDbPath,
  createTempDir,
  ensureDb,
} from '../../test/helpers.js'

describe('InteractionRuntimeAgent', () => {
  it('aborts active LLM sessions on barge-in', async () => {
    const harness = await createHarness()

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:BARGE_IN', {
        event: 'BARGE_IN',
        session_id: 'session-1',
      })

      expect(harness.llm.abortSession).toHaveBeenCalledWith('session-1')
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('routes customer speech through interaction and memory', async () => {
    const harness = await createHarness()

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-1',
        text: 'Busco tenis Nike',
        speaker_id: 'customer-1',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.interaction.handleSpeechFinal).toHaveBeenCalled()
      expect(harness.memoryStore.write).toHaveBeenCalled()
      expect(await harness.sessionManager.getSession('session-1')).not.toBeNull()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('ignores customer speech when another speaker is primary', async () => {
    const harness = await createHarness()

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:TARGET_GROUP_CHANGED', {
        event: 'TARGET_GROUP_CHANGED',
        store_id: 'store-test',
        primary: 'customer-1',
        queued: ['customer-2'],
        ambient: [],
        speakers: [
          { speakerId: 'customer-1', state: 'targeted' },
          { speakerId: 'customer-2', state: 'queued' },
        ],
        timestamp: Date.now(),
      })

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'session-2',
        text: 'yo también quiero ayuda',
        speaker_id: 'customer-2',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      expect(harness.interaction.handleSpeechFinal).not.toHaveBeenCalled()
      expect(harness.memoryStore.write).not.toHaveBeenCalled()
      expect(await harness.sessionManager.getSession('session-2')).toBeNull()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })

  it('swallows abort-like errors from the LLM path', async () => {
    const harness = await createHarness({
      runWithSession: vi
        .fn()
        .mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError')),
    })

    await expect(
      harness.agent.onEvent('bus:SPEECH_FINAL', {
        session_id: 'session-1',
        text: 'hola',
      }),
    ).resolves.toBeUndefined()

    await cleanupHarness(harness)
  })

  it('normalizes external-bus speech into speaker-scoped runtime sessions', async () => {
    const harness = await createHarness({
      captureDriver: 'external-bus',
    })

    try {
      await harness.agent.start()

      await harness.bus.publish('bus:SPEECH_FINAL', {
        event: 'SPEECH_FINAL',
        session_id: 'room-a',
        text: 'hola desde redis',
        speaker_id: 'trk:voice:001',
        role: 'customer',
        store_id: 'store-test',
        timestamp: Date.now(),
      })

      const expectedSessionId = buildSpeakerSessionId('store-test', 'trk:voice:001')
      expect(harness.interaction.handleSpeechFinal).toHaveBeenCalledWith(
        expect.objectContaining({
          session_id: expectedSessionId,
          speaker_id: 'trk:voice:001',
        }),
      )
      expect(await harness.sessionManager.getSession(expectedSessionId)).not.toBeNull()
      expect(await harness.sessionManager.getSession('room-a')).toBeNull()
    } finally {
      await harness.agent.stop()
      await cleanupHarness(harness)
    }
  })
})

async function createHarness(overrides?: {
  runWithSession?: ReturnType<typeof vi.fn>
  captureDriver?: 'local-stt' | 'voice-events' | 'external-bus'
}) {
  const dir = await createTempDir()
  const dbPath = createTempDbPath(dir)
  const db = ensureDb(dbPath)
  const bus = new InMemoryBus()
  const contextStore = new InMemoryContextStore()
  const sessionManager = new InMemorySessionManager()

  const llm = {
    runWithSession:
      overrides?.runWithSession ??
      vi.fn(async (_sessionId: string, fn: () => Promise<unknown>) => fn()),
    abortSession: vi.fn(),
  }

  const interaction = {
    hasPendingConfirmation: vi.fn(() => false),
    handleProtectedConfirm: vi.fn(),
    handleDraftFlow: vi.fn(),
    handleSpeechFinal: vi.fn().mockResolvedValue({
      textChunks: [],
      toolResults: [],
      traceId: 'trace-1',
    }),
  }

  const draftStore = {
    getBySession: vi.fn().mockResolvedValue(null),
  }

  const toolRegistry = {
    runWithContext: vi.fn(async (_ctx, fn: () => Promise<unknown>) => fn()),
  }

  const memoryStore = {
    write: vi.fn().mockResolvedValue(undefined),
  }

  const ttsStream = {
    speakText: vi.fn().mockResolvedValue(undefined),
  }

  const agent = new InteractionRuntimeAgent({
    bus,
    interaction: interaction as never,
    llm: llm as never,
    toolRegistry: toolRegistry as never,
    contextStore,
    sessionManager,
    sessionRepository: new SessionRepository(db),
    draftStore: draftStore as never,
    draftRepository: new DraftRepository(db),
    ttsStream: ttsStream as never,
    storeId: 'store-test',
    captureDriver: overrides?.captureDriver ?? 'local-stt',
    memoryStore: memoryStore as never,
    memoryScopeResolver: async () => ({ wing: 'customer', room: 'customer-1' }),
  })

  return {
    agent,
    bus,
    llm,
    interaction,
    memoryStore,
    sessionManager,
    dbPath,
    dir,
  }
}

async function cleanupHarness(harness: { dbPath: string; dir: string }) {
  closeTestDb(harness.dbPath)
  await cleanupTempDir(harness.dir)
}
