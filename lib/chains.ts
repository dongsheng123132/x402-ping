/**
 * The two networks x402-ping can be paid on (testnets only; mainnet testing is done by really buying an
 * AgentVerse cell), and the facilitator of each.
 *
 * Every value below was copied, not guessed. Sources (all re-checked 2026-10-06):
 *   - C:\1mineyswitch\repos\agent-verse.live-new\final\lib\x402-flow.ts   (production-proven seller)
 *   - C:\1mineyswitch\packages\x402\src\networks.ts                       (MoneySwitch's verified network table)
 *   - @x402/evm 2.27.0 DEFAULT_ASSETS (dist/cjs/exact/server/index.js)    (cross-check for Base Sepolia)
 * The EIP-712 domain (name, version) is what the buyer signs the USDC transferWithAuthorization
 * against; a wrong value makes every payment fail with an invalid signature.
 */

export type Caip2 = `${string}:${string}`

export interface Chain {
  network: Caip2
  label: string
  /** USDC contract. */
  usdc: `0x${string}`
  /** EIP-712 domain of that USDC contract. */
  domain: { name: string; version: string }
  facilitatorUrl: string
}

/** x402-flow.ts:63-64,75-80 (MONAD_TESTNET_CHAIN, domain USDC/2 on lines 78-79) = networks.ts:32-48 (TESTNET, domain lines 39-40). Not in @x402/evm's table. */
export const MONAD_TESTNET: Chain = {
  network: 'eip155:10143',
  label: 'Monad testnet',
  usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
  domain: { name: 'USDC', version: '2' },
  facilitatorUrl: 'https://x402-facilitator.molandak.org',
}

/** x402-flow.ts:65-67,81-86 (BASE_SEPOLIA_CHAIN, domain USDC/2 on lines 84-85) = networks.ts:82-89 (domain line 86) = @x402/evm DEFAULT_ASSETS["eip155:84532"]. */
export const BASE_SEPOLIA: Chain = {
  network: 'eip155:84532',
  label: 'Base Sepolia',
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  domain: { name: 'USDC', version: '2' },
  facilitatorUrl: 'https://x402.org/facilitator',
}

/** Order matters: it is the order of `accepts` in the 402. */
export const CHAINS: readonly Chain[] = [MONAD_TESTNET, BASE_SEPOLIA]

export const PRICE_USD = '0.01'
/** 0.01 USDC at 6 decimals. */
export const PRICE_ATOMIC = '10000'

const DEFAULT_PAY_TO = '0x4eCf92bAb524039Fc4027994b9D88C2DB2Ee05E6'
/** Same receiving address on both networks; PAY_TO_ADDRESS overrides it. */
export function payToAddress(env: Record<string, string | undefined> = process.env): string {
  return env.PAY_TO_ADDRESS || DEFAULT_PAY_TO
}
