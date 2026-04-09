export interface AaakCompressionMetadata {
  source_file?: string
  wing?: string
  room?: string
  date?: string
}

export interface AaakDialectOptions {
  entities?: Record<string, string>
  skipNames?: string[]
}

export interface AaakDialectLike {
  compress(text: string, metadata?: AaakCompressionMetadata): string
}

const EMOTION_SIGNALS: Record<string, string> = {
  decided: 'determ',
  prefer: 'convict',
  worried: 'anx',
  excited: 'excite',
  frustrated: 'frust',
  confused: 'confuse',
  love: 'love',
  hate: 'rage',
  hope: 'hope',
  fear: 'fear',
  trust: 'trust',
  happy: 'joy',
  sad: 'grief',
  surprised: 'surprise',
  grateful: 'grat',
  curious: 'curious',
  wonder: 'wonder',
  anxious: 'anx',
  relieved: 'relief',
  satisf: 'satis',
  disappoint: 'grief',
  concern: 'anx',
}

const FLAG_SIGNALS: Record<string, string> = {
  decided: 'DECISION',
  chose: 'DECISION',
  switched: 'DECISION',
  migrated: 'DECISION',
  replaced: 'DECISION',
  'instead of': 'DECISION',
  because: 'DECISION',
  founded: 'ORIGIN',
  created: 'ORIGIN',
  started: 'ORIGIN',
  born: 'ORIGIN',
  launched: 'ORIGIN',
  'first time': 'ORIGIN',
  core: 'CORE',
  fundamental: 'CORE',
  essential: 'CORE',
  principle: 'CORE',
  belief: 'CORE',
  always: 'CORE',
  'never forget': 'CORE',
  'turning point': 'PIVOT',
  'changed everything': 'PIVOT',
  realized: 'PIVOT',
  breakthrough: 'PIVOT',
  epiphany: 'PIVOT',
  api: 'TECHNICAL',
  database: 'TECHNICAL',
  architecture: 'TECHNICAL',
  deploy: 'TECHNICAL',
  infrastructure: 'TECHNICAL',
  algorithm: 'TECHNICAL',
  framework: 'TECHNICAL',
  server: 'TECHNICAL',
  config: 'TECHNICAL',
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'about',
  'between',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'up',
  'down',
  'out',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'all',
  'each',
  'every',
  'both',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'nor',
  'not',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
  'just',
  'don',
  'now',
  'and',
  'but',
  'or',
  'if',
  'while',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'i',
  'we',
  'you',
  'he',
  'she',
  'they',
  'me',
  'him',
  'her',
  'us',
  'them',
  'my',
  'your',
  'his',
  'our',
  'their',
  'what',
  'which',
  'who',
  'whom',
  'also',
  'much',
  'many',
  'like',
  'because',
  'since',
  'get',
  'got',
  'use',
  'used',
  'using',
  'make',
  'made',
  'thing',
  'things',
  'way',
  'well',
  'really',
  'want',
  'need',
])

const PROPER_WORD_RE = /^\p{Lu}\p{Ll}+$/u
const TOPIC_RE = /[\p{L}][\p{L}\p{N}_-]{2,}/gu

export class AaakDialect implements AaakDialectLike {
  private readonly entityCodes = new Map<string, string>()
  private readonly skipNames: string[]

  constructor(options: AaakDialectOptions = {}) {
    this.skipNames = (options.skipNames ?? []).map((name) => name.toLowerCase())

    for (const [name, code] of Object.entries(options.entities ?? {})) {
      this.entityCodes.set(name, code)
      this.entityCodes.set(name.toLowerCase(), code)
    }
  }

  compress(text: string, metadata: AaakCompressionMetadata = {}): string {
    const entities = this.detectEntities(text)
    const entityStr = entities.length > 0 ? entities.join('+') : '???'

    const topics = this.extractTopics(text)
    const topicStr = topics.length > 0 ? topics.join('_') : 'misc'

    const quote = this.extractKeySentence(text)
    const emotions = this.detectEmotions(text)
    const flags = this.detectFlags(text)

    const lines: string[] = []
    if (metadata.source_file || metadata.wing || metadata.room || metadata.date) {
      lines.push(
        [
          metadata.wing ?? '?',
          metadata.room ?? '?',
          metadata.date ?? '?',
          basenameWithoutExtension(metadata.source_file),
        ].join('|'),
      )
    }

    const parts = [`0:${entityStr}`, topicStr]
    if (quote) parts.push(`"${quote}"`)
    if (emotions.length > 0) parts.push(emotions.join('+'))
    if (flags.length > 0) parts.push(flags.join('+'))
    lines.push(parts.join('|'))

    return lines.join('\n')
  }

