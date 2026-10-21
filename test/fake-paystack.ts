import { vi } from 'vitest'

export type Callback = (...args: unknown[]) => void

export interface FakeTransaction {
  options: Record<string, unknown> & {
    onLoad: Callback
    onSuccess: Callback
    onCancel: Callback
    onError: Callback
    onBankTransferConfirmationPending: Callback
  }
}

/** Shared between the vi.mock factory (which runs lazily, on first import) and the tests. */
export const fake = {
  importCount: 0,
  failNextLoad: false,
  throwOnNewTransaction: undefined as Error | undefined,
  transactions: [] as Array<{ options: Record<string, unknown> }>,
  reset() {
    this.failNextLoad = false
    this.throwOnNewTransaction = undefined
    this.transactions = []
  },
}

vi.mock('@paystack/inline-js', () => {
  fake.importCount++
  class FakePaystackPop {
    newTransaction(options: Record<string, unknown>) {
      if (fake.throwOnNewTransaction) throw fake.throwOnNewTransaction
      fake.transactions.push({ options })
      return {}
    }
  }
  return {
    // A getter so a test can make one load fail and the next succeed.
    get default() {
      if (fake.failNextLoad) {
        fake.failNextLoad = false
        throw new Error('network down')
      }
      return FakePaystackPop
    },
  }
})

export async function lastTransaction(): Promise<FakeTransaction> {
  await vi.waitFor(() => {
    if (fake.transactions.length === 0) throw new Error('no transaction yet')
  })
  return fake.transactions[fake.transactions.length - 1] as FakeTransaction
}
