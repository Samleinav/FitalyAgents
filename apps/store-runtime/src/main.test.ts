import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfigPath } from './cli/resolve-config-path.js'

describe('resolveConfigPath', () => {
  it('prefers --config over STORE_CONFIG_PATH', () => {
    expect(
      resolveConfigPath(['--config', './custom/store.config.json'], {
        STORE_CONFIG_PATH: './ignored/store.config.json',
      }),
    ).toBe(path.resolve('./custom/store.config.json'))
  })

  it('uses STORE_CONFIG_PATH when no CLI arg is provided', () => {
    expect(
      resolveConfigPath([], {
        STORE_CONFIG_PATH: './deploy/store.config.redis.json',
      }),
    ).toBe(path.resolve('./deploy/store.config.redis.json'))
  })
})
