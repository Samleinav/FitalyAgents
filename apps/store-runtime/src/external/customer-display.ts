import dotenv from 'dotenv'
import { isEntrypoint } from '../cli/is-entrypoint.js'
import { resolveConfigPath } from '../cli/resolve-config-path.js'
import { startCustomerDisplayService } from '../retail/ui/customer-display-bridge.js'

async function main(): Promise<void> {
  dotenv.config()

  const configPath = resolveConfigPath(process.argv.slice(2))
  const service = await startCustomerDisplayService({ configPath })

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
      '[store-runtime/customer-display] Boot failed:',
      error instanceof Error ? error.message : error,
    )
    process.exitCode = 1
  })
}
