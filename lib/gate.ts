import {
  x402ResourceServer,
  x402HTTPResourceServer,
  HTTPFacilitatorClient,
} from '@x402/core/server'
import type {
  FacilitatorClient,
  HTTPAdapter,
  HTTPRequestContext,
  RouteConfig,
} from '@x402/core/server'
import type { PaymentPayload, SupportedResponse } from '@x402/core/types'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { CHAINS, PRICE_USD, payToAddress } from './chains'
import type { Chain } from './chains'

/**
 * The Gate of the one paid URL (/testnet): an x402ResourceServer with exactly Monad testnet and Base Sepolia registered.
 *
 * Modelled on agent-verse.live-new/final/lib/x402-flow.ts (the production-proven seller): one
 * ExactEvmScheme per chain with registerMoneyParser, one facilitator client per chain, and
 * "one facilitator down must not stop the other chain". Differences, because this runs on serverless:
 *   - the facilitators are probed in parallel with a short timeout, so a dead one costs one timeout,
 *     not one per facilitator, and a 402 still comes back within a few seconds;
 *   - a missing chain is retried on a later request (after RETRY_AFTER_MS) by awaiting a fresh probe,
 *     not in the background (a serverless function may be frozen once it has responded).
 */

/** Answering an unpaid request must never wait long for a dead facilitator. */
export const SUPPORTED_TIMEOUT_MS = 3_000
/** verify/settle may wait for a chain confirmation, so they get longer (the routes set maxDuration above it). */
export const PAY_TIMEOUT_MS = 20_000
/** How long a chain whose facilitator did not answer stays out of the 402 before it is probed again. */
export const RETRY_AFTER_MS = 30_000

export type FacilitatorFactory = (url: string) => FacilitatorClient

export function httpFacilitator(url: string, supportedTimeoutMs = SUPPORTED_TIMEOUT_MS): FacilitatorClient {
  const quick = new HTTPFacilitatorClient({ url, timeoutMs: supportedTimeoutMs })
  const slow = new HTTPFacilitatorClient({ url, timeoutMs: PAY_TIMEOUT_MS })
  return {
    getSupported: () => quick.getSupported(),
    verify: (payload, requirements) => slow.verify(payload, requirements),
    settle: (payload, requirements) => slow.settle(payload, requirements),
  }
}

/** Decimal USDC (6 decimals) -> atomic units, without floating-point drift. Same as agent-verse x402-flow.ts usdcToAtomic. */
export function usdcToAtomic(amount: number | string): string {
  const [whole, frac = ''] = Number(amount).toFixed(6).split('.')
  return BigInt(whole + frac).toString()
}

/** ExactEvmScheme for one chain with its USDC (and EIP-712 domain) fixed by registerMoneyParser. */
export function createScheme(chain: Chain): ExactEvmScheme {
  const scheme = new ExactEvmScheme()
  scheme.registerMoneyParser(async (amount, network) => {
    if (network !== chain.network) return null
    return {
      amount: usdcToAtomic(amount),
      asset: chain.usdc,
      extra: { name: chain.domain.name, version: chain.domain.version },
    }
  })
  return scheme
}

type Probe = FacilitatorClient & { probe(): Promise<SupportedResponse> }

/**
 * The facilitator client the resource server sees for ONE chain: it only ever reports that chain
 * (so a facilitator that also lists other networks cannot take over a chain that belongs to another one),
 * and getSupported() can be started ahead of server.initialize() so all chains are probed in parallel.
 */
function pinToChain(chain: Chain, inner: FacilitatorClient): Probe {
  let started: Promise<SupportedResponse> | undefined
  const fetchSupported = async (): Promise<SupportedResponse> => {
    const supported = await inner.getSupported()
    return { ...supported, kinds: supported.kinds.filter((k) => k.network === chain.network) }
  }
  return {
    probe: () => (started = fetchSupported()),
    getSupported: () => started ?? fetchSupported(),
    verify: (payload, requirements) => inner.verify(payload, requirements),
    settle: (payload, requirements) => inner.settle(payload, requirements),
  }
}

interface Built {
  server: x402ResourceServer
  /** Chains whose facilitator answered and supports exact on them, in route order. */
  ready: Chain[]
  missing: Chain[]
}

async function build(chains: readonly Chain[], makeFacilitator: FacilitatorFactory): Promise<Built> {
  const probes = chains.map((chain) => pinToChain(chain, makeFacilitator(chain.facilitatorUrl)))
  const server = new x402ResourceServer(probes)
  for (const chain of chains) server.register(chain.network, createScheme(chain))
  // Start every getSupported() now; initialize() then just awaits the results.
  await Promise.allSettled(probes.map((p) => p.probe()))
  await server.initialize() // throws only when NO facilitator answered
  // buildPaymentRequirements() looks facilitator support up at protocol version 2.
  const ready = chains.filter((c) => !!server.getSupportedKind(2, c.network, 'exact'))
  if (ready.length === 0) throw new Error(`no facilitator supports exact on ${chains.map((c) => c.network).join(' or ')}`)
  return { server, ready, missing: chains.filter((c) => !ready.includes(c)) }
}

export interface GateOptions {
  makeFacilitator?: FacilitatorFactory
  retryAfterMs?: number
  now?: () => number
  log?: (message: string) => void
}

