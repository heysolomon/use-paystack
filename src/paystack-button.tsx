import type { ButtonHTMLAttributes, MouseEvent } from 'react'
import { PaystackError } from './errors'
import type {
  PaystackCancelledResult,
  PaystackPendingResult,
  PaystackResult,
  PaystackSuccessResult,
  PaystackTransactionOptions,
} from './types'
import { usePaystack } from './use-paystack'

interface PaystackButtonBaseProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onError'> {
  publicKey: string
  /** Load inline-js after mount. Defaults to true. */
  preload?: boolean
  onSuccess?: (result: PaystackSuccessResult) => void
  /** Bank transfer sent but not confirmed yet. Not a cancel: wait for the webhook or verify again. */
  onPending?: (result: PaystackPendingResult) => void
  onCancel?: (result: PaystackCancelledResult) => void
  onError?: (error: PaystackError) => void
}

interface WithOptions {
  /** Transaction options, or a function that builds them at click time. */
  options: PaystackTransactionOptions | (() => PaystackTransactionOptions)
  accessCode?: never
}

interface WithAccessCode {
  /** An access code from initializeTransaction on your server. */
  accessCode: string
  options?: never
}

export type PaystackButtonProps = PaystackButtonBaseProps & (WithOptions | WithAccessCode)

function toPaystackError(error: unknown): PaystackError {
  if (error instanceof PaystackError) return error
  const message = error instanceof Error ? error.message : 'Could not build Paystack options.'
  return new PaystackError('invalid_options', message, { cause: error })
}

export function PaystackButton(props: PaystackButtonProps) {
  const {
    publicKey,
    preload,
    options,
    accessCode,
    onSuccess,
    onPending,
    onCancel,
    onError,
    onClick,
    disabled,
    type = 'button',
    children = 'Pay',
    ...rest
  } = props
  const { pay, resume, isOpen } = usePaystack({ publicKey, preload })

  const handleResult = (result: PaystackResult) => {
    if (result.status === 'success') onSuccess?.(result)
    else if (result.status === 'pending') onPending?.(result)
    else onCancel?.(result)
  }

  const handleError = (error: unknown) => {
    const paystackError = toPaystackError(error)
    if (onError) onError(paystackError)
    else console.error('[use-paystack]', paystackError)
  }

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return

    let checkout: Promise<PaystackResult>
    try {
      if (accessCode !== undefined) {
        checkout = resume(accessCode)
      } else {
        checkout = pay(typeof options === 'function' ? options() : options)
      }
    } catch (error) {
      handleError(error)
      return
    }
    checkout.then(handleResult, handleError)
  }

  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || isOpen}
      aria-busy={isOpen || undefined}
      onClick={handleClick}
    >
      {children}
    </button>
  )
}
