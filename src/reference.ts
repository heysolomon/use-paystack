const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * A unique reference using only characters Paystack accepts
 * (letters, numbers, `-`, `.`, `=`).
 */
export function generateReference(prefix = 'ps'): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  let random = ''
  for (const byte of bytes) random += ALPHABET[byte % ALPHABET.length]
  return `${prefix}-${Date.now().toString(36)}-${random}`
}
