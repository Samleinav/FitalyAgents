# FitalyAgents

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> *Asi como FITALY pone las letras donde los dedos ya estan, FitalyAgents pone los resultados donde el agente los necesita — sin esperar.*

**Event-driven multi-agent framework with built-in governance.**

FitalyAgents lets you build systems where multiple AI agents collaborate over a shared event bus, each tool declares its own safety level, and human approval flows are a first-class primitive — not an afterthought.

---

## Why FitalyAgents

Most multi-agent frameworks focus on orchestration. FitalyAgents adds **governance**: the idea that not all actions are equal, and the system itself enforces who can do what, when, and with whose approval.

```
SAFE tools      → execute immediately, no approval needed
STAGED tools    → create a draft first, confirm before committing
PROTECTED tools → require explicit confirmation from the end user
RESTRICTED tools → require approval from a human with the right role
```

This model is embedded at every layer: tool definitions, the event bus, approval channels, and agent behavior.

---

## Packages

| Package | Import | Description |
|---|---|---|
| `fitalyagents` | `packages/core` | Core framework: bus, agents, sessions, governance |
| `@fitalyagents/asynctools` | `packages/asynctools` | Async tool execution: ExecutorPool, RateLimiter, CircuitBreaker |
| `@fitalyagents/dispatcher` | `packages/dispatcher` | LLM-based intent classification for speculative dispatch |

---

## Architecture

```
                        Event Bus (pub/sub)
                              │
          ┌───────────────────┼──────────────────────┐
          │                   │                      │
   InteractionAgent     StaffAgent             UIAgent
   (LLM streaming)      (employee              (reactive UI
                         override)              updates)
          │                   │                      │
          └───────────────────┼──────────────────────┘
                              │
                       SafetyGuard
                    (evaluates every action)
                              │
              ┌───────────────┼──────────────────┐
              │               │                  │
           execute         DraftStore      ApprovalOrchestrator
           directly        (STAGED)        (RESTRICTED)
                                                 │
                                    ┌────────────┼────────────┐
                                    │            │            │
                              VoiceChannel  WebhookChannel  ExternalTool
```

---

## Quick Start

### Install

```bash
npm install fitalyagents
```

### 1. Create the bus and agents

```typescript
import {
  InMemoryBus,
  InteractionAgent,
  StaffAgent,
  UIAgent,
  SafetyGuard,
  ApprovalOrchestrator,
  InMemorySessionManager,
} from 'fitalyagents'

const bus = new InMemoryBus()
const sessions = new InMemorySessionManager({ bus })

const safetyGuard = new SafetyGuard({
  toolConfigs: [
    { name: 'product_search',  safety: 'safe' },
    { name: 'order_create',    safety: 'staged' },
    { name: 'payment_process', safety: 'protected', confirm_prompt: 'Confirm payment of {amount}?' },
    { name: 'refund_create',   safety: 'restricted', required_role: 'supervisor',
      approval_channels: [
        { type: 'voice',   timeout_ms: 15_000 },
        { type: 'webhook', timeout_ms: 90_000 },
      ],
      approval_strategy: 'parallel',
    },
  ],
})
```

### 2. Handle an event — SafetyGuard decides what to do

```typescript
const speaker = {
  id: 'usr_001',
  name: 'Alice',
  role: 'operator',
  org_id: 'org_main',
  approval_limits: { payment_max: 50_000 },
}

// SAFE: executes immediately
const decision1 = safetyGuard.evaluate('product_search', {}, speaker)
// → { allowed: true, execute: true }

// STAGED: creates a draft, does not execute
const decision2 = safetyGuard.evaluate('order_create', {}, speaker)
// → { allowed: true, execute: false, action: 'draft' }

// PROTECTED: operator within payment_max → executes directly
const decision3 = safetyGuard.evaluate('payment_process', { amount: 15_000 }, speaker)
// → { allowed: true, execute: true }

// RESTRICTED: operator cannot approve refunds → escalates to supervisor
const decision4 = safetyGuard.evaluate('refund_create', { amount: 15_000 }, speaker)
// → { allowed: false, reason: 'needs_approval', escalate_to: 'supervisor', channels: [...] }
```

### 3. Start agents

```typescript
const interactionAgent = new InteractionAgent({ bus, llm, safetyGuard, sessions })
const staffAgent = new StaffAgent({ bus, llm, safetyGuard })
const uiAgent = new UIAgent({ bus })

interactionAgent.start()
staffAgent.start()
uiAgent.start()

// Publish a speech event
bus.publish('bus:SPEECH_FINAL', {
  session_id: 'sess_001',
  text: 'I need help with my request',
  speaker,
})
```

---

## Governance in a Nutshell

FitalyAgents governance has three layers:

### Layer 1 — Safety levels per tool

Every tool/action declares how risky it is. `SafetyGuard` enforces the policy.

| Level | What happens | Who approves |
|---|---|---|
| `safe` | Executes immediately | No one needed |
| `staged` | Creates a reversible draft | End user confirms |
| `protected` | Holds until user explicitly confirms | End user |
| `restricted` | Holds until an authorized human approves | Employee with required role |

### Layer 2 — Role hierarchy

Five roles, each with configurable limits:

```
user → agent → operator → supervisor → owner
```

`SafetyGuard` short-circuits approval if the *speaker* already holds the required role and is within their limits. The speaker *is* the approval.

