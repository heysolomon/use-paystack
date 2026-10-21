import { PaystackError } from './errors'
import type { PaystackTransactionOptions } from './types'

export const REFERENCE_PATTERN = /^[A-Za-z0-9.=-]+$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function invalid(message: string): never {
  throw new PaystackError('invalid_options', message)
}

export function assertPublicKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.trim() === '') {
    invalid('A Paystack public key is required. Find it in your dashboard under Settings > API Keys & Webhooks.')
  }
  if (key.startsWith('sk_')) {
    invalid(
      'You passed a Paystack SECRET key to the browser. Never ship sk_ keys to the client: ' +
        'rotate this key now in your Paystack dashboard, then use your public key (pk_test_ or pk_live_) here.',
    )
  }
  if (!key.startsWith('pk_')) {
    invalid('A Paystack public key starts with pk_test_ or pk_live_.')
  }
}

export function assertTransactionOptions(options: PaystackTransactionOptions): void {
  if (!options || typeof options !== 'object') invalid('Transaction options must be an object.')

  const { amount, planCode, email, customerCode, reference } = options

  if (amount === undefined) {
    if (!planCode) invalid('amount is required (unless you pass planCode).')
  } else if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    invalid(
      `amount must be a positive integer in the lowest currency unit (kobo for NGN), got ${String(amount)}. ` +
        'For NGN 500.50 pass 50050.',
    )
  }

  if (!customerCode) {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      invalid(`A valid customer email is required (or pass customerCode), got ${JSON.stringify(email)}.`)
    }
  }

  if (reference !== undefined && (typeof reference !== 'string' || !REFERENCE_PATTERN.test(reference))) {
    invalid(
      `reference may only contain letters, numbers, "-", "." and "=", got ${JSON.stringify(reference)}.`,
    )
  }
}

export function assertAccessCode(accessCode: unknown): asserts accessCode is string {
  if (typeof accessCode !== 'string' || accessCode.trim() === '') {
    invalid('resume() needs the access_code returned by initializeTransaction on your server.')
  }
}
