# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — 2026-02-24

### Added

#### Core (`fitalyagents`)

**Bus**
- `InMemoryBus` — in-memory event bus with pub/sub and Redis-style queue simulation (`lpush`/`brpop`)
- `RedisBus` / `createBus(options)` — Redis-backed event bus for production use

**NexusAgent**
- `NexusAgent` base class — all agents extend this; handles inbox listening via `brpop`, start/shutdown lifecycle

**AgentRegistry**
- `AgentRegistry` — registers and queries agent manifests; supports filtering by scope, capability, domain

**ContextStore**
- `InMemoryContextStore` — session-scoped key/value store with access control
- `enforceAccess()` / `AccessDeniedError` — enforces `ContextAccess` rules

**LockManager**
- `InMemoryLockManager` — distributed-style lock management with TTL and expiry callbacks

**SessionManager**
- `InMemorySessionManager` — full session lifecycle: create, get, assign group, set priority group, pause, resume, terminate
- `PriorityGroup` type: `0` (social), `1` (individual, default), `2` (employee/system)
- Employee Interrupt Protocol: `pauseSession(sessionId, pausedBy?)` / `resumeSession(sessionId)`
- `listActiveSessions()` — only `status: 'active'` sessions
- `listByPriorityGroup(pg)` — non-terminated sessions by priority group
- `onTerminated(callback)` — register cleanup hooks fired on `terminateSession()`

**TaskQueue**
- `InMemoryTaskQueue` — publish, claim, start, complete, fail, cancel tasks; priority ordering; lock integration

**CapabilityRouter**
- `CapabilityRouter` — routes tasks to the correct agent based on capabilities; integrates with TaskQueue and LockManager

**AudioQueueService**
- `InMemoryAudioQueueService` — priority-based audio segment queue with barge-in support
- `bus:BARGE_IN` event interrupts active audio for a session
- `start()` returns `Unsubscribe` for clean teardown

**ApprovalQueue** *(new in 1.0.0)*
- `InMemoryApprovalQueue` — human-in-the-loop approval queue for orders and refunds
- `start()` subscribes to `bus:ORDER_PENDING_APPROVAL`
- `approve(draftId, approverId)` → publishes `bus:ORDER_APPROVED` + `bus:ACTION_COMPLETED`
- `reject(draftId, reason)` → publishes `bus:ORDER_APPROVAL_REJECTED` + `bus:ACTION_COMPLETED`
- Auto-timeout with configurable `approval_timeout_ms` → publishes `bus:ORDER_APPROVAL_TIMEOUT` + `bus:ACTION_COMPLETED`
- `ApprovalNotFoundError` / `ApprovalAlreadyResolvedError` error types

**Types & Schemas**
- Full Zod schemas for all event types: `TaskPayloadEvent`, `TaskResultEvent`, `ActionCompletedEvent`, `HeartbeatEvent`, etc.
- `AgentManifest`, `Domain`, `AgentRole`, `ContextMode`, `ContextAccess` schemas and types
- `TaskStatus`: `'completed' | 'failed' | 'waiting_approval' | 'cancelled'`

#### AsyncTools (`@fitalyagents/asynctools`)

- `ToolRegistry` — register, get, list, unregister tools with Zod validation
- `ToolRegistry.fromFile(path)` / `ToolRegistry.fromObject(config)` — load from JSON
- `DuplicateToolError` / `ToolNotFoundError` / `ToolValidationError`
- `ExecutorPool` — parallel tool execution with injection strategies
- Execution modes: `sync`, `async`, `fire_forget`, `deferred`
- Injection strategies: `inject_when_all`, `inject_when_ready`, `inject_on_timeout`
- `PendingStateTracker` — tracks in-flight tool calls per session
- `AsyncAgent` wrapper — adds async tool execution to any agent

#### Voice Retail Example (`examples/voice-retail`)

- `InteractionAgent` — voice interaction agent (TEN Framework via mockeable `ITENClient`)
- `WorkAgent` — tool execution agent (LangChain.js via mockeable `IToolExecutor`)
- `OrderAgent` — order lifecycle management with human approval support
- `createApprovalWebhookHandler` — Express/Hono-compatible webhook for approval decisions
- E2E test suite: pipeline, order approval, multi-session isolation, order lifecycle, cancel chain
- **73 tests**, all passing

#### Documentation

- `docs/guides/getting-started.md` — 10-minute quickstart
- `docs/guides/asynctools-standalone.md` — Layer 2 with LangGraph
- `docs/guides/add-new-agent.md` — step-by-step agent creation
- `docs/guides/training-the-dispatcher.md` — intent classification and training
- `docs/guides/rust-dispatcher.md` — Phase 5 Rust dispatcher overview

### Compatibility

| Component | Minimum | Recommended |
|---|---|---|
| Node.js | 18.x | 20.x LTS |
| Redis | 6.x | 7.x |
| TypeScript | 5.0 | 5.5+ |
| pnpm | 8.x | 9.x |

### Test Coverage

| Package | Tests |
|---|---|
| `packages/core` | 193 tests |
| `packages/asynctools` | (included in core test run) |
| `examples/voice-retail` | 73 tests |
| **Total** | **266 tests** |

---

## [0.0.1] — Initial development

Internal development builds — not published.

- Sprint 0.x: Monorepo scaffolding, ToolRegistry, ExecutorPool, AsyncAgent
- Sprint 1.x: InMemoryBus, NexusAgent, AgentRegistry, ContextStore, LockManager
- Sprint 2.x: TaskQueue, CapabilityRouter, AudioQueueService, voice-retail E2E
- Sprint 3.x: OrderAgent, ApprovalQueue, webhook handler, order-approval E2E
- Sprint 4.x: Multi-session E2E, SessionManager priority groups, employee interrupt protocol