  private detectEmotions(text: string): string[] {
    const lowered = text.toLowerCase()
    const detected: string[] = []
    const seen = new Set<string>()

    for (const [keyword, code] of Object.entries(EMOTION_SIGNALS)) {
      if (lowered.includes(keyword) && !seen.has(code)) {
        detected.push(code)
        seen.add(code)
      }
    }

    return detected.slice(0, 3)
  }

  private detectFlags(text: string): string[] {
    const lowered = text.toLowerCase()
    const detected: string[] = []
    const seen = new Set<string>()

    for (const [keyword, flag] of Object.entries(FLAG_SIGNALS)) {
      if (lowered.includes(keyword) && !seen.has(flag)) {
        detected.push(flag)
        seen.add(flag)
      }
    }

    return detected.slice(0, 3)
  }

  private extractTopics(text: string, maxTopics = 3): string[] {
    const matches = text.match(TOPIC_RE) ?? []
    const freq = new Map<string, number>()

    for (const word of matches) {
      const lowered = word.toLowerCase()
      if (STOP_WORDS.has(lowered) || lowered.length < 3) continue
      freq.set(lowered, (freq.get(lowered) ?? 0) + 1)
    }

    for (const word of matches) {
      const lowered = word.toLowerCase()
      if (STOP_WORDS.has(lowered) || !freq.has(lowered)) continue

      if (startsUppercase(word)) {
        freq.set(lowered, (freq.get(lowered) ?? 0) + 2)
      }

      if (word.includes('_') || word.includes('-') || hasInternalUppercase(word)) {
        freq.set(lowered, (freq.get(lowered) ?? 0) + 2)
      }
    }

    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxTopics)
      .map(([word]) => word)
  }

  private extractKeySentence(text: string): string {
    const sentences = text
      .split(/[.!?\n]+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 10)

    if (sentences.length === 0) return ''

    const decisionWords = [
      'decided',
      'because',
      'instead',
      'prefer',
      'switched',
      'chose',
      'realized',
      'important',
      'key',
      'critical',
      'discovered',
      'learned',
      'conclusion',
      'solution',
      'reason',
      'why',
      'breakthrough',
      'insight',
    ]

    const scored = sentences
      .map((sentence) => {
        const lowered = sentence.toLowerCase()
        let score = 0

        for (const word of decisionWords) {
          if (lowered.includes(word)) score += 2
        }

        if (sentence.length < 80) score += 1
        if (sentence.length < 40) score += 1
        if (sentence.length > 150) score -= 2

        return { score, sentence }
      })
      .sort((a, b) => b.score - a.score)

    const best = scored[0]?.sentence ?? ''
    if (best.length <= 55) return best
    return `${best.slice(0, 52)}...`
  }

  private detectEntities(text: string): string[] {
    const found: string[] = []
    const lowered = text.toLowerCase()

    for (const [name, code] of this.entityCodes.entries()) {
      if (name !== name.toLowerCase()) continue
      if (lowered.includes(name) && !found.includes(code)) {
        found.push(code)
      }
    }

    if (found.length > 0) return found.slice(0, 3)

    const words = text.split(/\s+/)
    for (let index = 0; index < words.length; index++) {
      const clean = words[index]?.replace(/[^\p{L}]/gu, '') ?? ''
      if (clean.length < 2) continue
      if (this.skipNames.some((name) => clean.toLowerCase().includes(name))) continue
      if (index === 0) continue
      if (!PROPER_WORD_RE.test(clean)) continue
      if (STOP_WORDS.has(clean.toLowerCase())) continue

      const code = clean.slice(0, 3).toUpperCase()
      if (!found.includes(code)) {
        found.push(code)
      }

      if (found.length >= 3) break
    }

    return found
  }
}

function startsUppercase(word: string): boolean {
  const first = word[0]
  return typeof first === 'string'
    ? first.toUpperCase() === first && first.toLowerCase() !== first
    : false
}

function hasInternalUppercase(word: string): boolean {
  return word
    .slice(1)
    .split('')
    .some((char) => char.toUpperCase() === char && char.toLowerCase() !== char)
}

function basenameWithoutExtension(path?: string): string {
  if (!path) return '?'
  const basename = path.split(/[\\/]/).pop() ?? ''
  const withoutExt = basename.replace(/\.[^.]+$/, '')
  return withoutExt || '?'
}
