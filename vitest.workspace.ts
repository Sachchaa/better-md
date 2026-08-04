import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    test: {
      name: 'app',
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
    },
  },
  {
    test: {
      name: 'cli',
      environment: 'node',
      include: ['cli/**/*.test.ts'],
    },
  },
])
