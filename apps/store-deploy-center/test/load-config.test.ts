import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadDeployCenterConfig } from '../src/config/load-config.js'
import { cleanupTempDir, createTempDir, writeJsonFile } from '../../store-runtime/test/helpers.js'

describe('loadDeployCenterConfig', () => {
  it('resolves project paths relative to the deploy-center config file', async () => {
    const dir = await createTempDir('deploy-center-config-')

    try {
      const configPath = path.join(dir, 'deploy-center.config.json')
      await writeJsonFile(configPath, {
        project: {
          name: 'Test Deploy Center',
          store_config_path: './config/store.config.json',
          compose_file_path: './runtime/docker-compose.yml',
          working_directory: './runtime',
          env_file_path: './runtime/.env',
          env_example_path: './runtime/.env.example',
          profiles: ['avatar'],
          logs_tail_lines: 150,
        },
        http: {
          host: '127.0.0.1',
          port: 4040,
        },
      })

      const config = await loadDeployCenterConfig(configPath)

      expect(config.project.store_config_path).toBe(path.join(dir, 'config/store.config.json'))
      expect(config.project.compose_file_path).toBe(path.join(dir, 'runtime/docker-compose.yml'))
      expect(config.project.working_directory).toBe(path.join(dir, 'runtime'))
      expect(config.project.env_file_path).toBe(path.join(dir, 'runtime/.env'))
      expect(config.project.env_example_path).toBe(path.join(dir, 'runtime/.env.example'))
      expect(config.services.length).toBeGreaterThan(0)
      expect(config.screens.length).toBeGreaterThan(0)
    } finally {
      await cleanupTempDir(dir)
    }
  })
})
