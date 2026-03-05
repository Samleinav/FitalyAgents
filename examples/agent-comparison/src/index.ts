import readline from 'readline'
import chalk from 'chalk'
import { DirectAgent, type DirectPhases } from './direct-agent.js'
import { FitalyPipeline, type FitalyPhases } from './fitaly-pipeline.js'
import {
  FitalyDispatcherPipeline,
  type DispatcherPhases,
  type LearningMode,
} from './fitaly-dispatcher-pipeline.js'
import { IntentTeacher, RETAIL_TEACHER_PROMPT, type TeacherResult } from './intent-teacher.js'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

console.log(chalk.bold.blue('\n FitalyAgents — 3-way Pipeline Comparison'))
console.log(chalk.gray('Tools have a simulated 300ms external-API latency.'))
console.log(
  chalk.gray(
    'Commands: "exit/quit" · "test" (benchmark) · "mode" (toggle training/production) · "scores" (score table)\n',
  ),
)

const directAgent = new DirectAgent()
const fitalyPipeline = new FitalyPipeline()

const teacher = new IntentTeacher({ instructionPrompt: RETAIL_TEACHER_PROMPT })

function onTeacherAction(result: TeacherResult, query: string): void {
  const icon =
    result.action === 'add'
      ? chalk.green('+ add')
      : result.action === 'flag'
        ? chalk.yellow('⚑ flag')
        : chalk.gray('~ skip')
  const detail =
    result.action === 'add'
      ? `"${result.normalized_text}" → ${chalk.cyan(result.target_intent)}`
      : `"${query.slice(0, 50)}" (${result.reason})`
  console.log(`  ${chalk.bold('[Teacher]')} ${icon}  ${detail}`)
}

const dispatcherPipeline = new FitalyDispatcherPipeline(
  150,
  250,
  'embedding',
  'training',
  './dispatcher-scores.json', // persists scores across sessions
  './teacher-examples.json', // persists teacher-added examples across sessions
  teacher,
  onTeacherAction,
)

// H. Non-blocking warm-up: model loads in background.
//    First query that arrives before it's ready uses keyword dispatcher (Level 1) automatically.
console.log(chalk.gray('Loading all-MiniLM-L6-v2 in background (Level 2 embedding dispatcher)…'))
dispatcherPipeline
  .warmup()
  .then(() => console.log(chalk.green('✓ Embedding dispatcher ready.\n')))
  .catch(() =>
    console.log(chalk.yellow('⚠ Embedding load failed — Level 1 (keyword) still active.\n')),
  )

// ─── Helpers ────────────────────────────────────────────────────────────────

function pad(s: string | number, width: number, right = false): string {
  const str = String(s)
  const spaces = ' '.repeat(Math.max(0, width - str.length))
  return right ? str + spaces : spaces + str
}

function formatFallbackLevel(level: string): string {
  switch (level) {
    case 'keyword':
      return chalk.green('[L1 keyword]')
    case 'embedding':
      return chalk.cyan('[L2 embedding]')
    case 'llm_classifier':
      return chalk.yellow('[L3 llm-cls]')
    default:
      return chalk.red('[L4 full-llm]')
  }
}

function formatOutcome(outcome: string | null): string {
  if (outcome === 'hit') return chalk.green('[HIT ✓]')
  if (outcome === 'correction') return chalk.yellow('[CORRECTION]')
  if (outcome === 'miss') return chalk.gray('[MISS]')
  return ''
}

function formatLearningMode(mode: LearningMode): string {
  return mode === 'production' ? chalk.green('[PROD]') : chalk.gray('[TRAIN]')
}

function printScoreTable(): void {
  const { mode, scores, hitRate } = dispatcherPipeline.getScoreStats()
  console.log(
    chalk.bold(
      `\n  Dispatcher scores  ${formatLearningMode(mode)}  hit rate: ${chalk.cyan(Math.round(hitRate * 100) + '%')}`,
    ),
  )
  if (scores.length === 0) {
    console.log(chalk.gray('  No speculations recorded yet.'))
    return
  }
  for (const s of scores) {
    const bar =
      '█'.repeat(Math.round(s.ema_score * 10)) + '░'.repeat(10 - Math.round(s.ema_score * 10))
    const conf =
      s.confidence === 'high'
        ? chalk.green(s.confidence)
        : s.confidence === 'medium'
          ? chalk.yellow(s.confidence)
          : s.confidence === 'low'
            ? chalk.red(s.confidence)
            : chalk.gray(s.confidence)
    const skip =
      mode === 'production' && !dispatcherPipeline.scoreStore.shouldSpeculate(s.tool_name)
        ? chalk.red(' [skip]')
        : ''
    console.log(
      `  ${pad(s.tool_name, 18, true)} ${bar}  ${(s.ema_score * 100).toFixed(0).padStart(3)}%  ${conf.padEnd(10)}  ${s.hits}H ${s.corrections}C${skip}`,
    )
  }
}

