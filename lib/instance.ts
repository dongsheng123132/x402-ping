import { createGates } from './gate'

/** One pair of gates per server instance (module scope), so the facilitator probe is not repeated on every request. */
export const gates = createGates()
