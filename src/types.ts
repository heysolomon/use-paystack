export type PaystackChannel =
  | 'card'
  | 'bank'
  | 'ussd'
  | 'qr'
  | 'eft'
  | 'mobile_money'
  | 'bank_transfer'
  | 'apple_pay'
  | 'google_pay'
  | 'payattitude'
  | 'capitec_pay'
  | (string & {})

export type PaystackCurrency = 'NGN' | 'GHS' | 'ZAR' | 'KES' | 'USD' | 'XOF' | 'EGP' | (string & {})

export interface PaystackCustomField {
  display_name: string
  variable_name: string
  value: unknown
}

export interface PaystackMetadata {
  /** Shown on the Paystack dashboard when present. */
  custom_fields?: PaystackCustomField[]
  [key: string]: unknown
}

/** What inline-js passes to `onLoad`. */
export interface PaystackLoadResponse {
  id: number
  accessCode: string
  customer: Record<string, unknown>
}

/**
 * Options for a new transaction. Names match `@paystack/inline-js` exactly,
 * so anything in its README can be passed straight through.
 */
export interface PaystackTransactionOptions {
  /** Customer email. Required unless `customerCode` is given. */
  email?: string
  /** Amount in the lowest currency unit (kobo for NGN, pesewas for GHS). Must be a positive integer. Optional with `planCode`. */
  amount?: number
  currency?: PaystackCurrency
  /** Only letters, numbers, `-`, `.` and `=`. Generated for you when omitted. */
  reference?: string
  firstName?: string
  lastName?: string
  phone?: string
  /** A Paystack customer code. Overrides the customer fields above. */
  customerCode?: string
  channels?: PaystackChannel[]
  metadata?: PaystackMetadata
  planCode?: string
  subscriptionCount?: number
  planInterval?: 'hourly' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'biannually' | 'annually' | (string & {})
  subscriptionLimit?: number
  subscriptionStartDate?: string
  subaccountCode?: string
  split_code?: string
  bearer?: 'account' | 'subaccount' | (string & {})
  transactionCharge?: number
  paymentRequest?: string | number
  paymentPage?: string
  /** Called when the checkout form has loaded. Errors it throws are swallowed so they cannot break checkout. */
  onLoad?: (response: PaystackLoadResponse) => void
}

export interface PaystackSuccessResult {
  status: 'success'
  reference: string
  transactionId?: number
  message?: string
}

/**
 * The customer chose bank transfer and says they have sent the money, but
 * Paystack has not confirmed it yet. This is NOT a cancel. Wait for the
 * `charge.success` webhook, or verify the reference again later.
 */
export interface PaystackPendingResult {
  status: 'pending'
  reference?: string
  transactionId?: number
  accessCode?: string
}

export interface PaystackCancelledResult {
  status: 'cancelled'
  reference?: string
}

export type PaystackResult = PaystackSuccessResult | PaystackPendingResult | PaystackCancelledResult
