/**
 * Gesture types for the visual avatar / display.
 */
export type Gesture =
    | 'neutral'
    | 'listening'
    | 'thinking'
    | 'happy'
    | 'apologetic'
    | 'confirming'
    | 'surprised'
    | 'waiting'

/**
 * Quick response — a filler phrase while the real work is happening.
 */
export interface QuickResponse {
    text: string
    gesture: Gesture
}

/**
 * TEN Client interface — abstraction over the TEN Framework real-time API.
 *
 * In tests: use `MockTENClient` which stores calls and returns canned responses.
 * In production: connects to a TEN Agent server for ultra-low-latency TTS/STT.
 */
export interface ITENClient {
    /**
     * Generate a quick filler response while the main task is being processed.
     * Should resolve in <100ms.
     */
    generateQuickResponse(
        context: Record<string, unknown>,
        intentId: string,
    ): Promise<QuickResponse>

    /**
     * Send a display gesture command to the frontend avatar.
     */
    displayGesture(sessionId: string, gesture: Gesture): Promise<void>

    /**
     * Send a display order command (e.g. show product card).
     */
    displayOrder(sessionId: string, data: Record<string, unknown>): Promise<void>
}

/**
 * Dependencies for InteractionAgent.
 */
export interface InteractionAgentDeps {
    tenClient: ITENClient
}
