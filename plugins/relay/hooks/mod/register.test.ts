// The module's hooks, run by `claude plugin test plugins/relay`. The kit runs only *.test.ts
// files, so this one is TypeScript while the module is JavaScript.
//
// The hooks registered here sit beneath the plugin and stand for the engine. The engine skips a
// hook that throws and goes on without it, which would leave a send's result unchanged too, so
// each session.send test also proves the hook ran: by the wake it ran, or by the agent list it
// read. Each agent.spawn test does the same by the check it ran, or by a deny that kept the
// spawn from the engine.
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

test('every relay listed under the name is woken, and a listed agent of another type is not', async ($, on) => {
  const seen = engine(on, {
    agents: () => ({
      value: [
        ...AGENTS,
        // A finished relay stays listed for a while beside a new one under the same name.
        { id: 'a-relay-2', name: 'worker', description: 'a later job', type: 'relay:job', status: 'running' },
      ],
    }),
  })

  expect(await $.session.send({ to: 'worker', text: 'steer', origin: { kind: 'model' } })).toEqual({ isDelivered: true })
  expect(await $.session.send({ to: 'lead', text: 'hello', origin: { kind: 'model' } })).toEqual({ isDelivered: true })

  expect(seen.lists).toHaveLength(2)
  expect(seen.runs.map((r) => r.argv)).toEqual([wakeArgv('a-relay'), wakeArgv('a-relay-2')])
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

// The agent.spawn hook. A check's run as check-header answers it.
const ran = (exitCode: number, stdout: string, isStdoutTruncated = false) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated, isStderrTruncated: false },
})

const checkArgv = ['node', expect.stringMatching(/^\/.*\/scripts\/companion\.mjs$/), 'check-header']

const BAD = 'model: gpt-6.1-sol\nefort: low\n---\nSay hi.'
const GOOD = 'model: gpt-6.1-sol\neffort: low\n---\nSay hi.'
const REFUSAL = 'Unknown header key "efort".'
const STARTED = { model: 'gpt-6.1-sol', agentId: 'a-job' }
const WITHHELD = '(withheld: this workflow run does not share its script)'

// The engine beneath the plugin for a spawn: a process runner answering the check and the
// engine's own spawn, each recording what reached it.
function spawnEngine(on: any, check: () => unknown = () => ran(0, 'ok\n')) {
  const runs: any[] = []
  const spawns: unknown[] = []
  on('process.run', (_: unknown, e: any) => {
    runs.push(e)
    return check()
  })
  on('agent.spawn', (_: unknown, e: unknown) => {
    spawns.push(e)
    return STARTED
  })
  return { runs, spawns }
}

const relay = (prompt: string, extra: Record<string, unknown> = {}) => ({
  prompt,
  subagentType: 'relay:job',
  description: 'a job',
  name: 'worker',
  ...extra,
})

test('a relay:job spawn whose header check refuses it is denied with the message alone', async ($, on) => {
  const seen = spawnEngine(on, () => ran(1, `error: ${REFUSAL}\n`))

  const result = await $.agent.spawn(relay(BAD))

  expect(result).toEqual({ deny: REFUSAL })
  expect(seen.runs.map((r) => r.argv)).toEqual([checkArgv])
  expect(seen.spawns).toHaveLength(0)
})

test('a relay:job spawn whose header check passes reaches the engine unchanged', async ($, on) => {
  const seen = spawnEngine(on)
  const input = relay(GOOD)

  const result = await $.agent.spawn(input)

  expect(result).toEqual(STARTED)
  expect(seen.runs).toHaveLength(1)
  expect(seen.spawns).toEqual([input])
})

test('the check runs check-header with the prompt on stdin, in the cwd the spawn named', async ($, on) => {
  const seen = spawnEngine(on)

  await $.agent.spawn(relay(GOOD))
  await $.agent.spawn(relay(GOOD, { cwd: '/home/dev/repo' }))
  // An empty cwd names no directory, so the check runs in the session's, as the agent will.
  await $.agent.spawn(relay(GOOD, { cwd: '' }))

  expect(seen.runs).toEqual([
    { argv: checkArgv, init: { stdin: GOOD, timeoutMs: 10000 } },
    { argv: checkArgv, init: { stdin: GOOD, timeoutMs: 10000, cwd: '/home/dev/repo' } },
    { argv: checkArgv, init: { stdin: GOOD, timeoutMs: 10000 } },
  ])
  expect(seen.spawns).toHaveLength(3)
})

