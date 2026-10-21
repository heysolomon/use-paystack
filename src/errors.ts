export type PaystackErrorCode =
  | 'not_in_browser'
  | 'load_failed'
  | 'invalid_options'
  | 'checkout_error'
  | 'already_open'

/**
 * Something went wrong loading or running checkout. A customer closing the
 * popup is not an error; it resolves with `{ status: 'cancelled' }`.
 */
export class PaystackError extends Error {
  readonly code: PaystackErrorCode

  constructor(code: PaystackErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PaystackError'
    this.code = code
  }
}

export function isPaystackError(value: unknown): value is PaystackError {
  return value instanceof PaystackError
}
