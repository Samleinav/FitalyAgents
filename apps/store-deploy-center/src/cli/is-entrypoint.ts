import { fileURLToPath } from 'node:url'

export function isEntrypoint(moduleUrl: string, argv: string[] = process.argv): boolean {
  return argv[1] != null && fileURLToPath(moduleUrl) === argv[1]
}