test('a spawn of another agent type runs no check and reaches the engine', async ($, on) => {
  const seen = spawnEngine(on, () => ran(1, `error: ${REFUSAL}\n`))
  const general = { prompt: BAD, subagentType: 'general-purpose', description: 'look around' }
  const explore = { prompt: BAD, subagentType: 'Explore', description: 'look around' }

  expect(await $.agent.spawn(general)).toEqual(STARTED)
  expect(await $.agent.spawn(explore)).toEqual(STARTED)

  expect(seen.runs).toHaveLength(0)
  expect(seen.spawns).toEqual([general, explore])

  // The same hook denies a relay:job spawn next, so it was loaded and passing the others above.
  expect(await $.agent.spawn(relay(BAD))).toEqual({ deny: REFUSAL })
  expect(seen.spawns).toHaveLength(2)
})

test('a check that gives no verdict lets the spawn through', async ($, on) => {
  const answers: Array<() => unknown> = [
    // The check could not run: a timeout, a spawn failure or a denied process.run.
    () => ({ deny: 'process.run is not allowed here' }),
    // An exit check-header never gives for a verdict.
    () => ran(2, `error: ${REFUSAL}\n`),
    // check-header's own usage error goes to stderr; stdout holds nothing of the parser's.
    () => ran(1, 'Usage: companion check-header\n'),
    // A refusal with no message would deny with an empty reason.
    () => ran(1, 'error:   \n'),
    // A cut-off stdout may hold half a message.
    () => ran(1, `error: ${REFUSAL}`, true),
  ]
  let next = 0
  const seen = spawnEngine(on, () => answers[next++]())

  for (let i = 0; i < answers.length; i++) {
    expect(await $.agent.spawn(relay(BAD)), `answer ${i}`).toEqual(STARTED)
  }

  expect(seen.runs).toHaveLength(answers.length)
  expect(seen.spawns).toEqual(answers.map(() => relay(BAD)))
})

// The kit's $.agent.spawn is typed for an Agent tool call's fields, but it hands the plugin the
// whole input, so a Workflow's or a resume's fields reach the hook as the engine would set them.
test('a Workflow agent with a bad header is denied, and a withheld prompt is not checked', async ($, on) => {
  const seen = spawnEngine(on, () => ran(1, `error: ${REFUSAL}\n`))
  const workflow = { runId: 'wf_7f3a', agentIndex: 1 }
  const withheld = relay(WITHHELD, { workflow: { runId: 'wf_7f3a', agentIndex: 2 }, background: false })

  const denied = await $.agent.spawn(relay(BAD, { workflow, background: false }) as any)
  const passed = await $.agent.spawn(withheld as any)

  expect(denied).toEqual({ deny: REFUSAL })
  expect(passed).toEqual(STARTED)
  expect(seen.runs).toEqual([{ argv: checkArgv, init: { stdin: BAD, timeoutMs: 10000 } }])
  expect(seen.spawns).toEqual([withheld])
})

test('a resumed relay:job agent is not checked and reaches the engine', async ($, on) => {
  const seen = spawnEngine(on, () => ran(1, `error: ${REFUSAL}\n`))
  // A resume's prompt is the resuming message, which has no header.
  const resumed = relay('Go on with the tests.', { resume: { agentId: 'a-job' } })

  expect(await $.agent.spawn(resumed as any)).toEqual(STARTED)

  expect(seen.runs).toHaveLength(0)
  expect(seen.spawns).toEqual([resumed])

  // The same hook denies a new relay:job spawn next, so it was loaded and running above.
  expect(await $.agent.spawn(relay(BAD))).toEqual({ deny: REFUSAL })
  expect(seen.runs).toHaveLength(1)
})
