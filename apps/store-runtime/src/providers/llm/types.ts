import type { IStreamingLLM } from 'fitalyagents'

export interface SessionBoundLLM extends IStreamingLLM {
  runWithSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T>
  abortSession(sessionId: string): void
  dispose(): void
}
