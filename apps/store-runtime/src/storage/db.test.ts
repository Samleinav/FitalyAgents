import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveMigrationsDir } from './db.js'

describe('db migration resolution', () => {
  it('finds migrations next to the source module', () => {
    expect(resolveMigrationsDir(import.meta.url)).toBe(
      path.resolve(process.cwd(), 'src/storage/migrations'),
    )
  })

  it('falls back to src migrations when running from dist', () => {
    const distModuleUrl = pathToFileURL(path.resolve(process.cwd(), 'dist/storage/db.js')).href

    expect(resolveMigrationsDir(distModuleUrl)).toBe(
      path.resolve(process.cwd(), 'src/storage/migrations'),
    )
  })
})
