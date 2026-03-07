import { StreamAgent } from 'fitalyagents'
import type {
  TaskPayloadEvent,
  TaskResultEvent,
  AgentManifest,
  IEventBus,
  IAudioQueueService,
} from 'fitalyagents'
import type { ITENClient, Gesture } from './types.js'

// ── Manifest ────────────────────────────────────────────────────────────────

/**
 * Create the InteractionAgent manifest.
 * Can be customized per deployment via overrides.
 */
export function createInteractionManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    agent_id: 'interaction-agent-001',
    display_name: 'Interaction Agent',
    description:
      'Customer-facing agent handling quick responses, audio queue management, display orders, and avatar gestures. Powered by TEN Framework for ultra-low-latency multimodal interaction.',
    version: '1.0.0',
    domain: 'customer_facing',
    scope: 'interaction',
    capabilities: ['QUICK_RESPONSE', 'AUDIO_QUEUE', 'DISPLAY_ORDER', 'GESTURE'],
    context_mode: 'stateful',
    context_access: {
      read: ['conversation_history', 'user_preferences', 'current_order', 'last_action'],
      write: ['last_action', 'display_state'],
      forbidden: ['internal_metrics', 'agent_debug'],
    },
    async_tools: [
      'quick_response_generate',
      'audio_queue_push',
      'audio_queue_interrupt',
      'audio_queue_continue',
      'audio_queue_modify',
      'audio_queue_clear',
      'display_order',
      'display_gesture',
    ],
    input_channel: 'queue:interaction-agent:inbox',
    output_channel: 'queue:interaction-agent:outbox',
    priority: 8,
    max_concurrent: 3,
    timeout_ms: 10000,
    heartbeat_interval_ms: 3000,
    role: null,
    accepts_from: ['*'],
    requires_human_approval: false,
    ...overrides,
  }
}

// ── InteractionAgent ────────────────────────────────────────────────────────

export interface InteractionAgentOptions {
  bus: IEventBus
  tenClient: ITENClient
  audioQueue: IAudioQueueService
  manifest?: Partial<AgentManifest>
}

/**
 * InteractionAgent — the customer-facing agent for real-time interaction.
 *
 * Responsibilities:
 * 1. **Quick Response** — Generate filler phrases while backend agents work
 * 2. **Audio Queue** — Manage audio output (push, interrupt, modify, clear)
 * 3. **Display** — Send gesture and order display commands to the frontend
 * 4. **Barge-in** — Handle interruptions gracefully
 *
 * Architecture:
 * - Extends `StreamAgent` for lifecycle (subscribe, start, stop)
 * - Uses `ITENClient` (TEN Framework) for ultra-low-latency responses
 * - Uses `IAudioQueueService` for ordered audio output
 *
 * Flow:
 * ```
 * TASK_PAYLOAD → process()
 *   ├── generateQuickResponse() + displayGesture('thinking') [PARALLEL]
 *   ├── Push filler audio to queue
 *   └── Return context_patch with display_state
 *
 * ACTION_COMPLETED (from WorkAgent) →
 *   ├── audio_queue_interrupt (stop filler)
 *   ├── audio_queue_push (real response)
 *   └── displayGesture('happy')
 * ```
 */
export class InteractionAgent extends StreamAgent {
  public readonly manifest: AgentManifest
  private readonly tenClient: ITENClient
  private readonly audioQueue: IAudioQueueService
  private _shutdown = false

  constructor(options: InteractionAgentOptions) {
    super(options.bus)
    this.manifest = createInteractionManifest(options.manifest)
    this.tenClient = options.tenClient
    this.audioQueue = options.audioQueue
  }

  protected get channels(): string[] {
    return ['queue:interaction-agent:inbox', 'bus:ACTION_COMPLETED']
  }

  async onEvent(channel: string, payload: unknown): Promise<void> {
    if (channel === 'bus:ACTION_COMPLETED') {
      const event = payload as { session_id: string; intent_id: string; result: unknown }
      await this.handleActionCompleted(event)
    } else if (channel === 'queue:interaction-agent:inbox') {
      await this.process(payload as TaskPayloadEvent)
    }
  }

  /**
   * Start the agent — subscribes to channels and publishes AGENT_REGISTERED.
   */
  async start(): Promise<void> {
    this._shutdown = false
    await super.start()
    await this.bus.publish('bus:AGENT_REGISTERED', {
      event: 'AGENT_REGISTERED' as const,
      ...this.manifest,
    })
  }

  /**
   * Graceful shutdown — publishes AGENT_DEREGISTERED and stops.
   */
  async shutdown(): Promise<void> {
    if (this._shutdown) return
    this._shutdown = true
    await this.bus.publish('bus:AGENT_DEREGISTERED', {
      event: 'AGENT_DEREGISTERED' as const,
      agent_id: this.manifest.agent_id,
      timestamp: Date.now(),
    })
    await this.stop()
  }

  // ── Core process ──────────────────────────────────────────────────────

  /**
   * Process a task:
   * 1. Generate quick response + show thinking gesture [PARALLEL]
   * 2. Push filler audio to queue
   * 3. Return completed with context_patch
   */
  async process(task: TaskPayloadEvent): Promise<TaskResultEvent> {
    const { session_id, intent_id, task_id } = task

    // PARALLEL: quick response + thinking gesture
    const [quickResponse] = await Promise.all([
      this.tenClient.generateQuickResponse(task.context_snapshot, intent_id),
      this.tenClient.displayGesture(session_id, 'thinking'),
    ])

    // Push filler audio to queue
    await this.audioQueue.push(session_id, {
      segmentId: `filler_${task_id}`,
      text: quickResponse.text,
      priority: 5,
    })

    // Display the gesture from TEN
    await this.tenClient.displayGesture(session_id, quickResponse.gesture)

    return {
      event: 'TASK_RESULT',
      task_id,
      session_id,
      status: 'completed',
      result: {
        quick_response: quickResponse.text,
        gesture: quickResponse.gesture,
      },
      context_patch: {
        last_action: {
          type: 'INTERACTION_RESPONSE',
          quick_response: quickResponse.text,
          gesture: quickResponse.gesture,
          timestamp: Date.now(),
        },
        display_state: {
          current_gesture: quickResponse.gesture,
        },
      },
      completed_at: Date.now(),
    }
  }

  // ── ACTION_COMPLETED handler ──────────────────────────────────────────

  /**
   * When a backend agent (e.g. WorkAgent) completes its work:
   * 1. Interrupt filler audio
   * 2. Push real response audio
   * 3. Show happy gesture
   */
  private async handleActionCompleted(event: {
    session_id: string
    intent_id: string
    result: unknown
  }): Promise<void> {
    const { session_id, result } = event

    // Interrupt any filler audio
    await this.audioQueue.interrupt(session_id)

    // Push the real response
    const responseText = this.formatResult(result)
    await this.audioQueue.push(session_id, {
      segmentId: `response_${Date.now()}`,
      text: responseText,
      priority: 8, // higher than filler
    })

    // Resume playback (will play the real response)
    await this.audioQueue.continue(session_id)

    // Happy gesture
    await this.tenClient.displayGesture(session_id, 'happy')
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Format a task result into a speakable text.
   * Override this for custom formatting per intent.
   */
  protected formatResult(result: unknown): string {
    if (typeof result === 'string') return result
    if (result && typeof result === 'object' && 'text' in result) {
      return String((result as Record<string, unknown>).text)
    }
    return 'I have the results for you.'
  }
}
