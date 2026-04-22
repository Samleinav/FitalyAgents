# FitalyAgents

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> _Just as FITALY puts letters where the fingers already are, FitalyAgents puts results where the agent needs them - without waiting._

**Event-driven multi-agent framework with built-in governance, speculative dispatch, MemPalace-powered memory, and professional avatar presence.**

FitalyAgents lets you build systems where multiple AI agents collaborate over a shared event bus, each tool declares its own safety level, human approval flows are a first-class primitive, agents can remember actor-specific context across sessions through [MemPalace](https://github.com/milla-jovovich/mempalace), and customer-facing avatars can present the system with a professional retail presence.

---

## Why FitalyAgents

Most multi-agent frameworks focus on orchestration. FitalyAgents adds **governance** and **memory**: the system enforces who can do what, when, and with whose approval, while also giving agents a persistent way to remember customers, employees, groups, stores, and prior decisions.

```
SAFE tools      → execute immediately, no approval needed
STAGED tools    → create a draft first, confirm before committing
PROTECTED tools → require explicit confirmation from the end user
RESTRICTED tools → require approval from a human with the right role
```

This model is embedded at every layer: tool definitions, the event bus, approval channels, and agent behavior.

Memory is embedded behind the same event-driven design. High-confidence intents stay fast. Low-confidence fallbacks can receive scoped MemPalace context, so agents can answer follow-ups like "the same coffee as before", "how is that inventory issue going", or "is register two still slow?" without mixing customer, employee, or store history.

Avatar presence follows the same principle: `AvatarAgent` is a pure renderer that turns bus events into visual commands without changing decisions or response text. Retail deployments can use the built-in professional presentation profile for subtle motion, focused expressions, queue acknowledgement, and approval gestures across in-store kiosks or web avatars.

---

## Core Features

| Feature                           | Why it matters                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Governed tool execution           | Every tool declares its risk level, so safe actions stay fast and sensitive actions require the right approval.   |
| Contextual risk adjustment        | Safety can change per session using memory, sentiment, fraud, VIP status, or store context without redeploying.   |
| Sentiment-aware escalation        | Ambient emotional signals can trigger proactive help before a customer interaction deteriorates.                  |
| Presence-aware approvals          | Approval routing can wait for an available manager or higher-role approver instead of timing out blindly.         |
| Human session handoff             | Staff takeovers receive a live context packet with conversation, draft, memory, and sentiment state.              |
| Quorum approvals                  | High-risk actions can require 2-of-N human approvals, with immediate rejection on any explicit no.                |
| Speculative dispatch              | SAFE tools can be classified and prefetched while the user is still speaking, reducing perceived latency.         |
| MemPalace-powered memory          | Agents can remember customers, employees, groups, stores, and prior decisions without mixing actor contexts.      |
| Professional avatar presence      | `AvatarAgent` turns bus events into brand-safe expressions, gestures, gaze, and speech for kiosk or web avatars.  |
| Retail target and group awareness | Diarization and target-group events let Fitaly focus on the active customer while tracking queues and ambience.   |
| Human-in-the-loop approvals       | Voice, webhook, and external channels let employees or supervisors approve high-impact actions in real workflows. |
| Pure event-driven integration     | Agents, UI, memory, approvals, and avatar renderers connect through the bus instead of hard-coded dependencies.   |

---

## Packages

| Package                    | Import                | Description                                                            |
| -------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `fitalyagents`             | `packages/core`       | Core framework: bus, agents, sessions, governance, avatar rendering    |
| `@fitalyagents/asynctools` | `packages/asynctools` | Async tool execution: ExecutorPool, RateLimiter, CircuitBreaker        |
| `@fitalyagents/dispatcher` | `packages/dispatcher` | Intent classification, speculative dispatch, and memory-aware fallback |

---

## Architecture

```
                        Event Bus (pub/sub)
                              │
          ┌───────────────────┼──────────────────────┬──────────────────┐
          │                   │                      │                  │
   InteractionAgent     StaffAgent             UIAgent           AvatarAgent
   (LLM streaming)      (employee              (reactive UI      (kiosk/web/AIRI
                         override)              updates)          renderer)
          │                   │                      │                  │
          └───────────────────┼──────────────────────┴──────────────────┘
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
    { name: 'product_search', safety: 'safe' },
    { name: 'order_create', safety: 'staged' },
    {
      name: 'payment_process',
      safety: 'protected',
      confirm_prompt: 'Confirm payment of {amount}?',
    },
    {
      name: 'refund_create',
      safety: 'restricted',
      required_role: 'supervisor',
      approval_channels: [
        { type: 'voice', timeout_ms: 15_000 },
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

| Level        | What happens                             | Who approves                |
| ------------ | ---------------------------------------- | --------------------------- |
| `safe`       | Executes immediately                     | No one needed               |
| `staged`     | Creates a reversible draft               | End user confirms           |
| `protected`  | Holds until user explicitly confirms     | End user                    |
| `restricted` | Holds until an authorized human approves | Employee with required role |

### Layer 2 — Role hierarchy

Five roles, each with configurable limits:

```
user → agent → operator → supervisor → owner
```

`SafetyGuard` short-circuits approval if the _speaker_ already holds the required role and is within their limits. The speaker _is_ the approval.

### Layer 3 — Approval channels

When escalation is needed, `ApprovalOrchestrator` coordinates one or more channels:

- **VoiceChannel** — Fitaly speaks to the employee out loud: _"Maria, approve refund of $150?"_
- **WebhookChannel** — push notification to a mobile app; employee taps approve/reject
- **ExternalToolChannel** — HTTP call to an external authorization system (POS, WhatsApp, etc.)

Channels can run in `parallel` (first to respond wins), `sequential` (fallback chain), or `quorum` (N-of-M approvals for high-risk actions).

---

## Agents

| Agent                 | Purpose                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `InteractionAgent`    | Main conversational agent. Streams LLM responses. Enforces SafetyGuard on every tool call.                     |
| `StaffAgent`          | Listens for privileged-role speakers, pauses the InteractionAgent, publishes handoff context, then resumes.    |
| `UIAgent`             | Reactive agent that translates bus events into UI update instructions. No LLM required.                        |
| `AmbientAgent`        | Analyzes background audio and enriches the ContextStore silently. No output to end user.                       |
| `SentimentGuard`      | Converts ambient emotional signals into session alerts and proactive escalation triggers.                      |
| `ProactiveAgent`      | Triggers suggestions based on context signals (e.g., session inactivity, thresholds).                          |
| `TargetGroupBridge`   | Routes events to the right session group based on session priority.                                            |
| `ContextBuilderAgent` | Builds and maintains the session context from multiple sources.                                                |
| `AvatarAgent`         | Renders bus events into avatar state, expression, gesture, gaze, and speech commands. No decision-making.      |

All agents extend `StreamAgent` and communicate exclusively through the event bus.

---

## Avatar Presence

`AvatarAgent` gives Fitaly a customer-facing body language layer without letting
the avatar decide anything. The interaction agent still owns the text, tools,
safety, and memory; the avatar only renders bus events into presentation
commands.

For retail, that means the same agent can power an in-store kiosk, a web avatar,
or an AIRI character while keeping a consistent professional style:

- subtle motion instead of overly cute movement
- focused expressions while listening or searching
- queue acknowledgement when another customer is waiting
- open-palm presentation gestures for product options
- serious confirmation posture for drafts and approvals
- target-aware gaze for the active customer or group

```typescript
import {
  AIRIRenderer,
  AvatarAgent,
  InMemoryBus,
  retailProfessionalAvatarProfile,
} from 'fitalyagents'

const bus = new InMemoryBus()

const avatar = new AvatarAgent({
  bus,
  renderer: new AIRIRenderer({ url: 'ws://localhost:6006' }),
  presentationProfile: retailProfessionalAvatarProfile,
})

await avatar.start()
```

The renderer is swappable. Use `AIRIRenderer` for an AIRI WebSocket character,
`MockAvatarRenderer` for tests and CI, or a custom renderer for a browser,
kiosk, POS screen, or 3D environment. The retail profile travels with the agent,
so in-store retail and web retail can share the same behavior while rendering
through different surfaces.

See [Avatar Retail Example](examples/avatar-retail/README.md).

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

### Memory-aware fallback

`NodeDispatcher` can optionally attach actor-scoped memory to low-confidence fallback requests. This lets the LLM fallback resolve ambiguous follow-ups like "the same coffee as before" using customer, employee, group, or store history without affecting the high-confidence hot path.

FitalyAgents can use [MemPalace](https://github.com/milla-jovovich/mempalace) as its persistent memory backend. MemPalace is a fast-growing open-source AI memory system built around local, searchable memory palaces: raw conversation storage, ChromaDB-backed retrieval, wings/rooms for structure, and MCP tools for agent integrations. As of April 2026, the MemPalace GitHub project was already drawing major community attention with 34k+ stars and 4k+ forks. In practice, that means FitalyAgents agents can:

- remember a customer's preferences across sessions
- keep employee and manager operational context separate from customer context
- maintain store-level memory for ambient events like slow registers or pickup bottlenecks
- give the LLM fallback real prior context instead of forcing it to guess from a single utterance
- run memory locally through MemPalace instead of sending long histories to a cloud API
- switch between CLI and MCP integration without changing dispatcher logic

Memory is behind the `IMemoryStore` port, so deployments can choose the backend:

- `InMemoryMemoryStore` for tests, local demos, and embedded ephemeral memory
- `InMemoryMemoryStore` + `AaakDialect` for lightweight TypeScript-only compression before embedding
- `MemPalaceMemoryStore` + `MemPalaceCliTransport` for real persistent MemPalace search through the CLI
- `MemPalaceMemoryStore` + `MemPalaceMcpTransport` for long-running services with a persistent MCP session

```typescript
import {
  MemPalaceCliTransport,
  MemPalaceMemoryStore,
  NodeDispatcher,
} from '@fitalyagents/dispatcher'

const memoryStore = new MemPalaceMemoryStore({
  transport: new MemPalaceCliTransport({
    palacePath: process.env.MEMPALACE_PALACE,
  }),
})

const dispatcher = new NodeDispatcher({
  bus,
  classifier,
  fallbackAgent,
  memoryStore,
  memoryScopeResolver: ({ session_id, speaker_id, role, store_id, group_id }) => {
    if (role === 'customer' && speaker_id) return { wing: 'customer', room: speaker_id }
    if (role === 'staff' && speaker_id) return { wing: 'employee', room: speaker_id }
    if (group_id) return { wing: 'group', room: group_id }
    if (store_id) return { wing: 'store', room: store_id }
    return { wing: 'session', room: session_id }
  },
})
```

When classification falls below the confidence threshold, `DISPATCH_FALLBACK` includes `memory_context`. Memory writes happen only after a classifier hit or resolved `llm_fallback`, so unresolved ambiguity is not stored.

See:

- [Memory Integration](docs/MEMORY-INTEGRATION.md)
- [Retail Memory Example](examples/memory-retail/README.md)
- [Retail MemPalace Example](examples/memory-retail-mempalace/README.md)

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
- [Approval Channels](docs/APPROVAL-CHANNELS.md) — built-in channels plus parallel, sequential, and quorum coordination
- [Governance Webhook Example](examples/governance-webhook/README.md) — single-approver remote approval flow through a browser or external app
- [Governance Quorum Example](examples/governance-quorum/README.md) — presence-aware 2-of-N approvals for high-risk actions
- [Speculative Dispatcher](docs/DISPATCHER-SPECULATIVE.md) — speculative pre-fetching architecture
- [Memory Integration](docs/MEMORY-INTEGRATION.md) — actor-scoped memory, AAAK, and MemPalace CLI/MCP backends
- [Avatar Retail Example](examples/avatar-retail/README.md) — professional avatar presence for in-store and web retail
- [API Reference](docs/api/) — generated TypeDoc

---

## Stack

| Decision          | Choice                                           | Reason                             |
| ----------------- | ------------------------------------------------ | ---------------------------------- |
| Language          | TypeScript 5.x strict                            | Full types, better DX              |
| Monorepo          | pnpm workspaces + turbo                          | Incremental build                  |
| Bus transport     | `InMemoryBus` (dev) / Redis Pub/Sub (prod)       | Drop-in swap via `IEventBus`       |
| Context store     | `InMemoryContextStore` (dev) / Redis JSON (prod) | Atomic partial updates, native TTL |
| Schema validation | Zod                                              | Runtime + types in one             |
| Testing           | vitest                                           | Fast, ESM-compatible               |
| Build             | tsup                                             | ESM + CJS, types included          |
| Observability     | Langfuse                                         | Agent tracing, span tracking       |

### Local / self-hosted audio providers

The framework is provider-agnostic. Any STT/TTS/LLM that implements the corresponding interface works:

| Layer       | Cloud options           | Local / edge options             |
| ----------- | ----------------------- | -------------------------------- |
| STT         | Deepgram, AssemblyAI    | Vosk, sherpa-onnx, NVIDIA Riva   |
| TTS         | ElevenLabs, Cartesia    | Piper (ONNX)                     |
| LLM         | OpenAI, Anthropic, Groq | Ollama                           |
| Diarization | Deepgram                | NeMo SortFormer (GPU), VibeVoice |

> **Whisper note:** Whisper can still be useful for offline or batch transcription, but it is not the recommended primary local STT for low-latency store conversations because FitalyAgents voice runtimes assume streaming partial and final speech events.
>
> **VibeVoice** (Microsoft) is a lightweight, fast, multilingual local speech pipeline. It runs on a Jetson NX (16 GB) and can support 1–4 FitalyAgents instances simultaneously — zero cloud cost for audio processing.

---

## License

MIT — see [LICENSE](LICENSE)
