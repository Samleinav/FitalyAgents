export class SentenceChunker {
  private readonly buffers = new Map<string, string>()

  push(sessionId: string, text: string): string[] {
    const next = `${this.buffers.get(sessionId) ?? ''}${text}`
    const sentences: string[] = []
    let lastIndex = 0

    const regex = /[^.!?…]+[.!?…]+["')\]]*\s*/g
    let match: RegExpExecArray | null

    while ((match = regex.exec(next)) !== null) {
      sentences.push(match[0].trim())
      lastIndex = regex.lastIndex
    }

    this.buffers.set(sessionId, next.slice(lastIndex))
    return sentences.filter(Boolean)
  }

  flush(sessionId: string): string | null {
    const remainder = this.buffers.get(sessionId)?.trim() ?? ''
    this.buffers.delete(sessionId)
    return remainder || null
  }

  reset(sessionId: string): void {
    this.buffers.delete(sessionId)
  }
}
