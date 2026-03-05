export class VoiceSimulator {
  private sttDelayMs: number
  private ttsDelayMs: number

  constructor(sttDelayMs = 150, ttsDelayMs = 250) {
    this.sttDelayMs = sttDelayMs
    this.ttsDelayMs = ttsDelayMs
  }

  /**
   * Simulates Speech-to-Text latency
   * @param text The input text as if it was spoken
   * @returns The resolved text after delay
   */
  async simulateSTT(text: string): Promise<string> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(text)
      }, this.sttDelayMs)
    })
  }

  /**
   * Simulates Text-to-Speech latency
   * @param text The text to be synthesized
   * @returns The synthesized text string representation after delay
   */
  async simulateTTS(text: string): Promise<string> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(`[🔊] ${text}`)
      }, this.ttsDelayMs)
    })
  }
}
