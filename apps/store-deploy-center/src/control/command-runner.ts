import { spawn } from 'node:child_process'

export interface CommandResult {
  command: string
  args: string[]
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  ok: boolean
}

export interface CommandRunner {
  run(input: { command: string; args: string[]; cwd: string }): Promise<CommandResult>
}

export function createNodeCommandRunner(): CommandRunner {
  return {
    run(input) {
      return new Promise((resolve, reject) => {
        const child = spawn(input.command, input.args, {
          cwd: input.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''

        child.stdout.on('data', (chunk) => {
          stdout += String(chunk)
        })
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk)
        })

        child.on('error', (error) => {
          reject(error)
        })

        child.on('close', (exitCode) => {
          resolve({
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            exitCode: exitCode ?? 1,
            stdout,
            stderr,
            ok: (exitCode ?? 1) === 0,
          })
        })
      })
    },
  }
}
