import { AvatarAgent, InMemoryBus, MockAvatarRenderer, type AvatarCommand } from 'fitalyagents'

class NamedRenderer extends MockAvatarRenderer {
  constructor(private readonly name: string) {
    super()
  }

  print(): void {
    console.log(`\n${this.name}`)
    console.log('-'.repeat(this.name.length))
    for (const command of this.commands) {
      console.log(formatCommand(command))
    }
  }
}

function formatCommand(command: AvatarCommand): string {
  switch (command.type) {
    case 'state':
      return `state -> ${command.state}`
    case 'expression':
      return `expression -> ${command.expression}`
    case 'speak':
      return `speak -> "${command.text}" final=${String(command.is_final)}`
    case 'look_at':
      return `look_at -> ${command.target_id ?? command.speaker_id ?? 'unknown'}`
  }
}

async function runScenario(name: string, renderer: NamedRenderer): Promise<void> {
  const bus = new InMemoryBus()
  const avatar = new AvatarAgent({
    bus,
    renderer,
    intentExpressionMap: {
      product_search: 'helpful',
      order_confirmed: 'happy',
      complaint: 'empathetic',
    },
  })

  await avatar.start()

  await bus.publish('bus:TARGET_GROUP_CHANGED', {
    event: 'TARGET_GROUP_CHANGED',
    store_id: 'store_001',
    primary: 'cust_ana',
    queued: ['cust_ben'],
    ambient: [],
    speakers: [{ speakerId: 'cust_ana', state: 'targeted' }],
    timestamp: Date.now(),
  })

  await bus.publish('bus:TASK_AVAILABLE', {
    event: 'TASK_AVAILABLE',
    session_id: 'floor_session_1',
    intent_id: 'product_search',
  })

  await bus.publish('bus:RESPONSE_START', {
    event: 'RESPONSE_START',
    session_id: 'floor_session_1',
    speaker_id: 'cust_ana',
    turn_id: `${name}_turn_1`,
    intent_id: 'product_search',
    timestamp: Date.now(),
  })

  await bus.publish('bus:AVATAR_SPEAK', {
    event: 'AVATAR_SPEAK',
    session_id: 'floor_session_1',
    speaker_id: 'cust_ana',
    turn_id: `${name}_turn_1`,
    intent_id: 'product_search',
    text: 'I found three sneakers in your size.',
    is_final: true,
    timestamp: Date.now(),
  })

  await bus.publish('bus:RESPONSE_END', {
    event: 'RESPONSE_END',
    session_id: 'floor_session_1',
    speaker_id: 'cust_ana',
    turn_id: `${name}_turn_1`,
    reason: 'end_turn',
    timestamp: Date.now(),
  })

  await bus.publish('bus:DRAFT_CREATED', {
    event: 'DRAFT_CREATED',
    draft_id: 'draft_001',
    session_id: 'floor_session_1',
    intent_id: 'order_create',
    summary: { item: 'sneakers', size: 42 },
    ttl: 120,
  })

  await bus.publish('bus:APPROVAL_RESOLVED', {
    event: 'APPROVAL_RESOLVED',
    request_id: 'approval_001',
    draft_id: 'draft_001',
    approved: true,
    approver_id: 'manager_1',
    channel_used: 'voice',
    timestamp: Date.now(),
  })

  await avatar.stop()
  renderer.print()
}

async function main(): Promise<void> {
  console.log('Avatar retail example')
  console.log('=====================')

  await runScenario('In-store kiosk renderer', new NamedRenderer('In-store kiosk renderer'))
  await runScenario('Web avatar renderer', new NamedRenderer('Web avatar renderer'))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
