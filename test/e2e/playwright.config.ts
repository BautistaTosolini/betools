import { defineConfig } from '@playwright/test'

// Pruebas de punta a punta: la app compilada (out/) en Electron, con un "claude" falso (fake-claude.mjs).
// Correr con `npm run test:e2e` (compila antes).
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: '../../test-results'
})
