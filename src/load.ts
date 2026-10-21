import { PaystackError } from './errors'

/** The subset of PaystackPop that this library calls. */
export interface PaystackPopInstance {
  newTransaction(options: Record<string, unknown>): unknown
}

export type PaystackPopConstructor = new () => PaystackPopInstance

let cached: Promise<PaystackPopConstructor> | undefined

/**
 * Loads `@paystack/inline-js` on demand. It reads `window` as soon as it is
 * evaluated, so it must never be imported at module top level (that is what
 * breaks server rendering). Browser only; a failed load is not cached.
 */
export function loadPaystack(): Promise<PaystackPopConstructor> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(
      new PaystackError('not_in_browser', 'Paystack checkout can only be opened in the browser.'),
    )
  }
  if (!cached) {
    cached = import('@paystack/inline-js')
      .then((mod) => {
        const anyMod = mod as { default?: unknown }
        const candidate = (anyMod.default as { default?: unknown } | undefined)?.default ?? anyMod.default ?? mod
        if (typeof candidate !== 'function') {
          throw new Error('@paystack/inline-js did not export PaystackPop')
        }
        return candidate as PaystackPopConstructor
      })
      .catch((cause: unknown) => {
        cached = undefined
        throw new PaystackError('load_failed', 'Could not load Paystack checkout. Check the network and try again.', {
          cause,
        })
      })
  }
  return cached
}
