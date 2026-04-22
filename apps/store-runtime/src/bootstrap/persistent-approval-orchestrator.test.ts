import { describe, expect, it } from 'vitest'
import { InMemoryBus } from 'fitalyagents'
import { PersistentApprovalOrchestrator } from './persistent-approval-orchestrator.js'
import { ApprovalRepository, DraftRepository } from '../storage/repositories/index.js'
import {
  cleanupTempDir,
  closeTestDb,
  createTempDbPath,
  createTempDir,
  ensureDb,
} from '../../test/helpers.js'

describe('PersistentApprovalOrchestrator', () => {
  it('marks approvals as queued when no approver is available', async () => {
    const dir = await createTempDir()
    const dbPath = createTempDbPath(dir)
    ensureDb(dbPath)

    try {
      const bus = new InMemoryBus()
      const db = ensureDb(dbPath)
      const repository = new ApprovalRepository(db)
      const drafts = new DraftRepository(db)
      const orchestrator = new PersistentApprovalOrchestrator({
        bus,
        channelRegistry: new Map(),
        repository,
      })

      orchestrator.start()
      drafts.upsert({
        id: 'draft-1',
        session_id: 'session-1',
        tool_id: 'refund_create',
        params: {},
        status: 'pending',
        safety_level: 'restricted',
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      repository.insert({
        id: 'approval-1',
        draft_id: 'draft-1',
        session_id: 'session-1',
        action: 'refund_create',
        required_role: 'manager',
        strategy: 'parallel',
        quorum_required: null,
        status: 'pending',
        approvers: [],
        context: {},
        timeout_ms: 60_000,
        created_at: Date.now(),
        resolved_at: null,
      })

      await bus.publish('bus:ORDER_QUEUED_NO_APPROVER', {
        event: 'ORDER_QUEUED_NO_APPROVER',
        request_id: 'approval-1',
      })

      expect(repository.findById('approval-1')?.status).toBe('queued')

      orchestrator.dispose()
    } finally {
      closeTestDb(dbPath)
      await cleanupTempDir(dir)
    }
  })
})