function json(status: number, body: unknown, extra?: HeadersInit): Response {
  const headers = new Headers(extra)
  headers.set('content-type', 'application/json')
  headers.set('cache-control', 'no-store')
  return new Response(JSON.stringify(body), { status, headers })
}

function payerOf(payload: PaymentPayload): string | null {
  const from = (payload.payload as { authorization?: { from?: unknown } } | undefined)?.authorization?.from
  return typeof from === 'string' && /^0x[0-9a-fA-F]{40}$/.test(from) ? from : null
}

export class Gate {
  private current: Built | null = null
  private nextProbeAt = 0
  private inflight: Promise<void> | null = null
  private readonly makeFacilitator: FacilitatorFactory
  private readonly retryAfterMs: number
  private readonly now: () => number
  private readonly log: (message: string) => void

  constructor(opts: GateOptions = {}) {
    this.makeFacilitator = opts.makeFacilitator ?? httpFacilitator
    this.retryAfterMs = opts.retryAfterMs ?? RETRY_AFTER_MS
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? ((m) => console.warn(m))
  }

  /** The cached server, (re)probed when nothing is cached yet or a chain is missing and the backoff has passed. */
  private async ensure(): Promise<Built | null> {
    const cur = this.current
    if (cur && (cur.missing.length === 0 || this.now() < this.nextProbeAt)) return cur
    this.inflight ??= this.probe().finally(() => {
      this.inflight = null
    })
    await this.inflight
    return this.current
  }

  private async probe(): Promise<void> {
    let next: Built | null = null
    try {
      next = await build(CHAINS, this.makeFacilitator)
    } catch (e) {
      this.log(`[x402-ping] /testnet: no facilitator answered: ${(e as Error)?.message}`)
    }
    this.nextProbeAt = this.now() + this.retryAfterMs
    // A fresh probe never takes chains away from what is already being offered.
    if (next && (!this.current || next.ready.length >= this.current.ready.length)) {
      this.current = next
      if (next.missing.length > 0) {
        this.log(
          `[x402-ping] /testnet: offering only ${next.ready.map((c) => c.network).join(', ')}; ` +
            `${next.missing.map((c) => c.network).join(', ')} left out (its facilitator is down or does not list it)`,
        )
      }
    }
  }

  async handle(req: Request): Promise<Response> {
    const built = await this.ensure()
    if (!built) return json(503, { error: 'facilitator_unavailable', charged: 'no' })

    const payTo = payToAddress()
    const route: RouteConfig = {
      accepts: built.ready.map((chain) => ({
        scheme: 'exact',
        price: `$${PRICE_USD}`,
        network: chain.network,
        payTo,
      })),
      description: `x402-ping: ${PRICE_USD} USDC for a JSON receipt`,
      mimeType: 'application/json',
    }

    const url = new URL(req.url)
    const adapter: HTTPAdapter = {
      getHeader: (name) => req.headers.get(name) ?? undefined,
      getMethod: () => req.method,
      getPath: () => url.pathname,
      getUrl: () => req.url,
      // Always JSON: without a paywall provider the SDK would answer a browser with an empty HTML paywall.
      getAcceptHeader: () => 'application/json',
      getUserAgent: () => req.headers.get('user-agent') ?? '',
      getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
      getQueryParam: (name) => url.searchParams.get(name) ?? undefined,
      getBody: () => undefined,
    }
    const context: HTTPRequestContext = {
      adapter,
      path: url.pathname,
      decodedPath: url.pathname,
      method: req.method,
      paymentHeader: adapter.getHeader('payment-signature'),
    }
    const http = new x402HTTPResourceServer(built.server, route)

    // 1. Unpaid / invalid payment -> 402 from the SDK (PAYMENT-REQUIRED header); valid payment -> verified.
    let result
    try {
      result = await http.processHTTPRequest(context)
    } catch (e) {
      // verify happens before settle, so nothing was charged.
      this.log(`[x402-ping] /testnet: facilitator error before settlement: ${(e as Error)?.message}`)
      return json(503, { error: 'facilitator_unavailable', charged: 'no' })
    }
    if (result.type === 'no-payment-required') {
      return json(500, { error: 'misconfigured', charged: 'no' })
    }
    if (result.type === 'payment-error') {
      const r = result.response
      return json(r.status, r.body ?? {}, r.headers)
    }

    // 2. Settle, then answer with the receipt.
    let settled
    try {
      settled = await http.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, {
        request: context,
      })
    } catch (e) {
      // The facilitator did not answer the settle call: the transfer may or may not have happened.
      this.log(`[x402-ping] /testnet: facilitator error during settlement: ${(e as Error)?.message}`)
      return json(502, { error: 'settlement_unconfirmed', charged: 'unknown' })
    }
    if (!settled.success) {
      const r = settled.response
      return json(r.status, r.body ?? {}, r.headers)
    }

    return json(
      200,
      {
        ok: true,
        service: 'x402-ping',
        network: result.paymentRequirements.network,
        testnet: true,
        amount: PRICE_USD,
        asset: 'USDC',
        pay_to: result.paymentRequirements.payTo,
        payer: settled.payer || payerOf(result.paymentPayload),
        tx: settled.transaction || null,
        at: new Date().toISOString(),
      },
      settled.headers,
    )
  }
}

export function createGate(opts: GateOptions = {}): Gate {
  return new Gate(opts)
}
