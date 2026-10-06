import { expect, vi } from 'vitest'
import { verifyTypedData } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import type { FacilitatorClient } from '@x402/core/server'
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types'
import type { FacilitatorFactory } from '../lib/gate'

// Facilitator URLs the task prescribes (also asserted in ping.test.ts so a change in lib/chains.ts is noticed).
export const MOLANDAK = 'https://x402-facilitator.molandak.org'
export const PAYAI = 'https://facilitator.payai.network'
export const X402_ORG = 'https://x402.org/facilitator'

const authorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

/** Checks the buyer's EIP-3009 signature locally against the domain the 402 advertised (extra.name/version, chainId, asset). */
async function signatureOk(payload: PaymentPayload, req: PaymentRequirements): Promise<boolean> {
  const inner = payload.payload as { signature?: string; authorization?: Record<string, string> }
  const auth = inner.authorization
  if (!auth || typeof inner.signature !== 'string') return false
  if (auth.to.toLowerCase() !== req.payTo.toLowerCase()) return false
  if (BigInt(auth.value) !== BigInt(req.amount)) return false
  const extra = (req.extra ?? {}) as { name?: string; version?: string }
  return verifyTypedData({
    address: auth.from as `0x${string}`,
    domain: {
      name: extra.name,
      version: extra.version,
      chainId: Number(req.network.split(':')[1]),
      verifyingContract: req.asset as `0x${string}`,
    },
    types: authorizationTypes,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: auth.from as `0x${string}`,
      to: auth.to as `0x${string}`,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce as `0x${string}`,
    },
    signature: inner.signature as `0x${string}`,
  })
}

let txCounter = 0

/** A facilitator double that signs nothing on-chain. verify/settle/getSupported are vi.fn() so tests can override them. */
export function createMockFacilitator(networks: Network[]) {
  const getSupported = vi.fn(
    async (): Promise<SupportedResponse> => ({
      kinds: networks.flatMap((network) => [
        { x402Version: 1, scheme: 'exact', network },
        { x402Version: 2, scheme: 'exact', network },
      ]),
      extensions: [],
      signers: {},
    }),
  )
  const verify = vi.fn(async (payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> => {
    const from = (payload.payload as { authorization?: { from?: string } }).authorization?.from
    return (await signatureOk(payload, req))
      ? { isValid: true, payer: from }
      : { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature', payer: from }
  })
  const settle = vi.fn(async (payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> => ({
    success: true,
    transaction: '0x' + (++txCounter).toString(16).padStart(64, '0'),
    network: req.network,
    payer: (payload.payload as { authorization?: { from?: string } }).authorization?.from,
  }))
  return { getSupported, verify, settle } satisfies FacilitatorClient
}

export type MockFacilitator = ReturnType<typeof createMockFacilitator>

/** Make getSupported() reject, the way an unreachable facilitator does. Returns a function that brings it back. */
export function takeDown(f: MockFacilitator): () => void {
  const working = f.getSupported.getMockImplementation()!
  f.getSupported.mockImplementation(async () => {
    throw new Error('facilitator is down')
  })
  return () => f.getSupported.mockImplementation(working)
}

/** The three facilitators of the task, as doubles. Molandak serves both Monad networks, like the real one. */
export function createFacilitators() {
  const molandak = createMockFacilitator(['eip155:143', 'eip155:10143'])
  const payai = createMockFacilitator(['eip155:8453'])
  const x402org = createMockFacilitator(['eip155:84532'])
  const byUrl: Record<string, FacilitatorClient> = { [MOLANDAK]: molandak, [PAYAI]: payai, [X402_ORG]: x402org }
  const makeFacilitator: FacilitatorFactory = (url) => {
    const f = byUrl[url]
    if (!f) throw new Error(`test: no mock facilitator for ${url}`)
    return f
  }
  return { molandak, payai, x402org, makeFacilitator }
}

export function decodeHeader(value: string | null): any {
  expect(value).toBeTruthy()
  return JSON.parse(Buffer.from(value as string, 'base64').toString())
}

/** A buyer with a throw-away key (no funds anywhere) that signs real EIP-3009 authorizations. */
export function createBuyer() {
  const account = privateKeyToAccount(generatePrivateKey())
  const client = new x402Client()
  registerExactEvmScheme(client, { signer: account })
  // @x402/core 2.27 clients refuse any USDC that is not in their built-in asset table; Monad testnet USDC is not
  // (the README says so), so a client that wants to pay on eip155:10143 has to opt in, like MoneySwitch does.
  client.setSpendControls({ allowedAssets: [{ network: 'eip155:10143', asset: '0x534b2f3A21130d7a60830c2Df862319e593943A3' }] })
  const http = new x402HTTPClient(client)
  return {
    address: account.address,
    /** Turns a 402 response into the PAYMENT-SIGNATURE header for the given network. */
    async payFor(res402: Response, network: string): Promise<Record<string, string>> {
      const paymentRequired: PaymentRequired = http.getPaymentRequiredResponse((name) => res402.headers.get(name))
      const only = { ...paymentRequired, accepts: paymentRequired.accepts.filter((a) => a.network === network) }
      expect(only.accepts).toHaveLength(1)
      return http.encodePaymentSignatureHeader(await http.createPaymentPayload(only))
    },
  }
}

export function get(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: 'GET', headers })
}
