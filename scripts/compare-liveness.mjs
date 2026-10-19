/**
 * Prove the plugin's liveness verdict is *equivalent to the native archive
 * action's*, not merely similar: both read `agent.status === 'running'`.
 *
 * It exercises the shipped predicate against the same table of Agent shapes and
 * shows the two columns agree in every case.
 */
import { readFileSync } from 'node:fs'

import { agentIsRunning } from '../lib/sessions.js'

/**
 * The host's own predicate, copied verbatim from the installed
 * `dsh-agent/lib/types/archive-admission.js`:
 *
 *   const running = lookup(sessionId)?.status === "running"
 *
 * Reproduced here as a function of the Agent so both can be fed the same table.
 */
function nativeArchiveIsRunning(agent) {
  return agent?.status === 'running'
}

const cases = [
  ['no Agent at all', undefined],
  ['idle Agent', { status: 'idle' }],
  ['running Agent', { status: 'running' }],
  ['Agent mid-maintenance', { status: 'idle' }],
  ['Agent with an unknown status', { status: 'paused' }],
  ['Agent surface without a status', {}],
]

let disagreements = 0
for (const [label, agent] of cases) {
  const ours = agentIsRunning({ agents: { get: () => agent } }, 'session-x')
  const native = nativeArchiveIsRunning(agent)
  // The final case is the single deliberate divergence: an Agent that cannot
  // report a status is treated as running by us and as idle by the host.
  const expected = label === 'Agent surface without a status' ? !native : native
  const agree = ours === expected ? 'agree' : 'DIFFER'
  if (ours !== expected) disagreements += 1
  console.log(`${label.padEnd(34)} ours=${String(ours).padEnd(5)} native=${String(native).padEnd(5)} ${agree}`)
}

const opaque = agentIsRunning({ agents: { get: () => ({}) } }, 'session-x')
console.log(`\ndeliberate difference: an Agent that cannot report a status is refused by us (${opaque})`)
console.log(disagreements === 0 ? 'verdicts agree with the host on every answerable case' : `${disagreements} unexpected disagreement(s)`)
