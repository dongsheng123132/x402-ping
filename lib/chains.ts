/**
 * The four networks x402-ping can be paid on, and which URL offers which.
 *
 * Every value below was copied, not guessed. Sources (all re-checked 2026-10-06):
 *   - C:\1mineyswitch\repos\agent-verse.live-new\final\lib\x402-flow.ts   (production-proven seller)
 *   - C:\1mineyswitch\packages\x402\src\networks.ts                       (MoneySwitch's verified network table)
 *   - @x402/evm 2.27.0 DEFAULT_ASSETS (dist/cjs/exact/server/index.js)    (cross-check for the 3 networks it knows)
 * The EIP-712 domain (name, version) is what the buyer signs the USDC transferWithAuthorization
 * against; a wrong value makes every payment fail with an invalid signature.
 */

export type Caip2 = `${string}:${string}`

export interface Chain {
  network: Caip2
  label: string
  testnet: boolean
  /** USDC contract. */
  usdc: `0x${string}`
  /** EIP-712 domain of that USDC contract. */
  domain: { name: string; version: string }
  facilitatorUrl: string
}

const MOLANDAK = 'https://x402-facilitator.molandak.org'

/** networks.ts:50-67 (MAINNET) and x402-flow.ts:33-34; domain USDC/2 = networks.ts:58-59 = @x402/evm DEFAULT_ASSETS["eip155:143"]. */
export const MONAD: Chain = {
  network: 'eip155:143',
  label: 'Monad mainnet',
  testnet: false,
  usdc: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  domain: { name: 'USDC', version: '2' },
  facilitatorUrl: MOLANDAK,
}

/** networks.ts:73-80 (BASE); domain "USD Coin"/2 = networks.ts:77 = @x402/evm DEFAULT_ASSETS["eip155:8453"]. Facilitator: PayAI, keyless. */
export const BASE: Chain = {
  network: 'eip155:8453',
  label: 'Base mainnet',
  testnet: false,
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  domain: { name: 'USD Coin', version: '2' },
  facilitatorUrl: 'https://facilitator.payai.network',
}

/** x402-flow.ts:63-64,75-80 (MONAD_TESTNET_CHAIN, domain USDC/2 on lines 78-79) = networks.ts:32-48 (TESTNET, domain lines 39-40). Not in @x402/evm's table. */
export const MONAD_TESTNET: Chain = {
  network: 'eip155:10143',
  label: 'Monad testnet',
  testnet: true,
  usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
  domain: { name: 'USDC', version: '2' },
  facilitatorUrl: MOLANDAK,
}

/** x402-flow.ts:65-67,81-86 (BASE_SEPOLIA_CHAIN, domain USDC/2 on lines 84-85) = networks.ts:82-89 (domain line 86) = @x402/evm DEFAULT_ASSETS["eip155:84532"]. */
export const BASE_SEPOLIA: Chain = {
  network: 'eip155:84532',
  label: 'Base Sepolia',
  testnet: true,
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  domain: { name: 'USDC', version: '2' },
  facilitatorUrl: 'https://x402.org/facilitator',
}

/** Order matters: it is the order of `accepts` in the 402. Mainnet and testnet are never mixed in one route. */
export const ROUTES = {
  '/mainnet': [MONAD, BASE],
  '/testnet': [MONAD_TESTNET, BASE_SEPOLIA],
} as const satisfies Record<string, readonly Chain[]>

export type RoutePath = keyof typeof ROUTES

export const PRICE_USD = '0.01'
/** 0.01 USDC at 6 decimals. */
export const PRICE_ATOMIC = '10000'

const DEFAULT_PAY_TO = '0x4eCf92bAb524039Fc4027994b9D88C2DB2Ee05E6'
/** Same receiving address on every network; PAY_TO_ADDRESS overrides it. */
export function payToAddress(env: Record<string, string | undefined> = process.env): string {
  return env.PAY_TO_ADDRESS || DEFAULT_PAY_TO
}

export const ALL_CHAINS: readonly Chain[] = [MONAD, BASE, MONAD_TESTNET, BASE_SEPOLIA]
