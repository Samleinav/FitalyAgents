import type { AvatarCommand, IAvatarRenderer } from './avatar-types.js'

export class MockAvatarRenderer implements IAvatarRenderer {
  readonly connected = true
  readonly commands: AvatarCommand[] = []

  async connect(): Promise<void> {}

  disconnect(): void {}

  async send(command: AvatarCommand): Promise<void> {
    this.commands.push(command)
  }

  clear(): void {
    this.commands.length = 0
  }
}
