import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Unit tests run in plain Node against the pure, dependency-light modules
// (captions, encoder selection, scraper ordering, sanitizers). Modules that pull in
// electron/native addons are intentionally not imported here.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared'),
      '@': resolve(__dirname, 'src'),
      '@sentry/electron/main': resolve(__dirname, 'test/stubs/sentry-electron.ts'),
      // Stub electron + electron-log so modules that transitively import them
      // (logger, ytdlp, render) can be unit-tested in plain Node.
      electron: resolve(__dirname, 'test/stubs/electron.ts'),
      'electron-log/main': resolve(__dirname, 'test/stubs/electron-log.ts'),
      'electron-store': resolve(__dirname, 'test/stubs/electron-store.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts']
  }
})
