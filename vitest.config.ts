import { defineConfig } from 'vitest/config'

// Pruebas unitarias e de integración (sin Electron). Las de punta a punta están en test/e2e (Playwright).
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    // HOME temporal por archivo: ninguna prueba lee ni escribe el ~/.claude real.
    setupFiles: ['test/unit/setup-home.ts'],
    testTimeout: 15_000
  }
})
