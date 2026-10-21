// Smoke tests for the built package, run in plain Node with no bundler.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)

for (const file of ['dist/index.js', 'dist/index.cjs']) {
  const source = readFileSync(file, 'utf8')
  assert.ok(/^['"]use client['"];/.test(source), `${file} must start with 'use client'`)
  assert.ok(!/^\s*(import .* from|.*require\()\s*['"]@paystack\/inline-js['"]/m.test(source), `${file} must not import inline-js at top level`)
}
for (const file of ['dist/server.js', 'dist/server.cjs']) {
  const source = readFileSync(file, 'utf8')
  assert.ok(!source.includes('use client'), `${file} must not be a client module`)
  assert.ok(!/['"]react['"]/.test(source), `${file} must not import React`)
}

// The client entry must be importable on the server (this is what crashed react-paystack).
const clientCjs = require('../dist/index.cjs')
const clientEsm = await import('../dist/index.js')
for (const client of [clientCjs, clientEsm]) {
  assert.equal(typeof client.usePaystack, 'function')
  assert.equal(typeof client.PaystackButton, 'function')
}

const server = require('../dist/server.cjs')
const serverEsm = await import('../dist/server.js')
const body = '{"event":"charge.success","data":{"reference":"order-42","amount":50000,"currency":"NGN","status":"success"}}'
const signature =
  '1bc246171be4fb565d6169a2b45f0b930f40a7476e8e273832f6c8761841c64570d2759fa77253d9ac7ac7593623ef188745aaaca1e4986f4ae41f2572388e3c'
for (const mod of [server, serverEsm]) {
  assert.equal(await mod.verifyWebhookSignature(body, signature, 'sk_test_webhook_secret'), true)
  assert.equal(await mod.verifyWebhookSignature(body, signature, 'sk_test_wrong'), false)
  assert.equal(typeof mod.createPaystack, 'function')
}

console.log('dist OK: client entries start with "use client" and import in Node; server entry works in Node', process.version)
