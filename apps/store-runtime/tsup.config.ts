import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/main.ts',
    'src/external/avatar-service.ts',
    'src/external/customer-display.ts',
    'src/external/ui-bridge.ts',
    'src/external/livekit-voice-bridge.ts',
    'src/external/livekit-smoke.ts',
    'src/external/web-voice-bridge.ts',
    'src/external/demo-publisher.ts',
  ],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  outDir: 'dist',
})
