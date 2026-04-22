import dotenv from 'dotenv'
import { resolveConfigPath } from './cli/resolve-config-path.js'
import { isEntrypoint } from './cli/is-entrypoint.js'
import { loadDeployCenterConfig } from './config/load-config.js'
import { createNodeCommandRunner } from './control/command-runner.js'
import { DockerComposeDriver } from './control/docker-compose-driver.js'
import { buildDeployCenterServer } from './server/app.js'
import { StoreProjectService } from './services/store-project-service.js'

export async function startDeployCenter(configPath: string): Promise<{
  shutdown(): Promise<void>
}> {
  const config = await loadDeployCenterConfig(configPath)
  const projectService = new StoreProjectService(config)
  const supervisor = new DockerComposeDriver(config, createNodeCommandRunner())
  const server = buildDeployCenterServer({
    config,
    projectService,
    supervisor,
  })

  await server.listen({
    host: config.http.host,
    port: config.http.port,
  })

  let closed = false

  return {
    async shutdown() {
      if (closed) {
        return
      }
      closed = true
      await server.close()
    },
  }
}

async function main(): Promise<void> {
  dotenv.config()

  const configPath = resolveConfigPath(process.argv.slice(2))
  const service = await startDeployCenter(configPath)

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
      '[store-deploy-center] Boot failed:',
      error instanceof Error ? error.message : error,
    )
    process.exitCode = 1
  })
}
