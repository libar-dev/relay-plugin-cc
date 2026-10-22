// The module's session.send hook, run by `claude plugin test plugins/relay`. The kit runs only
// *.test.ts files, so this one is TypeScript while the module is JavaScript.
//
// The hooks registered here sit beneath the plugin and stand for the engine. The engine skips a
// hook that throws and goes on without it, which would leave a send's result unchanged too, so
// each test also proves the hook ran: by the wake it ran, or by the agent list it read.
import { expect, test } from 'claude-code/testing'

const AGENTS = [
  { id: 'a-lead', name: 'lead', description: 'lead', type: 'general-purpose', status: 'running' },
  { id: 'a-relay', name: 'worker', description: 'a job', type: 'relay:job', status: 'running' },
]

const RAN = { exitCode: 0, stdout: 'wake: job-1\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

// The argv the hook must run for an agent id; the kit loads the plugin from its folder, so the
// companion path ends in this plugin's scripts.
const wakeArgv = (id: string) => [
  'node',
  expect.stringMatching(/^\/.*\/scripts\/companion\.mjs$/),
  'wake',
  '--agent',
  id,
]

type Options = {
  agents?: () => unknown
  run?: () => unknown
  sent?: () => unknown
}

// The engine beneath the plugin: an agent list, a process runner and a send that queues the
// message, each recording what reached it.
function engine(on: any, options: Options = {}) {
  const lists: unknown[] = []
  const runs: any[] = []
  const sends: unknown[] = []
  on('agent.list', (_: unknown, e: unknown) => {
    lists.push(e)
    return options.agents ? options.agents() : { value: AGENTS }
  })
  on('process.run', (_: unknown, e: any) => {
    runs.push(e)
    return options.run ? options.run() : { value: RAN }
  })
  on('session.send', (_: unknown, e: unknown) => {
    sends.push(e)
    return options.sent ? options.sent() : { isDelivered: true }
  })
  return { lists, runs, sends }
}

test('a delivered send to an agent named in the list wakes that agent by its id', async ($, on) => {
  const seen = engine(on)
  const send = { to: 'worker', text: 'steer: stop after the tests', origin: { kind: 'model' as const } }

  const result = await $.session.send(send)

  expect(result).toEqual({ isDelivered: true })
  expect(seen.sends).toEqual([send])
  expect(seen.runs).toHaveLength(1)
  expect(seen.runs[0]).toEqual({ argv: wakeArgv('a-relay'), init: { timeoutMs: 10000 } })
})

test('a send to an id wakes that id, listed or not', async ($, on) => {
  const seen = engine(on)

  const listed = await $.session.send({ to: 'a-relay', text: 'one', origin: { kind: 'model' } })
  // A Workflow's agents are not in the list; SendMessage addresses them by id.
  const unlisted = await $.session.send({ to: 'wf-7f3a', text: 'two', origin: { kind: 'model' } })

  expect(listed).toEqual({ isDelivered: true })
  expect(unlisted).toEqual({ isDelivered: true })
  expect(seen.runs.map((r) => r.argv)).toEqual([wakeArgv('a-relay'), wakeArgv('wf-7f3a')])
})

test('a send that was not delivered wakes nothing and keeps its refusal', async ($, on) => {
  let isDelivered = false
  const seen = engine(on, {
    sent: () => (isDelivered ? { isDelivered: true } : { isDelivered: false, reason: 'no agent named ghost' }),
  })

  const refused = await $.session.send({ to: 'ghost', text: 'hello', origin: { kind: 'model' } })

  expect(refused).toEqual({ isDelivered: false, reason: 'no agent named ghost' })
  expect(seen.sends).toHaveLength(1)
  expect(seen.lists).toHaveLength(0)
  expect(seen.runs).toHaveLength(0)

  // The same hook wakes on the next send that is delivered, so it was loaded and running above.
  isDelivered = true
  await $.session.send({ to: 'worker', text: 'hello', origin: { kind: 'model' } })
  expect(seen.runs.map((r) => r.argv)).toEqual([wakeArgv('a-relay')])
})

test('a wake that fails leaves the send delivered', async ($, on) => {
  const seen = engine(on, { run: () => ({ deny: 'node: not found' }) })

  const result = await $.session.send({ to: 'worker', text: 'steer', origin: { kind: 'model' } })

  expect(result).toEqual({ isDelivered: true })
  expect(seen.sends).toHaveLength(1)
  expect(seen.runs.map((r) => r.argv)).toEqual([wakeArgv('a-relay')])
})

test('an agent list that fails leaves the send delivered and runs no wake', async ($, on) => {
  const seen = engine(on, { agents: () => ({ deny: 'the session is not bound yet' }) })

  const result = await $.session.send({ to: 'worker', text: 'steer', origin: { kind: 'model' } })

  expect(result).toEqual({ isDelivered: true })
  expect(seen.sends).toHaveLength(1)
  expect(seen.lists).toHaveLength(1)
  expect(seen.runs).toHaveLength(0)
})

test('a send from a plugin or from a subagent wakes the same way', async ($, on) => {
  const seen = engine(on)
  const fromPlugin = { to: 'worker', text: 'from a button', origin: { kind: 'plugin' as const, name: 'board' } }
  const fromSubagent = { to: 'a-relay', text: 'from a subagent', origin: { kind: 'model' as const }, agentId: 'a-lead' }

  expect(await $.session.send(fromPlugin)).toEqual({ isDelivered: true })
  expect(await $.session.send(fromSubagent)).toEqual({ isDelivered: true })

  expect(seen.sends).toEqual([fromPlugin, fromSubagent])
  expect(seen.runs.map((r) => r.argv)).toEqual([wakeArgv('a-relay'), wakeArgv('a-relay')])
})
