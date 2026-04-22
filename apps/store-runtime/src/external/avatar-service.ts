import dotenv from 'dotenv'
import {
  AIRIRenderer,
  AgentBundle,
  AvatarAgent,
  createBus,
  type IAvatarRenderer,
  type IEventBus,
} from 'fitalyagents'
import { isEntrypoint } from '../cli/is-entrypoint.js'
import { resolveConfigPath } from '../cli/resolve-config-path.js'
import { loadStoreConfig } from '../config/load-store-config.js'

export async function startAvatarService(deps: {
  configPath: string
  bus?: IEventBus
  renderer?: IAvatarRenderer
}): Promise<{
  shutdown(): Promise<void>
}> {
  const config = await loadStoreConfig(deps.configPath)

  if (!config.avatar.enabled) {
    throw new Error('Avatar service requires avatar.enabled=true in store config')
  }

  if (config.avatar.mode !== 'external') {
    throw new Error('Avatar service requires avatar.mode="external" in store config')
  }

  if (!config.avatar.airi_url && !deps.renderer) {
    throw new Error('Avatar service requires avatar.airi_url or a custom renderer override')
  }

  if (!deps.bus && config.providers.bus.driver !== 'redis') {
    throw new Error('External avatar service requires providers.bus.driver="redis"')
  }

  const bus =
    deps.bus ??
    (await createBus({
      redisUrl: config.providers.bus.driver === 'redis' ? config.providers.bus.url : undefined,
    }))
  const renderer = deps.renderer ?? new AIRIRenderer({ url: config.avatar.airi_url })
  const bundle = new AgentBundle({
    agents: [
      new AvatarAgent({
        bus,
        renderer,
      }),
    ],
  })

  await bundle.start()

  let closed = false

  return {
    async shutdown() {
      if (closed) {
        return
      }
      closed = true

      await bundle.stop().catch(() => {})
      if (!deps.bus && 'disconnect' in bus && typeof bus.disconnect === 'function') {
        await bus.disconnect().catch(() => {})
      }
    },
  }
}

async function main(): Promise<void> {
  dotenv.config()

  const configPath = resolveConfigPath(process.argv.slice(2))
  const service = await startAvatarService({ configPath })

  const shutdown = async () => {
    await service.shutdown()
  }

  process.on('SIGTERM', () => {
    void shutdown()
  })
  process.on('SIGINT', () => {
    void shutdown()
  })
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(
      '[store-runtime/avatar-service] Boot failed:',
      error instanceof Error ? error.message : error,
    )
    process.exitCode = 1
  })
}
