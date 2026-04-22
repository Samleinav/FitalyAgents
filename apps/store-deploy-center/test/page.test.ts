import { describe, expect, it } from 'vitest'
import { renderDeployCenterHtml } from '../src/ui/page.js'

describe('renderDeployCenterHtml', () => {
  it('renders the deploy wizard and quick actions', () => {
    const html = renderDeployCenterHtml({
      projectName: 'Wizard Test',
    })

    expect(html).toContain('Wizard De Deploy')
    expect(html).toContain('Guardar Todo y Deploy')
    expect(html).toContain('Presets Guiados')
  })
})
