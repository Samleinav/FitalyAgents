import path from 'node:path'

export function resolveConfigPath(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const configFlagIndex = args.findIndex((arg) => arg === '--config')
  if (configFlagIndex >= 0 && args[configFlagIndex + 1]) {
    return path.resolve(args[configFlagIndex + 1]!)
  }

  if (args[0] && !args[0]!.startsWith('-')) {
    return path.resolve(args[0]!)
  }

  if (env.DEPLOY_CENTER_CONFIG_PATH) {
    return path.resolve(env.DEPLOY_CENTER_CONFIG_PATH)
  }

  return path.resolve(process.cwd(), 'apps/store-deploy-center/deploy-center.config.json')
}
