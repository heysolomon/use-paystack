import { afterEach } from 'vitest'

afterEach(async () => {
  // Vitest globals are off, so Testing Library cannot register its own cleanup.
  if (typeof document !== 'undefined') {
    const { cleanup } = await import('@testing-library/react')
    cleanup()
  }
})
