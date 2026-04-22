import { bootstrap } from './bootstrap/bootstrap.js'
import { isEntrypoint } from './cli/is-entrypoint.js'
import { resolveConfigPath } from './cli/resolve-config-path.js'

async function main(): Promise<void> {
  const configPath = resolveConfigPath(process.argv.slice(2))
  const shutdown = await bootstrap(configPath)

  process.on('uncaughtException', (error) => {
    console.error('[store-runtime] Uncaught exception:', error)
    void shutdown().finally(() => {
      process.exitCode = 1
    })
  })

  process.on('unhandledRejection', (error) => {
    console.error('[store-runtime] Unhandled rejection:', error)
    void shutdown().finally(() => {
      process.exitCode = 1
    })
  })
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error('[store-runtime] Boot failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
