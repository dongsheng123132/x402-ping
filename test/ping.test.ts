import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ALL_CHAINS, BASE, BASE_SEPOLIA, MONAD, MONAD_TESTNET, PRICE_ATOMIC, ROUTES, payToAddress } from '../lib/chains'
import { createGates, httpFacilitator, usdcToAtomic } from '../lib/gate'
import { landingHtml } from '../lib/landing'
import { MOLANDAK, PAYAI, X402_ORG, createBuyer, createFacilitators, decodeHeader, get, takeDown } from './helpers'

// Written out here, independently of lib/chains.ts, so a typo there cannot hide behind itself.
const PAY_TO = '0x4eCf92bAb524039Fc4027994b9D88C2DB2Ee05E6'
const EXPECTED = {
  'eip155:143': { usdc: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', name: 'USDC', version: '2' },
  'eip155:8453': { usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2' },
  'eip155:10143': { usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3', name: 'USDC', version: '2' },
  'eip155:84532': { usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC', version: '2' },
} as const

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

function setup(overrides: Parameters<typeof createGates>[0] = {}) {
  const f = createFacilitators()
  const gates = createGates({ makeFacilitator: f.makeFacilitator, log: (m) => logs.push(m), ...overrides })
  return { ...f, gates }
}

async function accepts(res: Response) {
  expect(res.status).toBe(402)
  return decodeHeader(res.headers.get('PAYMENT-REQUIRED')).accepts as Array<Record<string, any>>
}

describe('402 offers', () => {
  it('/mainnet offers exactly Monad mainnet then Base mainnet, 0.01 USDC to the one address', async () => {
    const { gates } = setup()
    const res = await gates.mainnet.handle(get('https://ping.test/mainnet'))
    expect(res.status).toBe(402)
    const header = decodeHeader(res.headers.get('PAYMENT-REQUIRED'))
    expect(header.x402Version).toBe(2)
    const list = header.accepts
    expect(list).toHaveLength(2)
    expect(list.map((a: any) => a.network)).toEqual(['eip155:143', 'eip155:8453'])
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

  it('/testnet offers exactly Monad testnet then Base Sepolia, 0.01 USDC to the one address', async () => {
    const { gates } = setup()
    const res = await gates.testnet.handle(get('https://ping.test/testnet'))
    const list = await accepts(res)
    expect(list).toHaveLength(2)
    expect(list.map((a) => a.network)).toEqual(['eip155:10143', 'eip155:84532'])
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

  it('never mixes mainnet and testnet in one 402', async () => {
    const { gates } = setup()
    const main = (await accepts(await gates.mainnet.handle(get('https://ping.test/mainnet')))).map((a) => a.network)
    const test = (await accepts(await gates.testnet.handle(get('https://ping.test/testnet')))).map((a) => a.network)
    expect(main.some((n) => ['eip155:10143', 'eip155:84532'].includes(n))).toBe(false)
    expect(test.some((n) => ['eip155:143', 'eip155:8453'].includes(n))).toBe(false)
  })

  it('the route table, facilitators and price are what the task prescribes', () => {
    expect(ROUTES['/mainnet'].map((c) => c.network)).toEqual(['eip155:143', 'eip155:8453'])
    expect(ROUTES['/testnet'].map((c) => c.network)).toEqual(['eip155:10143', 'eip155:84532'])
    expect([MONAD, BASE, MONAD_TESTNET, BASE_SEPOLIA].map((c) => c.facilitatorUrl)).toEqual([MOLANDAK, PAYAI, MOLANDAK, X402_ORG])
    expect(ALL_CHAINS.map((c) => c.testnet)).toEqual([false, false, true, true])
    expect(PRICE_ATOMIC).toBe('10000')
    expect(usdcToAtomic('0.01')).toBe('10000')
    expect(payToAddress({})).toBe(PAY_TO)
  })

  it('PAY_TO_ADDRESS overrides the receiving address', async () => {
    process.env.PAY_TO_ADDRESS = '0x1111111111111111111111111111111111111111'
    const { gates } = setup()
    const list = await accepts(await gates.mainnet.handle(get('https://ping.test/mainnet')))
    expect(list.map((a) => a.payTo)).toEqual(['0x1111111111111111111111111111111111111111', '0x1111111111111111111111111111111111111111'])
  })
})

describe('paid flow', () => {
  const cases = [
    { route: 'mainnet', network: 'eip155:143', testnet: false, facilitator: 'molandak' },
    { route: 'mainnet', network: 'eip155:8453', testnet: false, facilitator: 'payai' },
    { route: 'testnet', network: 'eip155:10143', testnet: true, facilitator: 'molandak' },
    { route: 'testnet', network: 'eip155:84532', testnet: true, facilitator: 'x402org' },
  ] as const

  it.each(cases)('$route paid on $network returns the JSON receipt and PAYMENT-RESPONSE', async ({ route, network, testnet, facilitator }) => {
    const s = setup()
    const buyer = createBuyer()
    const url = `https://ping.test/${route}`
    const gate = s.gates[route]
    const res402 = await gate.handle(get(url))
    const res = await gate.handle(get(url, await buyer.payFor(res402, network)))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['amount', 'asset', 'at', 'network', 'ok', 'pay_to', 'payer', 'service', 'testnet', 'tx'])
    expect(body).toMatchObject({
      ok: true,
      service: 'x402-ping',
      network,
      testnet,
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
    for (const [name, f] of Object.entries({ molandak: s.molandak, payai: s.payai, x402org: s.x402org })) {
      expect(f.settle).toHaveBeenCalledTimes(name === facilitator ? 1 : 0)
    }
  })

  it('a payment that does not verify is answered 402 and never settled', async () => {
    const s = setup()
    const buyer = createBuyer()
    const res402 = await s.gates.mainnet.handle(get('https://ping.test/mainnet'))
    const headers = await buyer.payFor(res402, 'eip155:143')
    s.molandak.verify.mockResolvedValueOnce({ isValid: false, invalidReason: 'insufficient_funds' })
    const res = await s.gates.mainnet.handle(get('https://ping.test/mainnet', headers))
    expect(res.status).toBe(402)
    expect(s.molandak.settle).not.toHaveBeenCalled()
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull()
  })

  it('a settlement that fails is not answered 200', async () => {
    const s = setup()
    const buyer = createBuyer()
    const res402 = await s.gates.testnet.handle(get('https://ping.test/testnet'))
    const headers = await buyer.payFor(res402, 'eip155:84532')
    s.x402org.settle.mockResolvedValueOnce({ success: false, errorReason: 'transaction_failed', transaction: '', network: 'eip155:84532' })
    const res = await s.gates.testnet.handle(get('https://ping.test/testnet', headers))
    expect(res.status).toBe(402)
    expect(await res.text()).not.toContain('"ok":true')
  })

  it('a facilitator that errors during settlement is reported as unconfirmed, not as "not charged"', async () => {
    const s = setup()
    const buyer = createBuyer()
    const res402 = await s.gates.testnet.handle(get('https://ping.test/testnet'))
    const headers = await buyer.payFor(res402, 'eip155:10143')
    const { FacilitatorTimeoutError } = await import('@x402/core/server')
    s.molandak.settle.mockRejectedValueOnce(new FacilitatorTimeoutError('settle', 20000))
    const res = await s.gates.testnet.handle(get('https://ping.test/testnet', headers))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'settlement_unconfirmed', charged: 'unknown' })
  })
})

describe('facilitator down', () => {
  it('Molandak down: /mainnet offers only Base, /testnet only Base Sepolia, and Base still takes a payment (logged)', async () => {
    const s = setup()
    takeDown(s.molandak)
    expect((await accepts(await s.gates.mainnet.handle(get('https://ping.test/mainnet')))).map((a) => a.network)).toEqual(['eip155:8453'])
    expect((await accepts(await s.gates.testnet.handle(get('https://ping.test/testnet')))).map((a) => a.network)).toEqual(['eip155:84532'])
    expect(logs.some((m) => m.includes('/mainnet') && m.includes('eip155:143') && m.includes('left out'))).toBe(true)
    expect(logs.some((m) => m.includes('/testnet') && m.includes('eip155:10143') && m.includes('left out'))).toBe(true)

    const buyer = createBuyer()
    const res402 = await s.gates.mainnet.handle(get('https://ping.test/mainnet'))
    const res = await s.gates.mainnet.handle(get('https://ping.test/mainnet', await buyer.payFor(res402, 'eip155:8453')))
    expect(res.status).toBe(200)
    expect((await res.json()).network).toBe('eip155:8453')
  })

  it('PayAI down: /mainnet offers only Monad mainnet, and Monad still takes a payment', async () => {
    const s = setup()
    takeDown(s.payai)
    expect((await accepts(await s.gates.mainnet.handle(get('https://ping.test/mainnet')))).map((a) => a.network)).toEqual(['eip155:143'])
    // /testnet is a different facilitator pair and is not affected.
    expect((await accepts(await s.gates.testnet.handle(get('https://ping.test/testnet')))).map((a) => a.network)).toEqual(['eip155:10143', 'eip155:84532'])
    expect(logs.some((m) => m.includes('eip155:8453') && m.includes('left out'))).toBe(true)

    const buyer = createBuyer()
    const res402 = await s.gates.mainnet.handle(get('https://ping.test/mainnet'))
    const res = await s.gates.mainnet.handle(get('https://ping.test/mainnet', await buyer.payFor(res402, 'eip155:143')))
    expect(res.status).toBe(200)
    expect((await res.json()).network).toBe('eip155:143')
  })

  it('x402.org down: /testnet offers only Monad testnet', async () => {
    const s = setup()
    takeDown(s.x402org)
    expect((await accepts(await s.gates.testnet.handle(get('https://ping.test/testnet')))).map((a) => a.network)).toEqual(['eip155:10143'])
  })

  it('a facilitator that is up but does not list the network leaves it out too', async () => {
    const s = setup()
    s.payai.getSupported.mockResolvedValue({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:1' }], extensions: [], signers: {} })
    expect((await accepts(await s.gates.mainnet.handle(get('https://ping.test/mainnet')))).map((a) => a.network)).toEqual(['eip155:143'])
  })

  it('the missing chain comes back once its facilitator answers again (after the backoff)', async () => {
    let t = 1_000_000
    const s = setup({ now: () => t, retryAfterMs: 30_000 })
    const recover = takeDown(s.payai)
    expect((await accepts(await s.gates.mainnet.handle(get('https://ping.test/mainnet')))).map((a) => a.network)).toEqual(['eip155:143'])
    recover()
    t += 5_000 // inside the backoff: not probed again yet
    expect((await accepts(await s.gates.mainnet.handle(get('https://ping.test/mainnet')))).map((a) => a.network)).toEqual(['eip155:143'])
    t += 30_000
    expect((await accepts(await s.gates.mainnet.handle(get('https://ping.test/mainnet')))).map((a) => a.network)).toEqual(['eip155:143', 'eip155:8453'])
  })

  it('all facilitators of a route down: 503 facilitator_unavailable, charged no; the other route is unaffected; recovers', async () => {
    const s = setup()
    const recoverMonad = takeDown(s.molandak)
    const recoverPayai = takeDown(s.payai)
    const res = await s.gates.mainnet.handle(get('https://ping.test/mainnet'))
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ error: 'facilitator_unavailable', charged: 'no' })
    expect(logs.some((m) => m.includes('/mainnet') && m.includes('no facilitator answered'))).toBe(true)
    // /testnet still has x402.org for Base Sepolia
    expect((await accepts(await s.gates.testnet.handle(get('https://ping.test/testnet')))).map((a) => a.network)).toEqual(['eip155:84532'])
    // nothing was cached from the failure: the next request after recovery works at once
    recoverMonad()
    recoverPayai()
    expect((await accepts(await s.gates.mainnet.handle(get('https://ping.test/mainnet')))).map((a) => a.network)).toEqual(['eip155:143', 'eip155:8453'])
  })
})

describe('a facilitator that hangs (real HTTP client against local servers)', () => {
  it('still answers 402 within a couple of seconds, offering only the chain whose facilitator answered', async () => {
    const supported = JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }], extensions: [], signers: {} })
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
      const gates = createGates({
        makeFacilitator: (url) => httpFacilitator(url === MOLANDAK ? urlOf(hung) : urlOf(alive), 300),
        log: (m) => logs.push(m),
      })
      const started = Date.now()
      const res = await gates.mainnet.handle(get('https://ping.test/mainnet'))
      const elapsed = Date.now() - started
      expect((await accepts(res)).map((a) => a.network)).toEqual(['eip155:8453'])
      expect(elapsed).toBeLessThan(2500)
    } finally {
      sockets.forEach((s) => s.destroy())
      await Promise.all([alive, hung].map((srv) => new Promise((ok) => srv.close(ok))))
    }
  })
})

describe('GET /', () => {
  it('is one HTML page with both URLs, no script, no external resources', async () => {
    const { GET } = await import('../app/route')
    const res = await GET(get('https://ping.test/'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('https://ping.test/mainnet')
    expect(html).toContain('https://ping.test/testnet')
    expect(html).toContain('x402 支付测试接口')
    expect(html).toContain('0.01 USDC')
    expect(html).toContain(PAY_TO)
    for (const chain of ALL_CHAINS) expect(html).toContain(chain.network)
    expect(html).toContain('测试网 USDC 没有真实价值；主网每次真实扣 0.01 USDC')
    expect(html).toContain('https://faucet.circle.com')
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
  it('app/mainnet and app/testnet are dynamic and each use their own gate', async () => {
    const s = setup()
    vi.resetModules()
    vi.doMock('../lib/instance', () => ({ gates: s.gates }))
    const main = await import('../app/mainnet/route')
    const test = await import('../app/testnet/route')
    expect(main.dynamic).toBe('force-dynamic')
    expect(test.dynamic).toBe('force-dynamic')
    expect((await accepts(await main.GET(get('https://ping.test/mainnet')))).map((a) => a.network)).toEqual(['eip155:143', 'eip155:8453'])
    expect((await accepts(await test.GET(get('https://ping.test/testnet')))).map((a) => a.network)).toEqual(['eip155:10143', 'eip155:84532'])
    vi.doUnmock('../lib/instance')
  })
})
