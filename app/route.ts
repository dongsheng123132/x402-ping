import { landingHtml } from '../lib/landing'

// Never cache and never prerender: the page shows the URL it is served from.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET(req: Request) {
  return new Response(landingHtml(new URL(req.url).origin), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}
