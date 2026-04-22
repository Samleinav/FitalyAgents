import { closeDb } from '../storage/db.js'

export function buildShutdown(deps: {
  dbPath: string
  bundleStop: () => Promise<void>
  bundleDispose?: () => void
  httpClose: () => Promise<void>
  sttClose: () => void
  servicesDispose: Array<() => void>
  llmDispose: () => void
  memoryDispose?: () => void
}): () => Promise<void> {
  let shuttingDown = false

  return async () => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true

    deps.sttClose()

    await deps.httpClose().catch(() => {})
    await deps.bundleStop().catch(() => {})
    deps.bundleDispose?.()

    for (const dispose of deps.servicesDispose) {
      dispose()
    }

    deps.llmDispose()
    deps.memoryDispose?.()
    closeDb(deps.dbPath)
  }
}
