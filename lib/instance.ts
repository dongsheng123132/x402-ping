import { createGate } from './gate'

/** One gate per server instance (module scope), so the facilitator probe is not repeated on every request. */
export const gate = createGate()
