import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Task 9 names its form-logic suite `roster-form.spec.ts` (brief), so the
    // runner accepts both extensions; every existing suite stays `*.test.ts`.
    include: ['test/**/*.test.ts', 'test/**/*.spec.ts'],
    environment: 'node',
  },
})
