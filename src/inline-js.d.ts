declare module '@paystack/inline-js' {
  const PaystackPop: new () => { newTransaction(options: Record<string, unknown>): unknown }
  export default PaystackPop
}
