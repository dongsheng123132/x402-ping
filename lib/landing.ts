import { BASE_SEPOLIA, MONAD_TESTNET, PRICE_USD, payToAddress } from './chains'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The whole site: one static HTML page, no JavaScript, nothing loaded from elsewhere. `origin` is the page's own origin. */
export function landingHtml(origin: string): string {
  const o = esc(origin)
  const payTo = esc(payToAddress())
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>x402-ping — x402 支付测试接口</title>
<style>
body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#111}
code{background:#f2f2f2;padding:.1rem .3rem;border-radius:3px;word-break:break-all}
li{margin:.4rem 0}
</style>
</head>
<body>
<h1>x402-ping</h1>
<p>这是一个 x402 支付测试接口（只有测试网）：用你的 x402 客户端或钱包向它付 ${PRICE_USD} 测试网 USDC，它返回一张 JSON 回执。用来确认你的客户端能在真实的卖家上完成支付。</p>
<ul>
<li><code>${o}/testnet</code> — ${MONAD_TESTNET.label}（<code>${MONAD_TESTNET.network}</code>）、${BASE_SEPOLIA.label}（<code>${BASE_SEPOLIA.network}</code>）</li>
</ul>
<p>价格：每次 ${PRICE_USD} USDC（两个网络相同）。收款地址（两个网络相同）：<code>${payTo}</code></p>
<p><strong>测试网 USDC 没有真实价值。</strong></p>
<p>Monad 测试网 USDC 可在 <a href="https://faucet.circle.com">https://faucet.circle.com</a> 领取。</p>
<p>主网测试请直接在 AgentVerse 买一个格子（每格 0.10 USDC，Monad 或 Base）：<a href="https://www.agent-verse.live/about">https://www.agent-verse.live/about</a></p>
<p>本接口已收录在 AgentVerse：<a href="https://www.agent-verse.live/market">https://www.agent-verse.live/market</a></p>
<hr>
<p lang="en">x402-ping is an x402 payment test endpoint (testnets only). Pay ${PRICE_USD} testnet USDC with your x402 client or wallet at <code>${o}/testnet</code> (Monad testnet or Base Sepolia) and get back a small JSON receipt. Testnet USDC has no real value; get Monad testnet USDC at https://faucet.circle.com. Receiving address on both networks: <code>${payTo}</code>. To test on mainnet, simply buy a cell on AgentVerse (0.10 USDC per cell, Monad or Base): https://www.agent-verse.live/about. Listed on AgentVerse: https://www.agent-verse.live/market</p>
</body>
</html>
`
}