function makeFillerCallback(label: string, startRef: { t: number }) {
  let started = false
  return (token: string, done: boolean) => {
    if (!started && !done) {
      const ms = Math.round(performance.now() - startRef.t)
      process.stdout.write(`${chalk.bold(label)} ${chalk.italic.gray(`[filler → +${ms}ms]`)} `)
      started = true
    }
    if (done) {
      if (started) process.stdout.write('\n')
    } else {
      process.stdout.write(chalk.italic.gray(token))
    }
  }
}

function printBreakdown(
  dPhases: DirectPhases,
  fPhases: FitalyPhases,
  dPhases2: DispatcherPhases,
  dTotal: number,
  fTotal: number,
  d2Total: number,
) {
  const W = 22
  const C = 17
  const sep = '─'.repeat(W + C * 3 + 3)

  const row = (label: string, d: string, f: string, d2: string) => {
    console.log(`  ${pad(label, W, true)} ${pad(d, C)} ${pad(f, C)} ${pad(d2, C)}`)
  }
  const ms = (n: number) => (n > 0 ? n + 'ms' : '—')

  console.log(chalk.bold('\n  📊 Phase Breakdown:'))
  console.log(`  ${sep}`)
  console.log(
    `  ${pad('Phase', W, true)} ${pad('Direct', C)} ${pad('Fitaly', C)} ${pad('Fitaly+Dispatcher', C)}`,
  )
  console.log(`  ${sep}`)

  row('STT', ms(dPhases.stt), ms(fPhases.stt), ms(dPhases2.stt))
  row('Dispatcher', '—', '—', chalk.green(ms(dPhases2.dispatcher)))

  row(
    'LLM Turn 1',
    chalk.yellow(ms(dPhases.llm1)),
    chalk.yellow(ms(fPhases.llm1)),
    chalk.yellow(ms(dPhases2.llm1)),
  )

  if (fPhases.fillerFirstTokenMs >= 0 || dPhases2.dispatcherHit) {
    const fFiller = fPhases.fillerFirstTokenMs >= 0 ? `+${fPhases.fillerFirstTokenMs}ms` : '—'
    const d2Filler = dPhases2.dispatcherHit
      ? chalk.green(`+${dPhases2.dispatcher + dPhases2.stt}ms`)
      : '—'
    row('  filler TTFT', '—', chalk.green(fFiller), d2Filler)
  }

  const d2ToolCell =
    dPhases2.outcome === 'hit'
      ? chalk.green('0ms (cached ✓)')
      : dPhases2.toolWait > 0
        ? ms(dPhases2.toolWait)
        : '—'
  row(
    'Tool execution',
    ms(dPhases.tools) + ' (seq)',
    fPhases.toolsParallel > 0 ? ms(fPhases.toolsParallel) + ' (par ✓)' : ms(dPhases.tools),
    d2ToolCell,
  )

  row(
    'LLM Turn 2',
    chalk.yellow(ms(dPhases.llm2)),
    chalk.yellow(ms(fPhases.llm2)),
    dPhases2.llm2 > 0 ? chalk.yellow(ms(dPhases2.llm2)) : '—',
  )
  row('TTS', ms(dPhases.tts), ms(fPhases.tts), ms(dPhases2.tts))

  console.log(`  ${sep}`)

  const dFirst = dTotal
  const fFirst = fPhases.fillerFirstTokenMs >= 0 ? fPhases.fillerFirstTokenMs : fTotal
  const d2First = dPhases2.dispatcherHit
    ? dPhases2.stt + dPhases2.dispatcher // filler fires right after dispatcher classifies
    : d2Total

  row('Total', chalk.cyan(ms(dTotal)), chalk.cyan(ms(fTotal)), chalk.cyan(ms(d2Total)))
  row('First feedback', chalk.red(ms(dFirst)), chalk.yellow(ms(fFirst)), chalk.green(ms(d2First)))

  const gainFitaly = dTotal - fFirst
  const gainDispatcher = dTotal - d2First
  if (gainDispatcher > gainFitaly) {
    console.log(
      chalk.bold.green(
        `\n  ✓ Dispatcher delivered first feedback ${gainDispatcher}ms earlier than Direct (${Math.round((gainDispatcher / dTotal) * 100)}% sooner)`,
      ),
    )
  }
}

