import { describe, expect, it } from 'vitest'
import { SentenceChunker } from './sentence-chunker.js'

describe('SentenceChunker', () => {
  it('emits complete sentences across fragmented chunks', () => {
    const chunker = new SentenceChunker()

    expect(chunker.push('session-1', 'Hola mundo')).toEqual([])
    expect(chunker.push('session-1', '. Segunda frase')).toEqual(['Hola mundo.'])
    expect(chunker.push('session-1', ' completa!')).toEqual(['Segunda frase completa!'])
    expect(chunker.flush('session-1')).toBeNull()
  })

  it('flushes the trailing remainder when no punctuation arrives', () => {
    const chunker = new SentenceChunker()

    chunker.push('session-2', 'Texto sin punto final')

    expect(chunker.flush('session-2')).toBe('Texto sin punto final')
    expect(chunker.flush('session-2')).toBeNull()
  })
})
