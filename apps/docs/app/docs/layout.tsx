import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { source } from '@/lib/source'
import type { ReactNode } from 'react'

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: (
          <span className="font-bold text-base">
            FitalyAgents
          </span>
        ),
        url: '/docs',
      }}
      links={[
        {
          text: 'GitHub',
          url: 'https://github.com/your-org/fitalyagents',
          external: true,
        },
        {
          text: 'npm',
          url: 'https://www.npmjs.com/package/fitalyagents',
          external: true,
        },
      ]}
    >
      {children}
    </DocsLayout>
  )
}
