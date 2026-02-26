import defaultMdxComponents from 'fumadocs-ui/mdx'

export function useMDXComponents(components: Record<string, unknown>): Record<string, unknown> {
  return {
    ...defaultMdxComponents,
    ...components,
  }
}
