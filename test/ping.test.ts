import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BASE_SEPOLIA, CHAINS, MONAD_TESTNET, PRICE_ATOMIC, payToAddress } from '../lib/chains'
import { createGate, httpFacilitator, usdcToAtomic } from '../lib/gate'
import { landingHtml } from '../lib/landing'
import { MOLANDAK, X402_ORG, createBuyer, createFacilitators, decodeHeader, get, takeDown } from './helpers'

// Written out here, independently of lib/chains.ts, so a typo there cannot hide behind itself.
const PAY_TO = '0x4eCf92bAb524039Fc4027994b9D88C2DB2Ee05E6'
const EXPECTED = {
  'eip155:10143': { usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3', name: 'USDC', version: '2' },
  'eip155:84532': { usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC', version: '2' },
} as const
const URL_TESTNET = 'https://ping.test/testnet'

let logs: string[]
let env: string | undefined
beforeEach(() => {
  logs = []
  env = process.env.PAY_TO_ADDRESS
  delete process.env.PAY_TO_ADDRESS
  // The SDK warns on a facilitator that does not answer; that is expected noise in the "down" tests.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  if (env === undefined) delete process.env.PAY_TO_ADDRESS
  else process.env.PAY_TO_ADDRESS = env
  vi.restoreAllMocks()
})

function setup(overrides: Parameters<typeof createGate>[0] = {}) {
  const f = createFacilitators()
  const gate = createGate({ makeFacilitator: f.makeFacilitator, log: (m) => logs.push(m), ...overrides })
  return { ...f, gate }
}

async function accepts(res: Response) {
  expect(res.status).toBe(402)
  return decodeHeader(res.headers.get('PAYMENT-REQUIRED')).accepts as Array<Record<string, any>>
}
const networksOf = async (res: Response) => (await accepts(res)).map((a) => a.network)

describe('402 offers', () => {
  it('/testnet offers exactly Monad testnet then Base Sepolia, 0.01 USDC to the one address', async () => {
    const { gate } = setup()
    const res = await gate.handle(get(URL_TESTNET))
    expect(res.status).toBe(402)
    const header = decodeHeader(res.headers.get('PAYMENT-REQUIRED'))
    expect(header.x402Version).toBe(2)
    const list = header.accepts
    expect(list).toHaveLength(2)
    expect(list.map((a: any) => a.network)).toEqual(['eip155:10143', 'eip155:84532'])
    for (const a of list) {
      const want = EXPECTED[a.network as keyof typeof EXPECTED]
      expect(a.scheme).toBe('exact')
      expect(a.amount).toBe('10000')
      expect(a.payTo).toBe(PAY_TO)
      expect(a.asset).toBe(want.usdc)
      expect(a.extra).toMatchObject({ name: want.name, version: want.version })
    }
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('there is no mainnet in the 402, and no mainnet facilitator or chain in the code', async () => {
    const { gate } = setup()
    const list = await accepts(await gate.handle(get(URL_TESTNET)))
    expect(list.some((a) => ['eip155:143', 'eip155:8453'].includes(a.network))).toBe(false)
    expect(CHAINS.map((c) => c.facilitatorUrl)).toEqual([MOLANDAK, X402_ORG])
  })

  it('the chain table, price and receiving address are what the task prescribes', () => {
    expect(CHAINS).toEqual([MONAD_TESTNET, BASE_SEPOLIA])
    expect(CHAINS.map((c) => c.network)).toEqual(['eip155:10143', 'eip155:84532'])
    expect(PRICE_ATOMIC).toBe('10000')
    expect(usdcToAtomic('0.01')).toBe('10000')
    expect(payToAddress({})).toBe(PAY_TO)
  })

  it('PAY_TO_ADDRESS overrides the receiving address', async () => {
    process.env.PAY_TO_ADDRESS = '0x1111111111111111111111111111111111111111'
    const { gate } = setup()
    const list = await accepts(await gate.handle(get(URL_TESTNET)))
    expect(list.map((a) => a.payTo)).toEqual(['0x1111111111111111111111111111111111111111', '0x1111111111111111111111111111111111111111'])
  })
})

describe('paid flow', () => {
  const cases = [
    { network: 'eip155:10143', facilitator: 'molandak' },
    { network: 'eip155:84532', facilitator: 'x402org' },
  ] as const

  it.each(cases)('paid on $network returns the JSON receipt and PAYMENT-RESPONSE', async ({ network, facilitator }) => {
    const s = setup()
    const buyer = createBuyer()
    const res402 = await s.gate.handle(get(URL_TESTNET))
    const res = await s.gate.handle(get(URL_TESTNET, await buyer.payFor(res402, network)))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['amount', 'asset', 'at', 'network', 'ok', 'pay_to', 'payer', 'service', 'testnet', 'tx'])
    expect(body).toMatchObject({
      ok: true,
      service: 'x402-ping',
      network,
      testnet: true,
      amount: '0.01',
      asset: 'USDC',
      pay_to: PAY_TO,
      payer: buyer.address,
    })
    expect(body.tx).toMatch(/^0x[0-9a-f]{64}$/)
    expect(new Date(body.at).toISOString()).toBe(body.at)
    const receipt = decodeHeader(res.headers.get('PAYMENT-RESPONSE'))
    expect(receipt).toMatchObject({ success: true, network, transaction: body.tx })
    // Only the facilitator that belongs to that network was asked to settle.
    for (const [name, f] of Object.entries({ molandak: s.molandak, x402org: s.x402org })) {
      expect(f.settle).toHaveBeenCalledTimes(name === facilitator ? 1 : 0)
    }
  })

  it('a payment that does not verify is answered 402 and never settled', async () => {
    const s = setup()
    const buyer = createBuyer()
    const res402 = await s.gate.handle(get(URL_TESTNET))
    const headers = await buyer.payFor(res402, 'eip155:10143')
    s.molandak.verify.mockResolvedValueOnce({ isValid: false, invalidReason: 'insufficient_funds' })
    const res = await s.gate.handle(get(URL_TESTNET, headers))
    expect(res.status).toBe(402)
    expect(s.molandak.settle).not.toHaveBeenCalled()
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull()
  })

  it('a settlement that fails is not answered 200', async () => {
    const s = setup()
    const buyer = createBuyer()
    const res402 = await s.gate.handle(get(URL_TESTNET))
    const headers = await buyer.payFor(res402, 'eip155:84532')
    s.x402org.settle.mockResolvedValueOnce({ success: false, errorReason: 'transaction_failed', transaction: '', network: 'eip155:84532' })
    const res = await s.gate.handle(get(URL_TESTNET, headers))
    expect(res.status).toBe(402)
    expect(await res.text()).not.toContain('"ok":true')
  })

  it('a facilitator that errors during settlement is reported as unconfirmed, not as "not charged"', async () => {
    const s = setup()
    const buyer = createBuyer()
    const res402 = await s.gate.handle(get(URL_TESTNET))
    const headers = await buyer.payFor(res402, 'eip155:10143')
    const { FacilitatorTimeoutError } = await import('@x402/core/server')
    s.molandak.settle.mockRejectedValueOnce(new FacilitatorTimeoutError('settle', 20000))
    const res = await s.gate.handle(get(URL_TESTNET, headers))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'settlement_unconfirmed', charged: 'unknown' })
  })
})

describe('facilitator down', () => {
  it('Molandak down: the 402 offers only Base Sepolia (logged), and Base Sepolia still takes a payment', async () => {
    const s = setup()
    takeDown(s.molandak)
    expect(await networksOf(await s.gate.handle(get(URL_TESTNET)))).toEqual(['eip155:84532'])
    expect(logs.some((m) => m.includes('eip155:10143') && m.includes('left out'))).toBe(true)

    const buyer = createBuyer()
    const res402 = await s.gate.handle(get(URL_TESTNET))
    const res = await s.gate.handle(get(URL_TESTNET, await buyer.payFor(res402, 'eip155:84532')))
    expect(res.status).toBe(200)
    expect((await res.json()).network).toBe('eip155:84532')
  })

  it('x402.org down: the 402 offers only Monad testnet (logged), and Monad testnet still takes a payment', async () => {
    const s = setup()
    takeDown(s.x402org)
    expect(await networksOf(await s.gate.handle(get(URL_TESTNET)))).toEqual(['eip155:10143'])
    expect(logs.some((m) => m.includes('eip155:84532') && m.includes('left out'))).toBe(true)

    const buyer = createBuyer()
    const res402 = await s.gate.handle(get(URL_TESTNET))
    const res = await s.gate.handle(get(URL_TESTNET, await buyer.payFor(res402, 'eip155:10143')))
    expect(res.status).toBe(200)
    expect((await res.json()).network).toBe('eip155:10143')
  })

  it('a facilitator that is up but does not list the network leaves it out too', async () => {
    const s = setup()
    s.x402org.getSupported.mockResolvedValue({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:1' }], extensions: [], signers: {} })
    expect(await networksOf(await s.gate.handle(get(URL_TESTNET)))).toEqual(['eip155:10143'])
  })

  it('a facilitator that lists networks of the other one cannot take them over', async () => {
    const s = setup()
    // x402.org (say) also claims Monad testnet: Monad testnet is still served by Molandak only.
    s.x402org.getSupported.mockResolvedValue({
      kinds: [
        { x402Version: 2, scheme: 'exact', network: 'eip155:10143' },
        { x402Version: 2, scheme: 'exact', network: 'eip155:84532' },
      ],
      extensions: [],
      signers: {},
    })
    const buyer = createBuyer()
    const res402 = await s.gate.handle(get(URL_TESTNET))
    await s.gate.handle(get(URL_TESTNET, await buyer.payFor(res402, 'eip155:10143')))
    expect(s.molandak.settle).toHaveBeenCalledTimes(1)
    expect(s.x402org.settle).not.toHaveBeenCalled()
  })

  it('the missing network comes back once its facilitator answers again (after the backoff)', async () => {
    let t = 1_000_000
    const s = setup({ now: () => t, retryAfterMs: 30_000 })
    const recover = takeDown(s.x402org)
    expect(await networksOf(await s.gate.handle(get(URL_TESTNET)))).toEqual(['eip155:10143'])
    recover()
    t += 5_000 // inside the backoff: not probed again yet
    expect(await networksOf(await s.gate.handle(get(URL_TESTNET)))).toEqual(['eip155:10143'])
    t += 30_000
    expect(await networksOf(await s.gate.handle(get(URL_TESTNET)))).toEqual(['eip155:10143', 'eip155:84532'])
  })

  it('both facilitators down: 503 facilitator_unavailable, charged no; nothing is cached, so it recovers at once', async () => {
    const s = setup()
    const recoverMonad = takeDown(s.molandak)
    const recoverBase = takeDown(s.x402org)
    const res = await s.gate.handle(get(URL_TESTNET))
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ error: 'facilitator_unavailable', charged: 'no' })
    expect(logs.some((m) => m.includes('/testnet') && m.includes('no facilitator answered'))).toBe(true)

    recoverMonad()
    recoverBase()
    expect(await networksOf(await s.gate.handle(get(URL_TESTNET)))).toEqual(['eip155:10143', 'eip155:84532'])
  })
})

describe('a facilitator that hangs (real HTTP client against local servers)', () => {
  it('still answers 402 within a couple of seconds, offering only the network whose facilitator answered', async () => {
    const supported = JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} })
    const sockets = new Set<import('node:net').Socket>()
    const alive = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(req.url === '/supported' ? supported : '{}')
    })
    const hung = createServer(() => {
      /* accept the request and never answer */
    })
    hung.on('connection', (s) => sockets.add(s))
    await Promise.all([alive, hung].map((srv) => new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok))))
    const urlOf = (srv: typeof alive) => `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
    try {
      const gate = createGate({
        makeFacilitator: (url) => httpFacilitator(url === MOLANDAK ? urlOf(hung) : urlOf(alive), 300),
        log: (m) => logs.push(m),
      })
      const started = Date.now()
      const res = await gate.handle(get(URL_TESTNET))
      const elapsed = Date.now() - started
      expect(await networksOf(res)).toEqual(['eip155:84532'])
      expect(elapsed).toBeLessThan(2500)
    } finally {
      sockets.forEach((s) => s.destroy())
      await Promise.all([alive, hung].map((srv) => new Promise((ok) => srv.close(ok))))
    }
  })
})

describe('GET /', () => {
  it('is one HTML page about the testnet endpoint only, no script, no external resources', async () => {
    const { GET } = await import('../app/route')
    const res = await GET(get('https://ping.test/'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('https://ping.test/testnet')
    expect(html).not.toContain('/mainnet')
    expect(html).toContain('x402 支付测试接口')
    expect(html).toContain('0.01')
    expect(html).toContain(PAY_TO)
    for (const chain of CHAINS) {
      expect(html).toContain(chain.network)
      expect(html).toContain(chain.label)
    }
    // (digit lookahead: "eip155:84532" starts with "eip155:8453")
    expect(html).not.toMatch(/eip155:143(?!\d)/)
    expect(html).not.toMatch(/eip155:8453(?!\d)/)
    expect(html).toContain('测试网 USDC 没有真实价值')
    expect(html).toContain('https://faucet.circle.com')
    expect(html).toContain('主网测试请直接在 AgentVerse 买一个格子（每格 0.10 USDC，Monad 或 Base）：')
    expect(html).toContain('https://www.agent-verse.live/about')
    expect(html).toContain('To test on mainnet, simply buy a cell on AgentVerse (0.10 USDC per cell, Monad or Base)')
    expect(html).toContain('https://www.agent-verse.live/market')
    expect(html.toLowerCase()).not.toContain('<script')
    expect(html).not.toMatch(/<(link|img|iframe|source)\b/i)
    expect(html).not.toMatch(/(src|srcset)=/i)
  })

  it('escapes the origin it echoes', () => {
    const html = landingHtml('https://x"><script>alert(1)</script>')
    expect(html.toLowerCase()).not.toContain('<script')
  })
})

describe('route wiring', () => {
  it('app/testnet is dynamic and uses the shared gate; there is no /mainnet route', async () => {
    const s = setup()
    vi.resetModules()
    vi.doMock('../lib/instance', () => ({ gate: s.gate }))
    const route = await import('../app/testnet/route')
    expect(route.dynamic).toBe('force-dynamic')
    expect(await networksOf(await route.GET(get(URL_TESTNET)))).toEqual(['eip155:10143', 'eip155:84532'])
    vi.doUnmock('../lib/instance')
    const { existsSync } = await import('node:fs')
    expect(existsSync(new URL('../app/mainnet', import.meta.url))).toBe(false)
  })
})
