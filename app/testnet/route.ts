import { gate } from '../../lib/instance'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// Settling waits for a chain confirmation (facilitator timeout is 20s, see lib/gate.ts).
export const maxDuration = 30

export function GET(req: Request) {
  return gate.handle(req)
}
