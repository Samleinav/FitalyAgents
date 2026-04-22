import type { DeployCenterConfig, DeployServiceConfig } from '../config/schema.js'
import type { CommandResult, CommandRunner } from './command-runner.js'

export interface DeploySupervisor {
  deployAll(): Promise<CommandResult>
  stopAll(): Promise<CommandResult>
  startService(serviceId: string): Promise<CommandResult>
  stopService(serviceId: string): Promise<CommandResult>
  restartService(serviceId: string): Promise<CommandResult>
  serviceLogs(serviceId: string, tailLines?: number): Promise<CommandResult>
}

export class DockerComposeDriver implements DeploySupervisor {
  constructor(
    private readonly config: DeployCenterConfig,
    private readonly runner: CommandRunner,
  ) {}

  deployAll(): Promise<CommandResult> {
    const args = [
      'compose',
      '-f',
      this.config.project.compose_file_path,
      ...this.buildProfileArgs(),
      'up',
      '-d',
      '--build',
    ]

    return this.runner.run({
      command: 'docker',
      args,
      cwd: this.config.project.working_directory,
    })
  }

  stopAll(): Promise<CommandResult> {
    const args = ['compose', '-f', this.config.project.compose_file_path, 'down']
    return this.runner.run({
      command: 'docker',
      args,
      cwd: this.config.project.working_directory,
    })
  }

  startService(serviceId: string): Promise<CommandResult> {
    const service = this.resolveService(serviceId)
    const args = [
      'compose',
      '-f',
      this.config.project.compose_file_path,
      ...this.buildProfileArgs(),
      'start',
      service.service_name,
    ]
    return this.runner.run({
      command: 'docker',
      args,
      cwd: this.config.project.working_directory,
    })
  }

  stopService(serviceId: string): Promise<CommandResult> {
    const service = this.resolveService(serviceId)
    const args = [
      'compose',
      '-f',
      this.config.project.compose_file_path,
      'stop',
      service.service_name,
    ]
    return this.runner.run({
      command: 'docker',
      args,
      cwd: this.config.project.working_directory,
    })
  }

  restartService(serviceId: string): Promise<CommandResult> {
    const service = this.resolveService(serviceId)
    const args = [
      'compose',
      '-f',
      this.config.project.compose_file_path,
      'restart',
      service.service_name,
    ]
    return this.runner.run({
      command: 'docker',
      args,
      cwd: this.config.project.working_directory,
    })
  }

  serviceLogs(
    serviceId: string,
    tailLines = this.config.project.logs_tail_lines,
  ): Promise<CommandResult> {
    const service = this.resolveService(serviceId)
    const args = [
      'compose',
      '-f',
      this.config.project.compose_file_path,
      'logs',
      '--tail',
      String(tailLines),
      service.service_name,
    ]
    return this.runner.run({
      command: 'docker',
      args,
      cwd: this.config.project.working_directory,
    })
  }

  private buildProfileArgs(): string[] {
    return this.config.project.profiles.flatMap((profile) => ['--profile', profile])
  }

  private resolveService(serviceId: string): DeployServiceConfig {
    const service = this.config.services.find((entry) => entry.id === serviceId)
    if (!service) {
      throw new Error(`Unknown deploy service: ${serviceId}`)
    }

    return service
  }
}