function printSpeedGapAnalysis(llm1Ms: number) {
  console.log(chalk.bold.yellow('\n  \u26A1 Speed Analysis — two separate questions:\n'))

  console.log(chalk.bold('  Q1. How do ALL pipelines reach sub-300ms? (universal improvements)'))
  console.log(chalk.gray('      These changes close the gap for every architecture equally.\n'))

  const q1: [string, string, string][] = [
    ['Component', 'This demo', 'With fast stack'],
    ['─────────────────────', '─────────────────────────── ', '──────────────────────────────'],
    ['LLM model', 'GPT-5.2 via OpenRouter', 'llama-3.1-8b on Groq (~80ms TTFT)'],
    ['LLM TTFT', `~${llm1Ms}ms`, '50–120ms'],
    ['LLM delivery', 'blocking (full response)', 'streaming → TTS on 1st sentence'],
    ['TTS', '250ms simulated', 'ElevenLabs Flash ~75ms first chunk'],
    ['Net result', `~${llm1Ms * 2 + 250}ms both`, '~250–450ms for all pipelines'],
  ]
  for (const [a, b, c] of q1) {
    console.log(`    ${chalk.gray(pad(a, 22, true))} ${pad(b, 33, true)} ${chalk.cyan(c)}`)
  }

  console.log(chalk.bold('\n  Q2. What does each architecture add on top? (pipeline-specific)\n'))

  const q2: [string, string, string, string][] = [
    ['Feature', 'Direct', 'Fitaly', 'Fitaly+Dispatcher'],
    [
      '─────────────────────',
      '──────────────────────',
      '──────────────────────── ',
      '──────────────────────────',
    ],
    ['Parallel tools', 'N × tool_ms', '1 × tool_ms ✓', '1 × tool_ms ✓'],
    [
      'Filler response',
      'none',
      'at LLM Turn 1 end',
      'at dispatcher end (~' + (llm1Ms - 100) + 'ms sooner)',
    ],
    ['LLM calls per turn', '2 (with tools)', '2 (with tools)', '1 ✓ (tools pre-fetched)'],
    ['Why embed > LLM', '—', '—', '1–5ms vs 80–200ms TTFT'],
  ]
  for (const [a, b, c, d] of q2) {
    console.log(
      `    ${chalk.gray(pad(a, 22, true))} ${pad(b, 23, true)} ${pad(c, 27, true)} ${chalk.green(d)}`,
    )
  }

  console.log(chalk.gray('\n  Embedding classifier (all-MiniLM-L6-v2, 22M params):'))
  console.log(chalk.gray('    • 1–5ms CPU / <1ms Rust+candle  vs  80–200ms for any generative LLM'))
  console.log(chalk.gray('    • Deterministic — no hallucinated tool names or parameters'))
  console.log(chalk.gray('    • Fine-tunable on your own intent schema in minutes'))
  console.log(
    chalk.gray('    • Does not need to generate tokens — just a cosine similarity lookup'),
  )
}

// ─── Interactive mode ────────────────────────────────────────────────────────

async function prompt() {
  rl.question(chalk.green('You: '), async (input) => {
    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      rl.close()
      process.exit(0)
    }
    if (input.toLowerCase() === 'test') {
      await runBenchmark()
      prompt()
      return
    }
    if (input.toLowerCase() === 'scores') {
      printScoreTable()
      console.log()
      prompt()
      return
    }
    if (input.toLowerCase() === 'mode') {
      const next: LearningMode =
        dispatcherPipeline.getLearningMode() === 'training' ? 'production' : 'training'
      dispatcherPipeline.setLearningMode(next)
      const msg =
        next === 'production'
          ? chalk.green('Switched to PRODUCTION mode — low-confidence tools will be skipped.')
          : chalk.gray('Switched to TRAINING mode — all speculations active.')
      console.log(msg)
      printScoreTable()
      console.log()
      prompt()
      return
    }
    if (!input.trim()) {
      prompt()
      return
    }

    try {
      console.log(chalk.yellow('\nRunning Direct Agent (Baseline)...'))
      const dResult = await directAgent.run(input)
      console.log(`${chalk.bold('[Direct]')} Response: ${dResult.text}`)
      console.log(`${chalk.bold('[Direct]')} Latency: ${chalk.cyan(dResult.latencyMs + 'ms')}\n`)

      console.log(chalk.magenta('Running Fitaly Pipeline...'))
      const fRef = { t: performance.now() }
      const fResult = await fitalyPipeline.run(input, makeFillerCallback('[Fitaly]', fRef))
      console.log(`${chalk.bold('[Fitaly]')} Response: ${fResult.text}`)
      console.log(`${chalk.bold('[Fitaly]')} Latency: ${chalk.cyan(fResult.latencyMs + 'ms')}\n`)

      console.log(chalk.blue('Running Fitaly + Dispatcher...'))
      const dRef = { t: performance.now() }
      const d2Result = await dispatcherPipeline.run(input, makeFillerCallback('[Dispatcher]', dRef))
      const hitLabel = formatFallbackLevel(d2Result.phases.fallbackLevel)
      const outcomeLabel = formatOutcome(d2Result.phases.outcome)
      const modeLabel = formatLearningMode(dispatcherPipeline.getLearningMode())
      console.log(
        `${chalk.bold('[Dispatcher]')} ${modeLabel} ${hitLabel} ${outcomeLabel} Response: ${d2Result.text}`,
      )
      console.log(
        `${chalk.bold('[Dispatcher]')} Latency: ${chalk.cyan(d2Result.latencyMs + 'ms')}\n`,
      )

      printBreakdown(
        dResult.phases,
        fResult.phases,
        d2Result.phases,
        dResult.latencyMs,
        fResult.latencyMs,
        d2Result.latencyMs,
      )
    } catch (e: any) {
      console.error(chalk.red('Error:'), e.message)
    }

    prompt()
  })
}

