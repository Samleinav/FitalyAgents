import { describe, expect, it } from 'vitest'
import { DockerComposeDriver } from '../src/control/docker-compose-driver.js'
import type { CommandRunner } from '../src/control/command-runner.js'
import type { DeployCenterConfig } from '../src/config/schema.js'

describe('DockerComposeDriver', () => {
  it('builds docker compose commands for deploy, lifecycle, and logs', async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []
    const runner: CommandRunner = {
      async run(input) {
        calls.push(input)
        return {
          ...input,
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          ok: true,
        }
      },
    }

    const config: DeployCenterConfig = {
      project: {
        name: 'Deploy Center',
        store_config_path: '/tmp/store.config.json',
        compose_file_path: '/tmp/docker-compose.yml',
        working_directory: '/tmp',
        env_file_path: '/tmp/.env',
        env_example_path: '/tmp/.env.example',
        profiles: ['avatar'],
        logs_tail_lines: 180,
      },
      http: {
        host: '127.0.0.1',
        port: 3030,
      },
      services: [
        {
          id: 'store-runtime',
          label: 'Store Runtime',
          service_name: 'store-runtime',
          kind: 'runtime',
          enabled: true,
        },
      ],
      screens: [],
    }

    const driver = new DockerComposeDriver(config, runner)

    await driver.deployAll()
    await driver.stopAll()
    await driver.startService('store-runtime')
    await driver.stopService('store-runtime')
    await driver.restartService('store-runtime')
    await driver.serviceLogs('store-runtime')

    expect(calls[0]).toMatchObject({
      command: 'docker',
      args: [
        'compose',
        '-f',
        '/tmp/docker-compose.yml',
        '--profile',
        'avatar',
        'up',
        '-d',
        '--build',
      ],
      cwd: '/tmp',
    })
    expect(calls[1]).toMatchObject({
      args: ['compose', '-f', '/tmp/docker-compose.yml', 'down'],
    })
    expect(calls[2]).toMatchObject({
      args: [
        'compose',
        '-f',
        '/tmp/docker-compose.yml',
        '--profile',
        'avatar',
        'start',
        'store-runtime',
      ],
    })
    expect(calls[3]).toMatchObject({
      args: ['compose', '-f', '/tmp/docker-compose.yml', 'stop', 'store-runtime'],
    })
    expect(calls[4]).toMatchObject({
      args: ['compose', '-f', '/tmp/docker-compose.yml', 'restart', 'store-runtime'],
    })
    expect(calls[5]).toMatchObject({
      args: ['compose', '-f', '/tmp/docker-compose.yml', 'logs', '--tail', '180', 'store-runtime'],
    })
  })
})
