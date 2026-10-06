# x402-ping

x402 支付测试接口：用你的 x402 客户端或钱包付 0.01 USDC，拿回一张 JSON 回执。用来确认客户端能在一个真实的卖家上完成支付。无数据库、无 API key、无私钥。

## 地址

把 `<deployment>` 换成部署后的域名：

| URL | 提供的网络（按此顺序） | 钱 |
| --- | --- | --- |
| `https://<deployment>/` | 一页静态说明 | |
| `https://<deployment>/mainnet` | Monad 主网 `eip155:143`，Base 主网 `eip155:8453` | 真钱，每次 0.01 USDC |
| `https://<deployment>/testnet` | Monad 测试网 `eip155:10143`，Base Sepolia `eip155:84532` | 测试网 USDC，无真实价值 |

主网和测试网永远不会出现在同一个 402 里。所有网络同一个收款地址 `0x4eCf92bAb524039Fc4027994b9D88C2DB2Ee05E6`（环境变量 `PAY_TO_ADDRESS` 可覆盖），价格都是 10000 原子单位（0.01 USDC）。

- 不带支付：HTTP 402，x402 v2，`PAYMENT-REQUIRED` 头。
- 付款成功：HTTP 200，`{"ok":true,"service":"x402-ping","network":...,"testnet":...,"amount":"0.01","asset":"USDC","pay_to":...,"payer":...,"tx":...,"at":...}`，并带标准 `PAYMENT-RESPONSE` 头。
- 某个 facilitator 不可用：402 里只保留另一个网络（日志里有记录）；该路径的 facilitator 全不可用：503 `{"error":"facilitator_unavailable","charged":"no"}`。
- 所有响应都是 `Cache-Control: no-store`。

## Facilitator

| 网络 | Facilitator |
| --- | --- |
| Monad 主网 / Monad 测试网 | `https://x402-facilitator.molandak.org` |
| Base 主网 | `https://facilitator.payai.network`（PayAI，免 key） |
| Base Sepolia | `https://x402.org/facilitator` |

**PayAI on Base mainnet is unverified until the first real payment.** 本地只读调用过它的 `/supported`，列出了 `eip155:8453`，但还没有用它真实结算过一笔 Base 主网付款。

## 测试里发现的客户端坑

`@x402/core` 2.27 的客户端默认只肯付它内置资产表里的 USDC；Monad 测试网 USDC（`0x534b…43A3`）不在表里，默认配置会报 `All payment requirements were rejected by spendControls`。要在 `/testnet` 上走 Monad 测试网，客户端得 `setSpendControls({ allowedAssets: [{ network: 'eip155:10143', asset: '0x534b2f3A21130d7a60830c2Df862319e593943A3' }] })`。

## 运行时选择

最小的 Next.js 14 应用，只有 route handler（没有页面、没有客户端 JS）：同样的 Next 14 + `@x402/core`/`@x402/evm` 2.27.0 组合已在 agent-verse 线上跑过，而且 `npm run check` 里的 `next build` 能在本地验证打包，纯 Vercel functions 加 rewrites 没法在本地验证 Vercel 的 TS 编译。

## 本地运行与测试

```
npm install
npm run check      # tsc --noEmit + vitest（不联网，用 mock facilitator）+ next build
npm test           # 只跑测试
npm run dev        # http://localhost:3010
```

## 部署

```
vercel deploy --prod
```

作为独立的 Vercel 项目部署（Node 运行时，不需要任何环境变量）。