// ─── Benchmark mode ──────────────────────────────────────────────────────────

async function runBenchmark() {
  const scenarios = [
    {
      label: 'Scenario A — Single tool (search)',
      note: 'product_search call. Dispatcher should hit with high confidence.',
      query: 'What Nike shoes do you have?',
    },
    {
      label: 'Scenario B — Product detail by ID',
      note: 'product_detail call. Dispatcher detects P001/P002 IDs directly.',
      query: 'Give me the full details of product P001.',
    },
    {
      label: 'Scenario C — Two product details',
      note: 'Fitaly parallelizes both; Dispatcher pre-fetches first, Fitaly handles second.',
      query: 'Give me the full details of product P001 and product P002.',
    },
  ]

  console.log(chalk.bold.yellow('\n--- Running Automated Benchmark ---'))
  console.log(chalk.gray('Tool latency: 300ms per call (simulated external API)\n'))

  let dTotal = 0,
    fTotal = 0,
    d2Total = 0
  let totalLlm1Ms = 0

  for (const s of scenarios) {
    console.log(chalk.bold.blue(`\n${s.label}`))
    console.log(chalk.gray(`  ${s.note}`))
    console.log(chalk.gray(`  Query: "${s.query}"`))

    const dResult = await directAgent.run(s.query)
    dTotal += dResult.latencyMs
    console.log(`  Direct:          ${chalk.cyan(dResult.latencyMs + 'ms')}`)

    const fRef = { t: performance.now() }
    const fResult = await fitalyPipeline.run(s.query, makeFillerCallback('  [Fitaly filler]', fRef))
    fTotal += fResult.latencyMs
    totalLlm1Ms += fResult.phases.llm1
    console.log(`  Fitaly:          ${chalk.cyan(fResult.latencyMs + 'ms')}`)

    const dRef = { t: performance.now() }
    const d2Result = await dispatcherPipeline.run(
      s.query,
      makeFillerCallback('  [Dispatch filler]', dRef),
    )
    d2Total += d2Result.latencyMs
    console.log(
      `  Fitaly+Dispatch: ${chalk.cyan(d2Result.latencyMs + 'ms')} (${formatFallbackLevel(d2Result.phases.fallbackLevel)} ${formatOutcome(d2Result.phases.outcome)} ${formatLearningMode(dispatcherPipeline.getLearningMode())})`,
    )

    printBreakdown(
      dResult.phases,
      fResult.phases,
      d2Result.phases,
      dResult.latencyMs,
      fResult.latencyMs,
      d2Result.latencyMs,
    )
  }

  const n = scenarios.length
  console.log(chalk.bold('\n--- Benchmark Summary ---'))
  console.log(`Average Direct:          ${Math.round(dTotal / n)}ms`)
  console.log(`Average Fitaly:          ${Math.round(fTotal / n)}ms`)
  console.log(`Average Fitaly+Dispatch: ${Math.round(d2Total / n)}ms`)
  const d2Gain = Math.round((dTotal - d2Total) / n)
  const d2Str =
    d2Gain > 0
      ? chalk.green(`-${d2Gain}ms faster than Direct`)
      : chalk.red(`+${Math.abs(d2Gain)}ms`)
  console.log(`Dispatcher gain vs Direct: ${d2Str}`)
  const hitRate = dispatcherPipeline.registry.getHitRate()
  const savedMs = dispatcherPipeline.registry.getTotalSavedMs()
  console.log(
    `Dispatcher hit rate: ${chalk.cyan(Math.round(hitRate * 100) + '%')} (${chalk.green(savedMs + 'ms')} tool latency saved total)`,
  )

  printScoreTable()

  // Auto-suggest switching to production when dispatcher is reliable
  if (hitRate >= 0.9 && dispatcherPipeline.getLearningMode() === 'training') {
    console.log(
      chalk.bold.green(
        '\n  ✓ Hit rate >= 90% — type "mode" to switch to PRODUCTION (low-confidence tools skipped).',
      ),
    )
  }

  printSpeedGapAnalysis(Math.round(totalLlm1Ms / n))
  console.log()
}

prompt()
