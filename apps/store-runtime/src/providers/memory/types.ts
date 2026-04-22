import {
  InMemoryMemoryStore,
  MemPalaceCliTransport,
  MemPalaceMemoryStore,
  type IMemoryStore,
} from '@fitalyagents/dispatcher'
import type { StoreConfig } from '../../config/schema.js'
import { SqliteMemoryStore } from './sqlite-memory-store.js'

export function createMemoryStore(
  config: StoreConfig['providers']['memory'],
  sqlitePath: string,
): IMemoryStore {
  switch (config.driver) {
    case 'inmemory':
      return new InMemoryMemoryStore()
    case 'sqlite':
      return new SqliteMemoryStore({ path: sqlitePath })
    case 'mempalace':
      return new MemPalaceMemoryStore({
        transport: new MemPalaceCliTransport({
          palacePath: config.palace_path,
        }),
      })
  }
}
