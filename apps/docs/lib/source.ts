import { docs } from '@/.source'
import { loader } from 'fumadocs-core/source'
import { createMDXSource } from 'fumadocs-mdx'

const src = createMDXSource(docs.docs, docs.meta)
// fumadocs-mdx v11 wraps `files` as a lazy function at runtime,
// but fumadocs-core v15 calls files.map() expecting a plain array.
const files = (src.files as unknown as () => typeof src.files)()

export const source = loader({
  baseUrl: '/docs',
  source: { ...src, files },
})
