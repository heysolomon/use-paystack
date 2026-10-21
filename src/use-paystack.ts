import { useCallback, useEffect, useRef, useState } from 'react'
import { PaystackError } from './errors'
import { loadPaystack, type PaystackPopInstance } from './load'
import { generateReference } from './reference'
import type { PaystackLoadResponse, PaystackResult, PaystackTransactionOptions } from './types'
import { assertAccessCode, assertPublicKey, assertTransactionOptions } from './validate'

export interface UsePaystackConfig {
  /** Your Paystack public key (pk_test_... or pk_live_...). Never a secret key. */
  publicKey: string
  /** Start downloading inline-js after mount so the first click opens faster. Defaults to true. */
  preload?: boolean
}

export interface UsePaystackReturn {
  /** Open checkout for a new transaction. */
  pay: (options: PaystackTransactionOptions) => Promise<PaystackResult>
  /** Open checkout for a transaction your server initialized (recommended). */
  resume: (accessCode: string) => Promise<PaystackResult>
  /** True while a checkout is open. */
  isOpen: boolean
  /** True once inline-js has loaded in the browser. */
  isReady: boolean
}

interface Callbacks {
  onLoad: (response: PaystackLoadResponse) => void
  onSuccess: (response?: { id?: number; reference?: string; message?: string }) => void
  onCancel: () => void
  onBankTransferConfirmationPending: () => void
  onError: (error?: { message?: string }) => void
}

interface Checkout {
  reference?: string
  onLoad?: PaystackTransactionOptions['onLoad']
  start: (pop: PaystackPopInstance, callbacks: Callbacks) => void
}

function messageOf(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message) {
    return error.message
  }
  return fallback
}

/**
 * Wires inline-js callbacks to a promise that settles exactly once.
 *
 * inline-js reports a pending bank transfer by calling `onCancel` first and
 * `onBankTransferConfirmationPending` straight after. So a cancel only settles
 * on the next tick, giving a pending signal that follows it the chance to win.
 */
function runCheckout(
  Pop: new () => PaystackPopInstance,
  { reference, onLoad: userOnLoad, start }: Checkout,
): Promise<PaystackResult> {
  return new Promise<PaystackResult>((resolve, reject) => {
    let settled = false
    let cancelTimer: ReturnType<typeof setTimeout> | undefined
    let loaded: { id?: number; accessCode?: string } = {}

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      if (cancelTimer !== undefined) clearTimeout(cancelTimer)
      fn()
    }

    const callbacks: Callbacks = {
      onLoad(response) {
        loaded = { id: response?.id, accessCode: response?.accessCode }
        if (userOnLoad) {
          try {
            userOnLoad(response)
          } catch (error) {
            console.error('[use-paystack] onLoad threw:', error)
          }
        }
      },
      onSuccess(response) {
        settle(() =>
          resolve({
            status: 'success',
            reference: response?.reference ?? reference ?? '',
            transactionId: response?.id ?? loaded.id,
            message: response?.message,
          }),
        )
      },
      onCancel() {
        if (settled || cancelTimer !== undefined) return
        cancelTimer = setTimeout(() => settle(() => resolve({ status: 'cancelled', reference })), 0)
      },
      onBankTransferConfirmationPending() {
        settle(() =>
          resolve({ status: 'pending', reference, transactionId: loaded.id, accessCode: loaded.accessCode }),
        )
      },
      onError(error) {
        settle(() =>
          reject(new PaystackError('checkout_error', messageOf(error, 'Paystack checkout failed.'), { cause: error })),
        )
      },
    }

    try {
      start(new Pop(), callbacks)
    } catch (error) {
      settle(() =>
        reject(
          new PaystackError('checkout_error', messageOf(error, 'Paystack checkout could not start.'), { cause: error }),
        ),
      )
    }
  })
}

export function usePaystack({ publicKey, preload = true }: UsePaystackConfig): UsePaystackReturn {
  const [isOpen, setIsOpen] = useState(false)
  const [isReady, setIsReady] = useState(false)
  // A ref, not state, so two clicks in the same tick cannot both get through.
  const openRef = useRef(false)

  useEffect(() => {
    if (!preload) return
    let active = true
    loadPaystack().then(
      () => {
        if (active) setIsReady(true)
      },
      () => {
        // Ignored here: pay() and resume() retry the load and surface the error.
      },
    )
    return () => {
      active = false
    }
  }, [preload])

  const open = useCallback(async (prepare: () => Checkout): Promise<PaystackResult> => {
    if (openRef.current) {
      throw new PaystackError('already_open', 'A Paystack checkout is already open.')
    }
    if (typeof window === 'undefined') {
      throw new PaystackError('not_in_browser', 'Paystack checkout can only be opened in the browser.')
    }
    // Validates synchronously, before anything is loaded or marked open.
    const checkout = prepare()
    openRef.current = true
    setIsOpen(true)
    try {
      const Pop = await loadPaystack()
      setIsReady(true)
      return await runCheckout(Pop, checkout)
    } finally {
      openRef.current = false
      setIsOpen(false)
    }
  }, [])

  const pay = useCallback(
    (options: PaystackTransactionOptions) =>
      open(() => {
        assertPublicKey(publicKey)
        assertTransactionOptions(options)
        const reference = options.reference ?? generateReference()
        return {
          reference,
          onLoad: options.onLoad,
          start(pop, callbacks) {
            pop.newTransaction({ ...options, reference, key: publicKey, ...callbacks })
          },
        }
      }),
    [open, publicKey],
  )

  const resume = useCallback(
    (accessCode: string) =>
      open(() => {
        assertAccessCode(accessCode)
        return {
          start(pop, callbacks) {
            // Same as pop.resumeTransaction(accessCode, callbacks), except that
            // resumeTransaction drops onBankTransferConfirmationPending, so a
            // pending transfer would be reported as a cancel.
            pop.newTransaction({ accessCode, ...callbacks })
          },
        }
      }),
    [open],
  )

  return { pay, resume, isOpen, isReady }
}