### Layer 3 — Approval channels

When escalation is needed, `ApprovalOrchestrator` coordinates one or more channels:

- **VoiceChannel** — Fitaly speaks to the employee out loud: *"Maria, approve refund of $150?"*
- **WebhookChannel** — push notification to a mobile app; employee taps approve/reject
- **ExternalToolChannel** — HTTP call to an external authorization system (POS, WhatsApp, etc.)

Channels can run in `parallel` (first to respond wins) or `sequential` (fallback chain).

---

## Agents

| Agent | Purpose |
|---|---|
| `InteractionAgent` | Main conversational agent. Streams LLM responses. Enforces SafetyGuard on every tool call. |
| `StaffAgent` | Listens for privileged-role speakers. Pauses the InteractionAgent, executes privileged commands, then resumes. |
| `UIAgent` | Reactive agent that translates bus events into UI update instructions. No LLM required. |
| `AmbientAgent` | Analyzes background audio and enriches the ContextStore silently. No output to end user. |
| `ProactiveAgent` | Triggers suggestions based on context signals (e.g., session inactivity, thresholds). |
| `TargetGroupBridge` | Routes events to the right session group based on session priority. |
| `ContextBuilderAgent` | Builds and maintains the session context from multiple sources. |

All agents extend `StreamAgent` and communicate exclusively through the event bus.

---

## Async Tools (`@fitalyagents/asynctools`)

Standalone layer for parallel tool execution with resilience primitives:

```typescript
import { ToolRegistry, ExecutorPool } from '@fitalyagents/asynctools'

const registry = new ToolRegistry()
registry.register({
  tool_id: 'product_search',
  executor: { type: 'http', url: 'https://api.store.com/search', method: 'POST' },
  execution_mode: 'async',
  timeout_ms: 5000,
  rate_limit: { requests_per_window: 100, window_ms: 60_000 },
  circuit_breaker: { failure_threshold: 5, reset_timeout_ms: 30_000 },
})

const pool = new ExecutorPool({ registry })
const result = await pool.execute('product_search', { brand: 'Nike', size: 42 })
```

---

## Dispatcher (`@fitalyagents/dispatcher`)

Speculative intent classification that pre-fetches SAFE tool results before the user finishes speaking:

```typescript
import { DispatcherBootstrapper } from '@fitalyagents/dispatcher'

const dispatcher = await DispatcherBootstrapper.create({
  bus,
  llmProvider: new ClaudeLLMProvider({ model: 'claude-haiku-4-5-20251001' }),
})

// On SPEECH_PARTIAL: classifies intent, executes SAFE tools speculatively
// On SPEECH_FINAL: LLM uses cached results → lower latency
```

---

## Development

```bash
pnpm install          # Install all dependencies
pnpm run build        # Build all packages
pnpm run test         # Run all tests (601 passing)
pnpm run lint         # ESLint
pnpm run type-check   # TypeScript strict check
```

### Test commands by package

```bash
# Core
npx vitest run --reporter=verbose --root packages/core

# Asynctools
npx vitest run --reporter=verbose --root packages/asynctools

# Dispatcher
npx vitest run --reporter=verbose --root packages/dispatcher

# Voice-retail example (E2E)
npx vitest run --reporter=verbose --root examples/voice-retail
```

---

## Documentation

- [Governance Guide](docs/GOVERNANCE.md) — how safety levels, roles, and approval channels work together
- [Safety Model](docs/SAFETY-MODEL.md) — complete decision matrix and flow diagrams
- [Human Roles](docs/HUMAN-ROLES.md) — role hierarchy, limits, and voice identification
- [Approval Channels](docs/APPROVAL-CHANNELS.md) — VoiceChannel, WebhookChannel, ExternalToolChannel
- [Speculative Dispatcher](docs/DISPATCHER-SPECULATIVE.md) — speculative pre-fetching architecture
- [API Reference](docs/api/) — generated TypeDoc

---

## Stack

| Decision | Choice | Reason |
|---|---|---|
| Language | TypeScript 5.x strict | Full types, better DX |
| Monorepo | pnpm workspaces + turbo | Incremental build |
| Bus transport | `InMemoryBus` (dev) / Redis Pub/Sub (prod) | Drop-in swap via `IEventBus` |
| Context store | `InMemoryContextStore` (dev) / Redis JSON (prod) | Atomic partial updates, native TTL |
| Schema validation | Zod | Runtime + types in one |
| Testing | vitest | Fast, ESM-compatible |
| Build | tsup | ESM + CJS, types included |
| Observability | Langfuse | Agent tracing, span tracking |

### Local / self-hosted audio providers

The framework is provider-agnostic. Any STT/TTS/LLM that implements the corresponding interface works:

| Layer | Cloud options | Local / edge options |
|---|---|---|
| STT | Deepgram, AssemblyAI | Whisper, VibeVoice (Microsoft) |
| TTS | ElevenLabs, Cartesia | Piper (ONNX) |
| LLM | OpenAI, Anthropic, Groq | Ollama |
| Diarization | Deepgram | NeMo SortFormer (GPU), VibeVoice |

> **VibeVoice** (Microsoft) is a lightweight, fast, multilingual local speech pipeline. It runs on a Jetson NX (16 GB) and can support 1–4 FitalyAgents instances simultaneously — zero cloud cost for audio processing.

---

## License

MIT — see [LICENSE](LICENSE)
