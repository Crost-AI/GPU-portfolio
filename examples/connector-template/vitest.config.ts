import { defineConfig } from 'vitest/config'

// Its own config, so the parent repo's vitest.config.ts is not picked up when this folder sits
// inside the Portfolio checkout.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })
