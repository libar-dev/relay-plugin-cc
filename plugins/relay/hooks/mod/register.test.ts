// The module's hooks, run by `claude plugin test plugins/relay`. The kit runs only *.test.ts
// files, so this one is TypeScript while the module is JavaScript.
//
// The hooks registered here sit beneath the plugin and stand for the engine. The engine skips a
// hook that throws and goes on without it, which would leave a send's result unchanged too, so
// each session.send test also proves the hook ran: by the wake it ran, or by the agent list it
// read. Each agent.spawn test does the same by the check it ran, or by a deny that kept the
// spawn from the engine.
import { expect, mock, test } from 'claude-code/testing'

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
test('a Workflow agent whose prompt has no --- line runs no check and reaches the engine', async ($, on) => {
  const seen = spawnEngine(on, () => ran(1, `error: ${REFUSAL}\n`))
  // 2.1.308's placeholder on a run that keeps its script out of SDK events, and wording another
  // build might use instead: neither is the script's prompt.
  const withheld = relay(WITHHELD, { workflow: { runId: 'wf_7f3a', agentIndex: 1 }, background: false })
  const other = relay('(script not shared)\n--- see the run ---', {
    workflow: { runId: 'wf_7f3a', agentIndex: 2 },
    background: false,
  })

  expect(await $.agent.spawn(withheld as any)).toEqual(STARTED)
  expect(await $.agent.spawn(other as any)).toEqual(STARTED)

  expect(seen.runs).toHaveLength(0)
  expect(seen.spawns).toEqual([withheld, other])

  // The same hook denies an Agent tool spawn next, so it was loaded and passing the others above.
  expect(await $.agent.spawn(relay(BAD))).toEqual({ deny: REFUSAL })
  expect(seen.spawns).toHaveLength(2)
})

test('a Workflow agent with a --- line and a bad header is denied', async ($, on) => {
  const seen = spawnEngine(on, () => ran(1, `error: ${REFUSAL}\n`))
  // The dashes may carry trailing spaces or tabs, as the header parser reads them.
  const padded = BAD.replace('\n---\n', '\n--- \t\n')
  const workflow = (agentIndex: number) => ({ workflow: { runId: 'wf_7f3a', agentIndex }, background: false })

  expect(await $.agent.spawn(relay(BAD, workflow(1)) as any)).toEqual({ deny: REFUSAL })
  expect(await $.agent.spawn(relay(padded, workflow(2)) as any)).toEqual({ deny: REFUSAL })

  expect(seen.runs).toEqual([
    { argv: checkArgv, init: { stdin: BAD, timeoutMs: 10000 } },
    { argv: checkArgv, init: { stdin: padded, timeoutMs: 10000 } },
  ])
  expect(seen.spawns).toHaveLength(0)
})

test('an Agent tool spawn with no --- line still runs the check', async ($, on) => {
  const NO_HEADER = 'The prompt has no header: expected `key: value` lines, then a line `---`, then the brief.'
  const seen = spawnEngine(on, () => ran(1, `error: ${NO_HEADER}\n`))

  expect(await $.agent.spawn(relay(WITHHELD))).toEqual({ deny: NO_HEADER })
  expect(await $.agent.spawn(relay('Fix the flaky test.'))).toEqual({ deny: NO_HEADER })

  expect(seen.runs).toEqual([
    { argv: checkArgv, init: { stdin: WITHHELD, timeoutMs: 10000 } },
    { argv: checkArgv, init: { stdin: 'Fix the flaky test.', timeoutMs: 10000 } },
  ])
  expect(seen.spawns).toHaveLength(0)
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

// The four commands the module answers itself. A test raises each as a person's command through
// the engine's `$.command.run`; nothing beneath answers a command, so every text below is the
// module's, and each test proves the hook ran by the argv it ran or by the session it read.

const CWD = '/work/repo'
const SESSION = 'b982d28e-9bd5-4091-ae88-c3c557b54f01'
const FENCE = '```'

type CommandOptions = {
  cwd?: () => unknown
  id?: () => unknown
  grace?: () => string | undefined
  run?: (e: any, clock: { now: number }) => unknown
}

// The engine beneath the plugin for a command: the session's directory and id, the environment,
// a clock and a process runner that answers the companion's output, each recording what reached
// it. The clock moves only when a test's runner moves it, as a child that runs that long would.
function companion(on: any, options: CommandOptions = {}) {
  const runs: any[] = []
  const reads: string[] = []
  const clock = { now: 1_000_000 }
  on('session.cwd', () => {
    reads.push('cwd')
    return options.cwd ? options.cwd() : { value: CWD }
  })
  on('session.id', () => {
    reads.push('id')
    return options.id ? options.id() : { value: SESSION }
  })
  on('env.get', (_: unknown, e: any) => {
    reads.push('env ' + e.name)
    return { value: e.name === 'RELAY_JOBS_CANCEL_GRACE_MS' && options.grace ? options.grace() : undefined }
  })
  on('clock.now', () => ({ value: clock.now }))
  on('process.run', (_: unknown, e: any) => {
    runs.push(e)
    return options.run ? options.run(e, clock) : { value: printed('state: completed\n') }
  })
  return { runs, reads }
}

const printed = (stdout: string, stderr = '', exitCode: unknown = 0) => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const command = (name: string, args = '') => ({
  command: name,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
})

const companionArgv = (sub: string, ...args: string[]) => [
  'node',
  expect.stringMatching(/^\/.*\/scripts\/companion\.mjs$/),
  sub,
  ...args,
]

// The `<shell>` of the error texts, the plugin's folder left open.
const shell = (sub: string) => new RegExp("Run `node '/[^']*/scripts/companion\\.mjs' " + sub + '` in a shell')

const GRACE = 'env RELAY_JOBS_CANCEL_GRACE_MS'

test('each command runs the companion by argv with its cwd and timeout, and transfer with the session id', async ($, on) => {
  const seen = companion(on)

  await $.command.run(command('relay:status'))
  await $.command.run(command('relay:result'))
  await $.command.run(command('relay:cancel'))
  await $.command.run(command('relay:transfer'))

  expect(seen.runs).toEqual([
    { argv: companionArgv('status'), init: { cwd: CWD, timeoutMs: 30000 } },
    { argv: companionArgv('result'), init: { cwd: CWD, timeoutMs: 30000 } },
    // The grace unset: twice the companion's 10 s, and 40 s more.
    { argv: companionArgv('cancel'), init: { cwd: CWD, timeoutMs: 60000 } },
    {
      argv: companionArgv('transfer'),
      init: { cwd: CWD, timeoutMs: 180000, env: { RELAY_COMPANION_SESSION_ID: SESSION } },
    },
  ])
  // Only cancel reads the grace, and only transfer the session's id.
  expect(seen.reads).toEqual(['cwd', 'cwd', GRACE, 'cwd', 'cwd', 'id'])
})

test('the arguments go as one element, exactly as typed, and none when blank', async ($, on) => {
  const seen = companion(on)

  await $.command.run(command('relay:status', 'job-1 --all'))
  await $.command.run(command('relay:result', '  job-2 '))
  await $.command.run(command('relay:cancel', '   '))
  await $.command.run(command('relay:transfer', '--source "/tmp/a b.jsonl"'))
  await $.command.run(command('relay:status', ''))

  expect(seen.runs.map((r) => r.argv)).toEqual([
    companionArgv('status', 'job-1 --all'),
    companionArgv('result', '  job-2 '),
    companionArgv('cancel'),
    companionArgv('transfer', '--source "/tmp/a b.jsonl"'),
    companionArgv('status'),
  ])
})

test("cancel's timeout follows the grace the companion reads, up to ten minutes", async ($, on) => {
  const graces: (string | undefined)[] = [undefined, '30000', 'soon', '-5', '1e9', '0', '', '  ']
  let next = 0
  const seen = companion(on, { grace: () => graces[next++] })

  for (let i = 0; i < graces.length; i++) {
    await $.command.run(command('relay:cancel', 'j-1'))
  }

  expect(next).toBe(graces.length)
  // Unset, a number, garbage, a negative number, a huge one, an explicit zero, empty and blank (unset).
  expect(seen.runs.map((r) => r.init.timeoutMs)).toEqual([60000, 100000, 60000, 60000, 600000, 40000, 60000, 60000])
  expect(seen.reads.filter((read) => read === GRACE)).toHaveLength(graces.length)
})

test('the first line is the command as typed, on one line, before the code block', async ($, on) => {
  const seen = companion(on)

  const bare: any = await $.command.run(command('relay:status'))
  const typed: any = await $.command.run(command('relay:result', 'job-x'))
  const blank: any = await $.command.run(command('relay:cancel', ' \t '))
  const folded: any = await $.command.run(command('relay:status', '  job-y\n  --all\t\t '))

  const block = FENCE + 'text\nstate: completed\n' + FENCE + '\n'
  expect(bare.text).toBe('/relay:status\n' + block)
  expect(typed.text).toBe('/relay:result job-x\n' + block)
  expect(blank.text).toBe('/relay:cancel\n' + block)
  expect(folded.text).toBe('/relay:status job-y --all\n' + block)
  // The companion still gets the arguments as typed.
  expect(seen.runs.map((r) => r.argv)).toEqual([
    companionArgv('status'),
    companionArgv('result', 'job-x'),
    companionArgv('cancel'),
    companionArgv('status', '  job-y\n  --all\t\t '),
  ])
})

test('a state block shows verbatim in a code block and the report after it as Markdown', async ($, on) => {
  const seen = companion(on, { run: () => ({ value: printed('state: completed\njob: j-1\n---\n# Done\n') }) })

  const result = await $.command.run(command('relay:result', 'j-1'))

  expect(seen.runs.map((r) => r.argv)).toEqual([companionArgv('result', 'j-1')])
  expect(result).toEqual({ text: '/relay:result j-1\n```text\nstate: completed\njob: j-1\n```\n---\n# Done\n', exitCode: 0 })
})

test('only the first --- line splits; a later one stays in the report', async ($, on) => {
  companion(on, { run: () => ({ value: printed('state: completed\n---\n# Report\n\n---\n\nmore\n') }) })

  const result = await $.command.run(command('relay:result'))

  expect(result).toEqual({ text: '/relay:result\n```text\nstate: completed\n```\n---\n# Report\n\n---\n\nmore\n', exitCode: 0 })
})

test('a status listing shows its header lines in the code block and its table after it, as printed', async ($, on) => {
  const header = 'jobs-home: /h\nrepo: /r\nfast-tier: off\njobs: 2\n'
  const table = '| job | state | summary |\n|-----|-------|---------|\n| j-1 | done  | a \\| b  |\n| j-2 | done  | `x`     |\n'
  const seen = companion(on, { run: () => ({ value: printed(header + '\n' + table) }) })

  const result = await $.command.run(command('relay:status', '--all'))

  expect(seen.runs.map((r) => r.argv)).toEqual([companionArgv('status', '--all')])
  // The blank line before the table is dropped; the table's escapes and backticks stay as printed
  // and do not lengthen the fence.
  expect(result).toEqual({ text: '/relay:status --all\n```text\n' + header + '```\n' + table, exitCode: 0 })
})

test('a listing with no table or --- line is all verbatim, and a missing final newline is added', async ($, on) => {
  const outputs = ['No jobs.\n', 'state: running\njob: j-1', 'jobs: 0\n\n\n']
  let next = 0
  companion(on, { run: () => ({ value: printed(outputs[next++]) }) })

  const results: any[] = []
  for (let i = 0; i < outputs.length; i++) {
    results.push(await $.command.run(command('relay:status')))
  }

  expect(results.map((r) => r.text)).toEqual([
    '/relay:status\n```text\nNo jobs.\n```\n',
    '/relay:status\n```text\nstate: running\njob: j-1\n```\n',
    '/relay:status\n```text\njobs: 0\n```\n',
  ])
})

test('only the first --- or | line splits: a table in a report, a --- line after a table', async ($, on) => {
  const outputs = [
    'state: completed\n---\n# Report\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
    'jobs: 1\n\n| a |\n|---|\n| 1 |\n---\nafter\n',
  ]
  let next = 0
  companion(on, { run: () => ({ value: printed(outputs[next++]) }) })

  const report = await $.command.run(command('relay:result', 'j-1'))
  const listing = await $.command.run(command('relay:status'))

  expect(report).toEqual({
    text: '/relay:result j-1\n```text\nstate: completed\n```\n---\n# Report\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
    exitCode: 0,
  })
  expect(listing).toEqual({ text: '/relay:status\n```text\njobs: 1\n```\n| a |\n|---|\n| 1 |\n---\nafter\n', exitCode: 0 })
})

test('stderr alone shows verbatim with the exit code, as a busy job does', async ($, on) => {
  const seen = companion(on, { run: () => ({ value: printed('', 'Job j-1 is busy: a turn is running. Try again.\n', 4) }) })

  const result = await $.command.run(command('relay:result', 'j-1'))

  expect(seen.runs).toHaveLength(1)
  expect(result).toEqual({ text: '/relay:result j-1\n```text\nJob j-1 is busy: a turn is running. Try again.\n```\n', exitCode: 4 })
})

test('stdout and stderr show together, stderr on a line of its own', async ($, on) => {
  companion(on, { run: () => ({ value: printed('state: failed', 'warning: stale lock\n', 1) }) })

  const result = await $.command.run(command('relay:cancel', 'j-1'))

  expect(result).toEqual({ text: '/relay:cancel j-1\n```text\nstate: failed\nwarning: stale lock\n```\n', exitCode: 1 })
})

test('a backtick run in the verbatim part gets a longer fence', async ($, on) => {
  companion(on, {
    run: () => ({ value: printed('summary: use ``` fences\n---\nreport with ````` five\n') }),
  })

  const result = await $.command.run(command('relay:result'))

  // The report is not fenced, so only the verbatim part's run counts.
  expect(result).toEqual({ text: '/relay:result\n````text\nsummary: use ``` fences\n````\n---\nreport with ````` five\n', exitCode: 0 })
})

// Greptile: a spread of every run into Math.max overflowed the call stack on a large output.
test('an output with very many backtick runs is shown, not refused', async ($, on) => {
  const many = '`a'.repeat(200000) + '\n'
  companion(on, { run: () => ({ value: printed(many) }) })

  const result = await $.command.run(command('relay:status', '--json'))

  expect(result).toEqual({ text: '/relay:status --json\n```text\n' + many + '```\n', exitCode: 0 })
})

test('the exit code passes through when it is a whole number from 0 to 255, and is left out otherwise', async ($, on) => {
  const codes: unknown[] = [0, 3, 4, 5, 256, -1, 2.5]
  let next = 0
  companion(on, { run: () => ({ value: printed('state: x\n', '', codes[next++]) }) })

  const results = []
  for (let i = 0; i < codes.length; i++) {
    results.push(await $.command.run(command('relay:result')))
  }

  expect(next).toBe(codes.length)
  const text = '/relay:result\n```text\nstate: x\n```\n'
  expect(results).toEqual([
    { text, exitCode: 0 },
    { text, exitCode: 3 },
    { text, exitCode: 4 },
    { text, exitCode: 5 },
    { text },
    { text },
    { text },
  ])
})

test('a run with no exit code shows none of its output', async ($, on) => {
  const seen = companion(on, { run: () => ({ value: printed('No jobs.\n', '', null) }) })

  const result: any = await $.command.run(command('relay:status', '--all'))

  expect(seen.runs.map((r) => r.argv)).toEqual([companionArgv('status', '--all')])
  expect(result).toEqual({
    text: "/relay:status --all\n\nEnded without an exit code. Run `node '" + seen.runs[0].argv[1] + "' status '--all'` in a shell to see its output.",
    exitCode: 1,
  })
})

test('a truncated stream shows none of the output and names the stream', async ($, on) => {
  const flags = [
    [true, false],
    [false, true],
    [true, true],
  ]
  let next = 0
  const seen = companion(on, {
    run: () => {
      const [out, err] = flags[next++]
      return { value: { ...printed('No jobs.\n', 'partial\n'), isStdoutTruncated: out, isStderrTruncated: err } }
    },
  })

  const results: any[] = []
  for (let i = 0; i < flags.length; i++) {
    results.push(await $.command.run(command('relay:status')))
  }

  expect(seen.runs).toHaveLength(3)
  const streams = ['stdout', 'stderr', 'stdout and stderr']
  results.forEach((result, i) => {
    expect(result.exitCode).toBe(1)
    expect(result.text).toBe(
      '/relay:status\n\nPrinted more than 4 MiB on ' + streams[i] + ", more than Claude Code passes to a plugin, so none of it is shown. Run `node '" + seen.runs[i].argv[1] + "' status` in a shell to read it.",
    )
    expect(result.text).not.toContain('No jobs')
    expect(result.text).not.toContain('partial')
  })
})

test('a run that printed nothing says so with its exit code', async ($, on) => {
  const seen = companion(on, { run: () => ({ value: printed('', '', 0) }) })

  const result: any = await $.command.run(command('relay:status'))

  expect(seen.runs).toHaveLength(1)
  expect(result.exitCode).toBe(1)
  expect(result.text).toMatch(/^\/relay:status\n\nPrinted nothing \(exit 0\)\. /)
  expect(result.text).toMatch(shell('status'))
})

test('a run that does not finish answers an error text; only a cancel cut off by its timeout says it may have gone through', async ($, on) => {
  let starts = true
  const seen = companion(on, {
    run: (e, clock) => {
      if (!starts) {
        return { deny: 'spawn node ENOENT' }
      }
      // The child runs until the engine kills it at its timeout.
      clock.now += e.init.timeoutMs
      return { deny: 'timed out after ' + e.init.timeoutMs + ' ms' }
    },
  })

  const status: any = await $.command.run(command('relay:status'))
  const cancel: any = await $.command.run(command('relay:cancel', 'j-1'))
  starts = false
  const unstarted: any = await $.command.run(command('relay:cancel', 'j-2'))

  expect(seen.runs.map((r) => r.argv)).toEqual([companionArgv('status'), companionArgv('cancel', 'j-1'), companionArgv('cancel', 'j-2')])
  expect(status.exitCode).toBe(1)
  expect(status.text).toMatch(/^\/relay:status\n\nDid not finish: .*timed out after 30000 ms.*\. Run `node '[^']*' status` in a shell to see its output\.$/)
  expect(cancel.exitCode).toBe(1)
  expect(cancel.text).toMatch(
    /^\/relay:cancel j-1\n\nDid not finish: .*timed out after 60000 ms.*\. Run `node '[^']*' cancel 'j-1'` in a shell to see its output\. The cancel may have gone through anyway; \/relay:status shows the job's state\.$/,
  )
  // A process that could not start cancelled nothing.
  expect(unstarted.exitCode).toBe(1)
  expect(unstarted.text).toMatch(/^\/relay:cancel j-2\n\nDid not finish: .*spawn node ENOENT.*\. Run `node '[^']*' cancel 'j-2'` in a shell to see its output\.$/)
})

test('the shell line quotes the plugin path and the typed text as one word each, so nothing typed runs', async ($, on) => {
  const seen = companion(on, { run: () => ({ value: printed('', '', 0) }) })
  const typed = `j-1 $(touch x) --source "/tmp/it's here.jsonl"`
  const ticked = 'j-2 `touch y`'

  const quoted: any = await $.command.run(command('relay:transfer', typed))
  const fenced: any = await $.command.run(command('relay:result', ticked))
  const blank: any = await $.command.run(command('relay:status', ' \t '))

  expect(seen.runs.map((r) => r.argv)).toEqual([companionArgv('transfer', typed), companionArgv('result', ticked), companionArgv('status')])
  const root = seen.runs[0].argv[1]
  expect(quoted.text).toBe(
    `/relay:transfer ${typed}\n\nPrinted nothing (exit 0). Run \`node '${root}' transfer 'j-1 $(touch x) --source "/tmp/it'\\''s here.jsonl"'\` in a shell to see its output.`,
  )
  // A backtick in the line takes a longer fence, so the code span shows the line whole.
  expect(fenced.text).toBe(`/relay:result ${ticked}\n\nPrinted nothing (exit 0). Run \`\`node '${root}' result 'j-2 \`touch y\`'\`\` in a shell to see its output.`)
  // Blank text is no word at all.
  expect(blank.text).toBe(`/relay:status\n\nPrinted nothing (exit 0). Run \`node '${root}' status\` in a shell to see its output.`)
})

test('a session directory or id that cannot be read answers an error text and runs nothing', async ($, on) => {
  let failing = 'cwd'
  const seen = companion(on, {
    cwd: () => (failing === 'cwd' ? { deny: 'no session directory' } : { value: CWD }),
    id: () => (failing === 'id' ? { deny: 'no session id' } : { value: SESSION }),
  })

  const cancel: any = await $.command.run(command('relay:cancel', 'j-1'))
  failing = 'id'
  const transfer: any = await $.command.run(command('relay:transfer'))

  expect(seen.reads).toEqual([GRACE, 'cwd', 'cwd', 'id'])
  expect(seen.runs).toHaveLength(0)
  expect(cancel.exitCode).toBe(1)
  // The cancel never started, so the text does not say it may have gone through.
  expect(cancel.text).toMatch(/^\/relay:cancel j-1\n\nDid not finish: .*no session directory.*\. Run `node '[^']*' cancel 'j-1'` in a shell to see its output\.$/)
  expect(transfer.exitCode).toBe(1)
  expect(transfer.text).toMatch(/^\/relay:transfer\n\nDid not finish: .*no session id.*\. Run `node '[^']*' transfer` in a shell to see its output\.$/)
})

test('a hook that fails is answered by its .catch, never by the markdown command', async ($, on) => {
  // A run that answers no result makes the hook throw outside its own error handling.
  const seen = companion(on, { run: () => ({ value: null }) })

  const result: any = await $.command.run(command('relay:result', 'j-1'))

  expect(seen.runs.map((r) => r.argv)).toEqual([companionArgv('result', 'j-1')])
  expect(result.exitCode).toBe(1)
  expect(result.text).toMatch(/^\/relay:result j-1\n\nThe relay module failed while answering it: .+\. Run `node '[^']*' result 'j-1'` in a shell to see its output\.$/)
})

// The status line. Its timer starts at session.start on the kit's mocked clock, so a test raises
// session.start and moves the clock; nothing beneath answers the session's surfaces, the listing
// or the line, so each test answers them, and every line below is one the module set.

const STATUS_ARGV = [
  'node',
  expect.stringMatching(/^\/.*\/scripts\/companion\.mjs$/),
  'status',
  '--json',
  '--active',
  '--limit',
  '200',
]

type StatusOptions = {
  surfaces?: () => string[] | Promise<string[]>
  run?: () => unknown
  start?: { surface: string | null; isInteractive: boolean }
}

// The engine beneath the plugin for the status line: the session's start, directory and
// surfaces, a process runner answering the listing, and the line, each recording what reached it.
async function statusEngine($: any, on: any, options: StatusOptions = {}) {
  const runs: any[] = []
  const lines: (string | undefined)[] = []
  let surfaceReads = 0
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.surfaces', () => {
    surfaceReads++
    const answer = options.surfaces ? options.surfaces() : ['terminal']
    return answer instanceof Promise ? answer.then((value) => ({ value })) : { value: answer }
  })
  on('process.run', (_: unknown, e: any) => {
    runs.push(e)
    return options.run ? options.run() : { value: listing([]) }
  })
  on('ui.status', (_: unknown, e: any) => {
    lines.push(e.text)
    return { value: undefined }
  })
  // The board's part of session.start, and its closed pane, whose ticks read no surface.
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: CWD, ...(options.start ?? { surface: 'terminal', isInteractive: true }) })
  return { runs, lines, clock, surfaceReads: () => surfaceReads }
}

// A listing as `companion status --json --active` prints it, cut to the fields the line reads.
const listing = (jobs: object[], nextCursor: string | null = null) =>
  printed(JSON.stringify({ schema: 'relay.status/1', relayVersion: '3.0.0', relayBuild: null, active: true, limit: 200, jobs, nextCursor }))

const job = (id: string, state: string, undeliveredCount = 0) => ({ id, state, undeliveredCount })

const failed = (kind: string, exitCode: number) =>
  printed(JSON.stringify({ schema: 'relay.status/1', relayVersion: '3.0.0', relayBuild: null, error: { kind, message: kind } }), '', exitCode)

test('with no surface, ticks run no process', async ($, on) => {
  let surfaces: string[] = []
  const seen = await statusEngine($, on, { surfaces: () => surfaces })

  await seen.clock.advance(15000)

  expect(seen.surfaceReads()).toBe(3)
  expect(seen.runs).toHaveLength(0)
  expect(seen.lines).toEqual([])

  // The same timer reads once a surface draws, so it was running above.
  surfaces = ['terminal']
  await seen.clock.advance(5000)
  expect(seen.runs).toHaveLength(1)
})

test('a tick runs the active listing by argv in the session directory, every five seconds', async ($, on) => {
  // A count shows, so every tick reads.
  const seen = await statusEngine($, on, { run: () => ({ value: listing([job('j-1', 'running')]) }) })

  await seen.clock.advance(4999)
  expect(seen.runs).toHaveLength(0)
  await seen.clock.advance(1)
  await seen.clock.advance(5000)

  expect(seen.runs).toEqual([
    { argv: STATUS_ARGV, init: { cwd: CWD, timeoutMs: 10000 } },
    { argv: STATUS_ARGV, init: { cwd: CWD, timeoutMs: 10000 } },
  ])
})

test('a second session.start starts no second timer', async ($, on) => {
  const seen = await statusEngine($, on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  await seen.clock.advance(5000)

  expect(seen.runs).toHaveLength(1)
})

test('the line counts running, dead and owed jobs, leaves out a part at 0, and clears with none', async ($, on) => {
  const answers = [
    listing([job('j-2', 'running'), job('j-1', 'starting')]),
    listing([
      job('j-4', 'running'),
      job('j-3', 'starting'),
      job('j-2', 'dead', 1),
      // A row's owed list is cut to a few ids; its count is not.
      { ...job('j-1', 'completed', 22), undelivered: Array.from({ length: 20 }, (_, i) => 'm-' + i) },
    ]),
    listing([job('j-1', 'dead')]),
    listing([job('j-1', 'cancelled', 2)]),
    listing([]),
  ]
  let next = 0
  const seen = await statusEngine($, on, { run: () => ({ value: answers[next++] }) })

  for (let i = 0; i < answers.length; i++) {
    await seen.clock.advance(5000)
  }

  expect(seen.lines).toEqual(['2 running', '2 running · 1 dead · 23 owed', '1 dead', '2 owed', undefined])
})

test('with more pages, every count carries a +, a page with no running job included', async ($, on) => {
  const pages = [
    listing([job('j-3', 'running'), job('j-2', 'running'), job('j-1', 'dead', 2)], 'WyJ4IiwiaiJd'),
    // Newest first: a full page of dead jobs can hide an older running one on the next page.
    listing([job('j-2', 'dead'), job('j-1', 'dead')], 'WyJ5IiwiaiJd'),
  ]
  let next = 0
  const seen = await statusEngine($, on, { run: () => ({ value: pages[next++] }) })

  await seen.clock.advance(10000)

  expect(seen.lines).toEqual(['2+ running · 1+ dead · 2+ owed', '2+ dead'])
})

test('a busy listing keeps the line, and the next good answer replaces it', async ($, on) => {
  const answers = [listing([job('j-1', 'running')]), failed('busy', 4), listing([job('j-1', 'dead')])]
  let next = 0
  const seen = await statusEngine($, on, { run: () => ({ value: answers[next++] }) })

  await seen.clock.advance(15000)

  expect(seen.runs).toHaveLength(3)
  expect(seen.lines).toEqual(['1 running', '1 dead'])
})

test('every other failure shows the status as unavailable until a good answer', async ($, on) => {
  const answers: Array<() => unknown> = [
    // Still running at the timeout, and a child that never started: $.process.run rejects.
    () => ({ deny: 'timed out after 10000 ms' }),
    () => ({ deny: 'spawn node ENOENT' }),
    () => ({ value: { ...listing([job('j-1', 'running')]), isStdoutTruncated: true } }),
    () => ({ value: printed('{"schema":"relay.status/1","jobs":[') }),
    () => ({ value: printed(JSON.stringify({ schema: 'relay.result/1', jobs: [] })) }),
    () => ({ value: failed('error', 1) }),
    () => ({ value: failed('usage', 1) }),
    // Busy only with busy's exit code.
    () => ({ value: failed('busy', 1) }),
    () => ({ value: { ...listing([job('j-1', 'running')]), exitCode: 1 } }),
    () => ({ value: listing([job('j-1', 'running')]) }),
  ]
  let next = 0
  const seen = await statusEngine($, on, { run: () => answers[next++]() })

  for (let i = 0; i < answers.length; i++) {
    await seen.clock.advance(5000)
  }

  expect(seen.runs).toHaveLength(answers.length)
  expect(seen.lines).toEqual([...Array(answers.length - 1).fill('status unavailable'), '1 running'])
})

test('a tick while a read is in flight runs nothing', async ($, on) => {
  let answer: (value: unknown) => void = () => {}
  let held = true
  const seen = await statusEngine($, on, {
    run: () => (held ? new Promise((resolve) => (answer = resolve)) : { value: listing([job('j-1', 'dead')]) }),
  })

  await seen.clock.advance(5000)
  await seen.clock.advance(10000)
  expect(seen.surfaceReads()).toBe(3)
  expect(seen.runs).toHaveLength(1)
  expect(seen.lines).toEqual([])

  held = false
  answer({ value: listing([job('j-1', 'running')]) })
  await seen.clock.settle()
  expect(seen.lines).toEqual(['1 running'])

  await seen.clock.advance(5000)
  expect(seen.runs).toHaveLength(2)
  expect(seen.lines).toEqual(['1 running', '1 dead'])
})

test('ticks whose surface reads are slow still run one read at a time', async ($, on) => {
  const surfaces: ((value: string[]) => void)[] = []
  const runs: ((value: unknown) => void)[] = []
  const seen = await statusEngine($, on, {
    surfaces: () => new Promise<string[]>((resolve) => surfaces.push(resolve)),
    run: () => new Promise((resolve) => runs.push(resolve)),
  })

  await seen.clock.advance(10000)
  expect(surfaces).toHaveLength(2)
  // Both surface reads answer while neither tick has read yet: only the first may run the listing.
  for (const answer of surfaces) answer(['terminal'])
  await seen.clock.settle()
  expect(seen.runs).toHaveLength(1)

  runs[0]({ value: listing([job('j-1', 'running')]) })
  await seen.clock.settle()
  expect(seen.lines).toEqual(['1 running'])
})

test('a desktop session that starts with no surface reads once the desktop attaches', async ($, on) => {
  let surfaces: string[] = []
  // The desktop app's local session starts as the SDK's does, drawing nowhere yet.
  const seen = await statusEngine($, on, {
    surfaces: () => surfaces,
    run: () => ({ value: listing([job('j-1', 'running')]) }),
    start: { surface: null, isInteractive: false },
  })

  await seen.clock.advance(10000)
  expect(seen.runs).toHaveLength(0)
  expect(seen.lines).toEqual([])

  surfaces = ['desktop']
  await seen.clock.advance(5000)
  expect(seen.runs).toEqual([{ argv: STATUS_ARGV, init: { cwd: CWD, timeoutMs: 10000 } }])
  expect(seen.lines).toEqual(['1 running'])
})

// The listing's runs among every run a test's hooks made (a check, a wake, a command's own run).
const listings = (runs: any[]) => runs.filter((r) => r.argv.includes('--active'))

test('while the line is cleared a tick reads every thirty seconds, and every five while a count shows', async ($, on) => {
  const answers = [
    listing([]),
    listing([job('j-1', 'running')]),
    listing([job('j-1', 'running')]),
    listing([]),
    // Unavailable is no good answer, so it reads at every tick as a count does.
    failed('error', 1),
    listing([]),
    // A busy answer keeps the line, cleared here, and reads at the next tick: a record was changing.
    failed('busy', 4),
    listing([]),
  ]
  let next = 0
  const seen = await statusEngine($, on, { run: () => ({ value: answers[next++] }) })

  // The first tick reads, and the line clears.
  await seen.clock.advance(5000)
  expect(seen.runs).toHaveLength(1)
  // The next read is due thirty seconds after it, at the sixth tick.
  await seen.clock.advance(25000)
  expect(seen.runs).toHaveLength(1)
  expect(seen.surfaceReads()).toBe(6)
  await seen.clock.advance(5000)
  expect(seen.runs).toHaveLength(2)
  // A count shows: every tick reads until the line clears again.
  await seen.clock.advance(10000)
  expect(seen.runs).toHaveLength(4)
  expect(seen.lines).toEqual([undefined, '1 running', '1 running', undefined])
  await seen.clock.advance(25000)
  expect(seen.runs).toHaveLength(4)
  await seen.clock.advance(5000)
  expect(seen.runs).toHaveLength(5)
  await seen.clock.advance(5000)
  expect(seen.runs).toHaveLength(6)
  expect(seen.lines.slice(4)).toEqual(['status unavailable', undefined])
  await seen.clock.advance(30000)
  expect(seen.runs).toHaveLength(7)
  await seen.clock.advance(5000)
  expect(seen.runs).toHaveLength(8)
  expect(seen.lines).toEqual([undefined, '1 running', '1 running', undefined, 'status unavailable', undefined, undefined])
})

// Each relay event the module sees makes every tick read for thirty seconds while the line is cleared.
async function quietLine($: any, on: any, extra: (on: any) => void = () => {}) {
  const runs: any[] = []
  on('agent.list', () => ({ value: AGENTS }))
  on('session.send', () => ({ isDelivered: true }))
  on('agent.spawn', () => STARTED)
  extra(on)
  const seen = await statusEngine($, on, {
    run: () => ({ value: listing([]) }),
  })
  await seen.clock.advance(5000)
  expect(listings(seen.runs)).toHaveLength(1)
  // Cleared, so the next tick does not read.
  await seen.clock.advance(5000)
  expect(listings(seen.runs)).toHaveLength(1)
  return seen
}

// After the event, a read at each of the next six ticks (thirty seconds), and none at the tick after.
async function readsForThirty(seen: any) {
  const before = listings(seen.runs).length
  for (let tick = 1; tick <= 6; tick++) {
    await seen.clock.advance(5000)
    expect(listings(seen.runs)).toHaveLength(before + tick)
  }
  await seen.clock.advance(5000)
  expect(listings(seen.runs)).toHaveLength(before + 6)
}

test('a relay:job spawn makes every tick read for thirty seconds while the line is cleared', async ($, on) => {
  const seen = await quietLine($, on)

  // Another agent type is no relay event.
  expect(await $.agent.spawn({ prompt: 'look', subagentType: 'Explore', description: 'look around' })).toEqual(STARTED)
  await seen.clock.advance(5000)
  expect(listings(seen.runs)).toHaveLength(1)

  expect(await $.agent.spawn(relay(GOOD))).toEqual(STARTED)
  await readsForThirty(seen)
  // A resumed relay can resume a job, and is an event too.
  expect(await $.agent.spawn(relay('Go on.', { resume: { agentId: 'a-job' } }) as any)).toEqual(STARTED)
  await readsForThirty(seen)
})

test('a send that wakes a relay makes every tick read for thirty seconds while the line is cleared', async ($, on) => {
  const seen = await quietLine($, on)

  // A listed agent of another type gets no wake, and is no relay event.
  expect(await $.session.send({ to: 'lead', text: 'hello', origin: { kind: 'model' } })).toEqual({ isDelivered: true })
  await seen.clock.advance(5000)
  expect(listings(seen.runs)).toHaveLength(1)

  expect(await $.session.send({ to: 'worker', text: 'steer', origin: { kind: 'model' } })).toEqual({ isDelivered: true })
  expect(seen.runs.filter((r) => r.argv.includes('wake'))).toHaveLength(1)
  await readsForThirty(seen)
})

test('each of the relay commands makes every tick read for thirty seconds while the line is cleared', async ($, on) => {
  const seen = await quietLine($, on, (on) => {
    on('env.get', () => ({ value: undefined }))
    on('session.id', () => ({ value: SESSION }))
  })

  for (const name of ['relay:status', 'relay:result', 'relay:cancel', 'relay:transfer']) {
    await $.command.run(command(name, 'j-1'))
    await readsForThirty(seen)
  }
  // The commands' own runs are not listing reads.
  expect(seen.runs.filter((r) => !r.argv.includes('--active'))).toHaveLength(4)
})

// The board. Each test runs once per surface that draws it, so each surface starts from a fresh
// session. The engine beneath answers the session, the pane's open, close and record, the
// listing, a job's read at a press, its view, the agent list and every send; nothing beneath
// draws, so every element is the module's.

const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.parse('2026-10-22T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60000).toISOString()

const BOARD = {
  plugin: 'relay',
  component: 'Pane',
  requestId: 'relay-board',
  props: {
    title: 'Relay jobs',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const PANE = { id: 'relay-board', title: 'Relay jobs', isShown: true, isFocused: true, isPlaced: true }

// A listing's row, cut to the fields the board reads and `updatedAt`, which the worker's heartbeat
// rewrites; by default a running Codex job of this session whose Agent tool relay called a minute ago.
const row = (id: string, patch: Record<string, unknown> = {}): any => ({
  id,
  state: 'running',
  backend: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'low',
  attempts: 1,
  updatedAt: ago(1),
  completedAt: null,
  claudeSessionId: SESSION,
  reportPath: null,
  relay: { agentId: 'a-' + id, workflowRunId: null, label: 'worker-' + id, phase: null, adopted: 0, lastToolAt: ago(1) },
  notHandedBack: false,
  undeliveredCount: 0,
  relayViolationCount: 0,
  openMessages: 0,
  ...patch,
})

const relayOf = (job: any, patch: Record<string, unknown>) => ({ ...job.relay, ...patch })

// A relay:job agent as `$.agent.list()` lists it.
const relayAgent = (id: string, status = 'running') => ({ id, name: 'worker', description: 'a job', type: 'relay:job', status })

const answer = (sub: string, body: object, exitCode = 0) =>
  printed(JSON.stringify({ schema: `relay.${sub}/1`, relayVersion: '3.0.0', relayBuild: null, ...body }), '', exitCode)

type BoardOptions = {
  jobs?: () => any[]
  nextCursor?: string | null
  // The listing's answer.
  status?: () => unknown
  // The job's read at a press, `status <job> --json`.
  view?: (id: string) => unknown
  result?: (id: string) => unknown
  // The companion's answer to a steer, continue or cancel.
  act?: (e: any) => unknown
  sent?: () => unknown
  // By default every job's relay, running.
  agents?: () => unknown[]
  id?: () => string
  surfaces?: () => string[]
  panes?: () => unknown
  opened?: () => unknown
  env?: Record<string, string>
}

// The engine beneath the plugin for the board, each part recording what reached it.
async function boardEngine($: any, on: any, options: BoardOptions = {}) {
  const runs: any[] = []
  const sends: any[] = []
  const registers: string[] = []
  const listWrites: unknown[] = []
  let paneReads = 0
  let isOpen = false
  const jobs = () => (options.jobs ? options.jobs() : [])
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: options.id ? options.id() : SESSION }))
  on('session.surfaces', () => ({ value: options.surfaces ? options.surfaces() : ['terminal'] }))
  on('command.register', (_: unknown, e: any) => {
    registers.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => {
    isOpen = true
    return { value: options.opened ? options.opened() : { isPlaced: true } }
  })
  on('ui.close', () => {
    isOpen = false
    return { value: undefined }
  })
  on('ui.panes', () => {
    paneReads++
    const panes = options.panes ? options.panes() : isOpen ? [PANE] : []
    return panes instanceof Promise ? panes.then((value) => ({ value })) : { value: panes }
  })
  on('agent.list', () => ({
    value: options.agents ? options.agents() : jobs().filter((job) => job.relay?.agentId).map((job) => relayAgent(job.relay.agentId)),
  }))
  on('state.set', (_: unknown, e: any, next: any) => {
    if (e.key === 'boardList') {
      listWrites.push(e.value)
    }
    return next(e)
  })
  on('process.run', (_: unknown, e: any) => {
    // The status line's own read, every five seconds.
    if (e.argv.includes('--active')) {
      return { value: listing([]) }
    }
    runs.push(e)
    const [sub, first] = e.argv.slice(2)
    if (sub === 'status' && first === '--json') {
      return options.status ? options.status() : { value: answer('status', { jobs: jobs(), nextCursor: options.nextCursor ?? null }) }
    }
    if (sub === 'status') {
      return options.view ? options.view(first) : { value: answer('status', { ...jobs().find((job) => job.id === first), messages: [] }) }
    }
    if (sub === 'result') {
      return options.result ? options.result(first) : { value: answer('result', { id: first, messages: [], report: '# Done\n' }) }
    }
    if (sub === 'wake') {
      return { value: RAN }
    }
    return options.act ? options.act(e) : { value: answer(sub, { job: first, outcome: { action: 'steered' }, state: 'running' }) }
  })
  on('session.send', (_: unknown, e: unknown) => {
    sends.push(e)
    return options.sent ? options.sent() : { isDelivered: true }
  })
  mock.env(on, options.env ?? {})
  const clock = mock.clock(on, { now: NOW })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const subs = () => runs.map((r) => r.argv[2])
  // The steers and continues the companion was asked for.
  const acts = () => runs.filter((r) => r.argv[2] === 'steer' || r.argv[2] === 'continue')
  return { runs, sends, registers, listWrites, clock, subs, acts, paneReads: () => paneReads }
}

// Opens the board as the person's command does, and mounts it on the surface.
async function openBoard($: any, surface: (typeof SURFACES)[number]) {
  const opened = await $.command.run(command('relay-board'))
  const ui = await $.ui.mount({ ...BOARD, surface })
  return { opened, ui }
}

const rowText = async (ui: any, id: string) => (await ui.find({ key: 'job:' + id }))?.text
const shows = async (ui: any, text: string | RegExp) => (await ui.find({ type: 'Text', text })) !== undefined
const viewArgv = (id: string) => companionArgv('status', id, '--json')

for (const surface of SURFACES) {
  test(`/relay-board opens the pane and lists the jobs, one row each with its flags (${surface})`, async ($, on) => {
    const seen = await boardEngine($, on, {
      jobs: () => [
        row('j-5', { backend: 'kimi', attempts: 0, state: 'starting' }),
        // Its relay last called 20 minutes ago: lost.
        row('j-4', { relay: { agentId: 'a-4', workflowRunId: null, label: 'w', lastToolAt: ago(20) } }),
        // A running job whose relay never called is lost too.
        row('j-3', { relay: { agentId: 'a-3', workflowRunId: null, label: 'w', lastToolAt: null }, relayViolationCount: 2 }),
        row('j-2', { state: 'dead', attempts: 2, undeliveredCount: 3, relayViolationCount: 1 }),
        row('j-1', { state: 'completed', notHandedBack: true }),
      ],
      nextCursor: 'WyJ4Il0',
    })

    const { opened, ui } = await openBoard($, surface)

    expect(opened).toMatchObject({ text: 'Opened the relay board.' })
    // The open read the listing at once, 20 a page, in the session's directory.
    expect(seen.runs).toEqual([{ argv: companionArgv('status', '--json', '--limit', '20'), init: { cwd: CWD, timeoutMs: 10000 } }])
    expect(await rowText(ui, 'j-5')).toBe('  j-5 · kimi · starting · attempt 1')
    expect(await rowText(ui, 'j-4')).toBe('  j-4 · codex · running · attempt 1 · relay lost')
    expect(await rowText(ui, 'j-3')).toBe('  j-3 · codex · running · attempt 1 · relay lost · 2 violations')
    expect(await rowText(ui, 'j-2')).toBe('  j-2 · codex · dead · attempt 2 · 3 owed · 1 violation')
    expect(await rowText(ui, 'j-1')).toBe('  j-1 · codex · completed · attempt 1 · not handed back')
    expect((await ui.findAll({ type: 'Button' })).map((b: any) => b.key)).toEqual(['job:j-5', 'job:j-4', 'job:j-3', 'job:j-2', 'job:j-1', 'more'])
    // The keys the pane takes land on the first row, not on nothing.
    const ring = async () => (await ui.findAll({ type: 'Button' })).filter((b: any) => b.props.autoFocus).map((b: any) => b.key)
    expect(await ring()).toEqual(['job:j-5'])
    // Once a row is selected the ring starts there.
    await ui.press({ key: 'job:j-2' })
    expect(await ring()).toEqual(['job:j-2'])

    // More reads a page more.
    await ui.press({ key: 'more' })
    expect(seen.runs.at(-1).argv).toEqual(companionArgv('status', '--json', '--limit', '40'))
    await ui.unmount()
  })

  test(`selecting a row reads the job and draws its model, relay, messages with their routes, and report (${surface})`, async ($, on) => {
    const workflow = row('j-1', { relay: { agentId: 'wf-agent', workflowRunId: 'wf_7f3a', label: 'review', lastToolAt: ago(1) } })
    const seen = await boardEngine($, on, {
      jobs: () => [workflow],
      result: (id) => ({
        value: answer('result', {
          id,
          messages: [
            { kind: 'steer', preview: 'stop after the tests', stage: 'claimed', createdAt: ago(5), relay: { entry: 'u-1', at: ago(5) }, outcome: { action: 'steered' } },
            { kind: 'steer', preview: 'and lint', stage: 'inbox', createdAt: ago(1), relay: null, outcome: null },
          ],
          report: '# Findings\n\nAll good.\n',
        }),
      }),
    })
    const { ui } = await openBoard($, surface)

    await ui.press({ key: 'job:j-1' })

    expect(seen.runs.at(-1)).toEqual({ argv: companionArgv('result', 'j-1', '--json'), init: { cwd: CWD, timeoutMs: 30000 } })
    expect(await rowText(ui, 'j-1')).toMatch(/^> j-1/)
    expect((await ui.find({ key: 'job:j-1' }))?.props.autoFocus).toBe(true)
    expect(await shows(ui, 'model gpt-6.1-sol · effort low')).toBe(true)
    expect(await shows(ui, 'relay review · Workflow run wf_7f3a')).toBe(true)
    // Each message says which route it took: a relay record, or none.
    expect(await shows(ui, '- steer · stop after the tests · by the relay · steered')).toBe(true)
    expect(await shows(ui, '- steer · and lint · directly · pending (inbox)')).toBe(true)
    expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('# Findings\n\nAll good.\n')
    expect((await ui.find({ type: 'Input' }))?.props.label).toBe('Steer')

    // The view is read again only when a fact it shows changes, never at the worker's heartbeat.
    const reads = () => seen.subs().filter((sub: string) => sub === 'result').length
    workflow.updatedAt = ago(0)
    await seen.clock.advance(6000)
    expect(reads()).toBe(1)
    workflow.openMessages = 1
    await seen.clock.advance(3000)
    expect(reads()).toBe(2)
    // The relay's call that hands a message over.
    workflow.relay = relayOf(workflow, { lastToolAt: ago(0) })
    await seen.clock.advance(3000)
    expect(reads()).toBe(3)
    workflow.state = 'completed'
    workflow.reportPath = '/jobs/j-1/report.md'
    await seen.clock.advance(3000)
    expect(reads()).toBe(4)
    await ui.unmount()
  })

  test(`a read writes the list only when what the board draws changed (${surface})`, async ($, on) => {
    const job = row('j-1', { relay: relayOf(row('j-1'), { lastToolAt: ago(14) }) })
    const seen = await boardEngine($, on, { jobs: () => [job] })
    const { ui } = await openBoard($, surface)
    expect(seen.listWrites).toHaveLength(1)

    // The same answer, and one the heartbeat rewrote, draw nothing new.
    await seen.clock.advance(3000)
    job.updatedAt = ago(0)
    await seen.clock.advance(3000)
    expect(seen.listWrites).toHaveLength(1)

    // A minute on, its relay has been quiet past 15 minutes: the row says so.
    await seen.clock.advance(60000)
    expect(seen.listWrites).toHaveLength(2)
    expect(await rowText(ui, 'j-1')).toBe('  j-1 · codex · running · attempt 1 · relay lost')
    job.undeliveredCount = 1
    await seen.clock.advance(3000)
    expect(seen.listWrites).toHaveLength(3)
    await ui.unmount()
  })

  test(`a steer to this session's live Agent tool relay reads the job, then goes as the lead's SendMessage (${surface})`, async ($, on) => {
    let delivered = false
    const seen = await boardEngine($, on, {
      jobs: () => [row('j-1')],
      result: (id) => ({
        value: answer('result', {
          id,
          // The relay hands the message over after the send.
          messages: delivered
            ? [{ kind: 'steer', preview: 'stop after the tests', stage: 'claimed', createdAt: new Date(NOW).toISOString(), relay: { entry: 'u-1', at: null }, outcome: { action: 'steered' } }]
            : [],
          report: null,
        }),
      }),
    })
    const { ui } = await openBoard($, surface)
    await ui.press({ key: 'job:j-1' })
    const before = seen.runs.length

    await ui.input({ key: 'message:j-1', text: 'stop after the tests' })

    expect(seen.runs[before]).toEqual({ argv: viewArgv('j-1'), init: { cwd: CWD, timeoutMs: 10000 } })
    expect(seen.sends).toEqual([{ to: 'a-j-1', text: 'stop after the tests', origin: { kind: 'plugin', name: 'relay' } }])
    // No companion send: the job's read, the wake for the relay, then the board's reads.
    expect(seen.subs().slice(before)).toEqual(['status', 'wake', 'status', 'result'])
    expect(seen.runs[before + 1]).toEqual({ argv: wakeArgv('a-j-1'), init: { timeoutMs: 10000 } })
    expect(await shows(ui, 'By the relay worker-j-1: sent, pending until the relay delivers it.')).toBe(true)

    // Once the job's messages show one the relay handed over since, the note no longer says pending.
    delivered = true
    await ui.press({ key: 'job:j-1' })
    expect(await shows(ui, 'By the relay worker-j-1: sent, and the relay delivered it.')).toBe(true)
    expect(await shows(ui, '- steer · stop after the tests · by the relay · steered')).toBe(true)
    await ui.unmount()
  })

  test(`the note says delivered only for the sent message, not for another the relay delivers first (${surface})`, async ($, on) => {
    const at = new Date(NOW).toISOString()
    const byRelay = (preview: string, createdAt: string) => ({ kind: 'steer', preview, stage: 'claimed', createdAt, relay: { entry: 'u-' + preview.length, at: null }, outcome: { action: 'steered' } })
    let messages: any[] = []
    await boardEngine($, on, { jobs: () => [row('j-1')], result: (id) => ({ value: answer('result', { id, messages, report: null }) }) })
    const { ui } = await openBoard($, surface)
    await ui.press({ key: 'job:j-1' })
    const pending = 'By the relay worker-j-1: sent, pending until the relay delivers it.'

    // Spaces and a tab, and longer than a preview's 120 characters.
    await ui.input({ key: 'message:j-1', text: '  stop   after\tthe tests, ' + 'then lint '.repeat(12) })
    expect(await shows(ui, pending)).toBe(true)

    // The lead's own SendMessage, which the relay delivered first.
    messages = [byRelay('run the linter', at)]
    await ui.press({ key: 'job:j-1' })
    expect(await shows(ui, pending)).toBe(true)
    // The same text sent before this send.
    const preview = ('stop after the tests, ' + 'then lint '.repeat(12)).slice(0, 120)
    messages = [...messages, byRelay(preview, ago(5))]
    await ui.press({ key: 'job:j-1' })
    expect(await shows(ui, pending)).toBe(true)
    // The same text sent directly, with no relay record.
    messages = [...messages, { ...byRelay(preview, at), relay: null }]
    await ui.press({ key: 'job:j-1' })
    expect(await shows(ui, pending)).toBe(true)

    // This send, its preview as the job's messages cut it.
    messages = [...messages, byRelay(preview, at)]
    await ui.press({ key: 'job:j-1' })
    expect(await shows(ui, 'By the relay worker-j-1: sent, and the relay delivered it.')).toBe(true)
    await ui.unmount()
  })

  test(`the route comes from the job read at the press, never from the list's row (${surface})`, async ($, on) => {
    const listed: Record<string, any> = {
      // The list shows a live Agent tool relay that called a minute ago.
      'j-4': row('j-4'),
      'j-3': row('j-3'),
      // The list shows a Workflow relay, and a relay quiet for 20 minutes.
      'j-2': row('j-2', { relay: relayOf(row('j-2'), { workflowRunId: 'wf_7f3a' }) }),
      'j-1': row('j-1', { relay: relayOf(row('j-1'), { lastToolAt: ago(20) }) }),
    }
    const fresh: Record<string, any> = {
      'j-4': row('j-4', { relay: relayOf(row('j-4'), { workflowRunId: 'wf_7f3a' }) }),
      'j-3': row('j-3', { relay: relayOf(row('j-3'), { lastToolAt: ago(16) }) }),
      'j-2': row('j-2'),
      'j-1': row('j-1'),
    }
    const seen = await boardEngine($, on, {
      jobs: () => Object.values(listed),
      view: (id) => ({ value: answer('status', { ...fresh[id], messages: [] }) }),
    })
    const { ui } = await openBoard($, surface)

    for (const id of Object.keys(listed)) {
      await ui.press({ key: 'job:' + id })
      await ui.input({ key: 'message:' + id, text: 'hello ' + id })
    }

    expect(seen.acts().map((r: any) => r.argv)).toEqual([
      companionArgv('steer', 'j-4', '--message', 'hello j-4', '--json'),
      companionArgv('steer', 'j-3', '--message', 'hello j-3', '--json'),
    ])
    expect(seen.sends.map((send: any) => [send.to, send.text])).toEqual([
      ['a-j-2', 'hello j-2'],
      ['a-j-1', 'hello j-1'],
    ])
    await ui.unmount()
  })

  test(`a string-return Workflow relay, recorded with no run id, is sent to directly, live or ended (${surface})`, async ($, on) => {
    const jobs = [
      row('j-2', { relay: relayOf(row('j-2'), { stringReturn: true }) }),
      row('j-1', { state: 'completed', relay: relayOf(row('j-1'), { stringReturn: true, lastToolAt: ago(90) }) }),
    ]
    // The agent list holds both relays, so only stringReturn keeps them off the relay route.
    const seen = await boardEngine($, on, { jobs: () => jobs })
    const { ui } = await openBoard($, surface)

    for (const job of jobs) {
      await ui.press({ key: 'job:' + job.id })
      await ui.input({ key: 'message:' + job.id, text: 'hello' })
    }

    expect(seen.sends).toEqual([])
    expect(seen.acts().map((r: any) => r.argv)).toEqual([
      companionArgv('steer', 'j-2', '--message', 'hello', '--json'),
      companionArgv('continue', 'j-1', '--message', 'hello', '--json'),
    ])
    await ui.unmount()
  })

  test(`a running job's relay listed as waiting between its steps still takes the steer (${surface})`, async ($, on) => {
    const seen = await boardEngine($, on, { jobs: () => [row('j-1')], agents: () => [relayAgent('a-j-1', 'waiting')] })
    const { ui } = await openBoard($, surface)
    await ui.press({ key: 'job:j-1' })
    await ui.input({ key: 'message:j-1', text: 'stop after the tests' })
    expect(seen.sends).toHaveLength(1)
    expect(seen.subs()).not.toContain('steer')
    await ui.unmount()
  })

  test(`a continue of an ended or dead job of this session goes by its relay, which the agent list has dropped (${surface})`, async ($, on) => {
    const seen = await boardEngine($, on, {
      jobs: () => [
        row('j-2', { state: 'dead', attempts: 2, relay: relayOf(row('j-2'), { lastToolAt: ago(300) }) }),
        row('j-1', { state: 'completed', relay: relayOf(row('j-1'), { lastToolAt: ago(90) }) }),
      ],
      agents: () => [],
    })
    const { ui } = await openBoard($, surface)

    for (const id of ['j-2', 'j-1']) {
      await ui.press({ key: 'job:' + id })
      expect((await ui.find({ type: 'Input' }))?.props.label).toBe('Continue')
      await ui.input({ key: 'message:' + id, text: 'now the docs' })
    }

    expect(seen.sends.map((send: any) => send.to)).toEqual(['a-j-2', 'a-j-1'])
    expect(seen.acts()).toEqual([])
    await ui.unmount()
  })

  test(`every job whose relay is not this session's live Agent tool agent is sent to directly (${surface})`, async ($, on) => {
    const base = row('j-0')
    const jobs = [
      row('j-wf', { relay: relayOf(base, { workflowRunId: 'wf_7f3a' }) }),
      row('j-other', { claudeSessionId: 'another-session' }),
      row('j-unknown', { claudeSessionId: null }),
      row('j-none', { relay: null }),
      row('j-quiet', { relay: relayOf(base, { lastToolAt: ago(16) }) }),
      // An automatic resume puts a long-lived job back in starting: its relay's silence counts too.
      row('j-starting', { state: 'starting', relay: relayOf(base, { agentId: 'a-j-starting', lastToolAt: ago(60) }) }),
      // Called lately, but no running relay:job of this process holds the id.
      row('j-gone', { relay: relayOf(base, { agentId: 'a-j-gone' }) }),
      row('j-done', { relay: relayOf(base, { agentId: 'a-j-done' }) }),
      row('j-ended', { state: 'failed', relay: null }),
    ]
    const seen = await boardEngine($, on, {
      jobs: () => jobs,
      agents: () => [...jobs.filter((job) => job.relay?.agentId && job.id !== 'j-gone' && job.id !== 'j-done').map((job) => relayAgent(job.relay.agentId)), relayAgent('a-j-done', 'completed')],
    })
    const { ui } = await openBoard($, surface)

    for (const job of jobs) {
      await ui.press({ key: 'job:' + job.id })
      await ui.input({ key: 'message:' + job.id, text: 'hello ' + job.id })
    }

    expect(seen.sends).toEqual([])
    expect(seen.acts()).toEqual([
      ...jobs.slice(0, -1).map((job) => ({
        argv: companionArgv('steer', job.id, '--message', 'hello ' + job.id, '--json'),
        init: { cwd: CWD, timeoutMs: 75000 },
      })),
      { argv: companionArgv('continue', 'j-ended', '--message', 'hello j-ended', '--json'), init: { cwd: CWD, timeoutMs: 75000 } },
    ])
    expect(await shows(ui, 'To the job directly (continue): steered.')).toBe(true)
    await ui.unmount()
  })

  test(`a relay that called 15 minutes ago is not yet quiet, and one second more is (${surface})`, async ($, on) => {
    const at = (ms: number) => new Date(NOW - ms).toISOString()
    const jobs = [
      row('j-edge', { relay: relayOf(row('j-edge'), { lastToolAt: at(15 * 60000) }) }),
      row('j-past', { relay: relayOf(row('j-past'), { lastToolAt: at(15 * 60000 + 1000) }) }),
      row('j-start', { state: 'starting', relay: relayOf(row('j-start'), { lastToolAt: at(15 * 60000) }) }),
    ]
    const seen = await boardEngine($, on, { jobs: () => jobs })
    const { ui } = await openBoard($, surface)

    for (const job of jobs) {
      await ui.press({ key: 'job:' + job.id })
      await ui.input({ key: 'message:' + job.id, text: 'hello' })
    }

    expect(seen.sends.map((send: any) => send.to)).toEqual(['a-j-edge', 'a-j-start'])
    expect(seen.acts().map((r: any) => r.argv[3])).toEqual(['j-past'])
    await ui.unmount()
  })

  test(`a session id that changed after the board opened sends to the job directly (${surface})`, async ($, on) => {
    let id = SESSION
    const seen = await boardEngine($, on, { jobs: () => [row('j-1')], id: () => id })
    const { ui } = await openBoard($, surface)
    await ui.press({ key: 'job:j-1' })

    // A /clear goes on under a new session id.
    id = 'after-clear'
    await ui.input({ key: 'message:j-1', text: 'hello' })

    expect(seen.sends).toEqual([])
    expect(seen.acts().map((r: any) => r.argv)).toEqual([companionArgv('steer', 'j-1', '--message', 'hello', '--json')])
    await ui.unmount()
  })

  test(`a send takes its kind from the job read at the press, and sends nothing when it moved on or cannot be read (${surface})`, async ($, on) => {
    const listed = row('j-1')
    let fresh: () => unknown = () => ({ value: answer('status', { ...listed, state: 'completed', messages: [] }) })
    const seen = await boardEngine($, on, { jobs: () => [listed], view: () => fresh() })
    const { ui } = await openBoard($, surface)
    await ui.press({ key: 'job:j-1' })
    expect((await ui.find({ type: 'Input' }))?.props.label).toBe('Steer')

    // The list still said running when the person typed a steer.
    await ui.input({ key: 'message:j-1', text: 'hello' })
    expect(await shows(ui, 'Nothing was sent: the job moved on, and is completed at attempt 1.')).toBe(true)

    fresh = () => ({ value: answer('status', { error: { kind: 'busy', message: 'busy' } }, 4) })
    await ui.input({ key: 'message:j-1', text: 'hello' })
    expect(await shows(ui, 'Nothing was sent: the job could not be read (its record was changing).')).toBe(true)

    fresh = () => ({ deny: 'timed out after 10000 ms' })
    await ui.input({ key: 'message:j-1', text: 'hello' })
    expect(await shows(ui, /^Nothing was sent: the job could not be read \(.*timed out after 10000 ms.*\)\.$/)).toBe(true)

    expect(seen.sends).toEqual([])
    expect(seen.acts()).toEqual([])
    await ui.unmount()
  })

  test(`a send the relay refuses shows its reason and sends to the job directly only when pressed (${surface})`, async ($, on) => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const seen = await boardEngine($, on, {
      jobs: () => [row('j-1')],
      sent: () => ({ isDelivered: false, reason: 'no agent with id a-j-1' }),
      act: () => held.then(() => ({ value: answer('steer', { job: 'j-1', outcome: null, state: 'running' }, 4) })),
    })
    const { ui } = await openBoard($, surface)
    await ui.press({ key: 'job:j-1' })

    await ui.input({ key: 'message:j-1', text: 'check the tests' })

    expect(seen.sends).toHaveLength(1)
    expect(seen.acts()).toEqual([])
    expect(await shows(ui, 'By the relay worker-j-1: refused: no agent with id a-j-1')).toBe(true)

    // While the direct send runs, the note says so and the button is gone.
    const pressed = ui.press({ key: 'direct' })
    await seen.clock.settle()
    expect(await shows(ui, 'To the job directly (steer): sending…')).toBe(true)
    expect(await ui.find({ key: 'direct' })).toBeUndefined()
    release()
    await pressed

    expect(seen.sends).toHaveLength(1)
    expect(seen.acts()).toEqual([{ argv: companionArgv('steer', 'j-1', '--message', 'check the tests', '--json'), init: { cwd: CWD, timeoutMs: 75000 } }])
    // An accepted send no worker has taken yet shows as pending, and the button stays gone.
    expect(await shows(ui, 'To the job directly (steer): pending, no worker has taken it yet.')).toBe(true)
    expect(await ui.find({ key: 'direct' })).toBeUndefined()
    await ui.unmount()
  })

  test(`"Send to the job directly" goes at its press, and a press while that send runs sends nothing more (${surface})`, async ($, on) => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    let isHeld = false
    const seen = await boardEngine($, on, {
      jobs: () => [row('j-1')],
      sent: () => ({ isDelivered: false, reason: 'no agent with id a-j-1' }),
      // The job's read at the press is slow.
      view: () => {
        const view = { value: answer('status', { ...row('j-1'), messages: [] }) }
        return isHeld ? held.then(() => view) : view
      },
    })
    const { ui } = await openBoard($, surface)
    await ui.press({ key: 'job:j-1' })
    await ui.input({ key: 'message:j-1', text: 'check the tests' })

    isHeld = true
    const first = ui.press({ key: 'direct' })
    await seen.clock.settle()
    // While the job is read the note says so, and the button is gone, so it cannot be pressed twice.
    expect(await shows(ui, 'Reading the job…')).toBe(true)
    expect(await ui.find({ key: 'direct' })).toBeUndefined()
    // The field's press for the job meanwhile is dropped: it would go by the relay.
    const second = ui.input({ key: 'message:j-1', text: 'and lint' })
    await seen.clock.settle()
    expect(await shows(ui, 'Reading the job…')).toBe(true)
    release()
    await Promise.all([first, second])

    expect(seen.runs.filter((r: any) => r.argv[2] === 'status' && r.argv[3] === 'j-1')).toHaveLength(2)
    expect(seen.sends).toHaveLength(1)
    expect(seen.acts().map((r: any) => r.argv)).toEqual([companionArgv('steer', 'j-1', '--message', 'check the tests', '--json')])
    await ui.unmount()
  })

  test(`a send from the field says it is reading the job from its press (${surface})`, async ($, on) => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const seen = await boardEngine($, on, {
      jobs: () => [row('j-1')],
      view: () => held.then(() => ({ value: answer('status', { ...row('j-1'), messages: [] }) })),
    })
    const { ui } = await openBoard($, surface)
    await ui.press({ key: 'job:j-1' })

    const pressed = ui.input({ key: 'message:j-1', text: 'stop after the tests' })
    await seen.clock.settle()
    expect(seen.sends).toEqual([])
    expect(await shows(ui, 'Reading the job…')).toBe(true)
    release()
    await pressed

    expect(seen.sends.map((send: any) => send.text)).toEqual(['stop after the tests'])
    expect(await shows(ui, 'By the relay worker-j-1: sent, pending until the relay delivers it.')).toBe(true)
    await ui.unmount()
  })

  test(`a refused send's direct button sends nothing once the job moved on (${surface})`, async ($, on) => {
    const job = row('j-1')
    const seen = await boardEngine($, on, { jobs: () => [job], sent: () => ({ isDelivered: false, reason: 'busy' }) })
    const { ui } = await openBoard($, surface)
    await ui.press({ key: 'job:j-1' })
    await ui.input({ key: 'message:j-1', text: 'check the tests' })

    // An automatic resume started attempt 2: the refused steer was meant for attempt 1.
    job.attempts = 2
    await ui.press({ key: 'direct' })

    expect(seen.acts()).toEqual([])
    expect(await shows(ui, 'Nothing was sent: the job moved on, and is running at attempt 2.')).toBe(true)
    expect(await ui.find({ key: 'direct' })).toBeUndefined()
    await ui.unmount()
  })

  test(`a relay send that throws offers no direct send and sends nothing more (${surface})`, async ($, on) => {
    const seen = await boardEngine($, on, {
      jobs: () => [row('j-1')],
      sent: () => {
        throw new Error('the session is ending')
      },
    })
    const { ui } = await openBoard($, surface)
    await ui.press({ key: 'job:j-1' })

    await ui.input({ key: 'message:j-1', text: 'hello' })

    expect(seen.sends).toHaveLength(1)
    expect(seen.acts()).toEqual([])
    expect(await shows(ui, /^By the relay worker-j-1: the send did not finish \(.+\); it may have gone through\.$/)).toBe(true)
    expect(await ui.find({ key: 'direct' })).toBeUndefined()
    await ui.unmount()
  })

  test(`a direct send that did not finish, or whose answer cannot be read, says which (${surface})`, async ($, on) => {
    const answers: Array<() => unknown> = [() => ({ deny: 'timed out after 75000 ms' }), () => ({ value: printed('steer: queued\n') })]
    let next = 0
    await boardEngine($, on, { jobs: () => [row('j-1', { relay: null })], act: () => answers[next++]!() })
    const { ui } = await openBoard($, surface)
    await ui.press({ key: 'job:j-1' })

    await ui.input({ key: 'message:j-1', text: 'one' })
    expect(await shows(ui, /^To the job directly \(steer\): did not finish \(.*timed out after 75000 ms.*\); it may have reached the job\.$/)).toBe(true)
    await ui.input({ key: 'message:j-1', text: 'two' })
    expect(await shows(ui, /^To the job directly \(steer\): finished, and its answer could not be read \(.+\); it may have reached the job\.$/)).toBe(true)
    await ui.unmount()
  })

  test(`a direct send's timeout is the companion's acknowledgement wait and 15 s more (${surface})`, async ($, on) => {
    const seen = await boardEngine($, on, { jobs: () => [row('j-1', { relay: null })], env: { RELAY_JOBS_ACK_TIMEOUT_MS: '30000' } })
    const { ui } = await openBoard($, surface)
    await ui.press({ key: 'job:j-1' })

    await ui.input({ key: 'message:j-1', text: 'hello' })

    expect(seen.acts().map((r: any) => r.init.timeoutMs)).toEqual([45000])
    await ui.unmount()
  })

  test(`the field is the selected job's own (${surface})`, async ($, on) => {
    await boardEngine($, on, { jobs: () => [row('j-2'), row('j-1')] })
    const { ui } = await openBoard($, surface)

    await ui.press({ key: 'job:j-1' })
    expect((await ui.findAll({ type: 'Input' })).map((input: any) => input.key)).toEqual(['message:j-1'])
    await ui.press({ key: 'job:j-2' })
    expect((await ui.findAll({ type: 'Input' })).map((input: any) => input.key)).toEqual(['message:j-2'])
    await ui.unmount()
  })

  test(`a running Kimi job's send is labelled Queue next turn (${surface})`, async ($, on) => {
    await boardEngine($, on, { jobs: () => [row('j-2', { backend: 'kimi' }), row('j-1', { backend: 'kimi', state: 'starting' })] })
    const { ui } = await openBoard($, surface)

    await ui.press({ key: 'job:j-2' })
    expect((await ui.find({ type: 'Input' }))?.props.label).toBe('Queue next turn')
    await ui.press({ key: 'job:j-1' })
    expect((await ui.find({ type: 'Input' }))?.props.label).toBe('Steer')
    await ui.unmount()
  })

  test(`Cancel asks again with the job and its attempt, and Yes cancels that attempt (${surface})`, async ($, on) => {
    let cancelled = 0
    const seen = await boardEngine($, on, {
      jobs: () => [row('j-1', { attempts: 2 }), row('j-0', { state: 'cancelled' })],
      act: () =>
        cancelled++ === 0
          ? { value: answer('cancel', { error: { kind: 'attempt-changed', message: 'Job j-1 is at attempt 3, not 2: nothing was cancelled.' } }, 1) }
          : { value: answer('cancel', { id: 'j-1', state: 'cancelled', actions: [] }) },
    })
    const { ui } = await openBoard($, surface)
    await ui.press({ key: 'job:j-0' })
    expect(await ui.find({ key: 'cancel' })).toBeUndefined()
    await ui.press({ key: 'job:j-1' })

    await ui.press({ key: 'cancel' })
    expect(await shows(ui, 'Cancel job j-1, attempt 2?')).toBe(true)
    await ui.press({ key: 'cancel-no' })
    expect(seen.subs()).not.toContain('cancel')
    expect(await ui.find({ key: 'cancel-yes' })).toBeUndefined()

    await ui.press({ key: 'cancel' })
    await ui.press({ key: 'cancel-yes' })
    // Twice the companion's 10 s grace, and 40 s more.
    expect(seen.runs.filter((r: any) => r.argv[2] === 'cancel')).toEqual([
      { argv: companionArgv('cancel', 'j-1', '--attempt', '2', '--json'), init: { cwd: CWD, timeoutMs: 60000 } },
    ])
    expect(await shows(ui, 'Cancel of attempt 2: Job j-1 is at attempt 3, not 2: nothing was cancelled. The job moved on: press Cancel again to cancel the new attempt.')).toBe(true)

    await ui.press({ key: 'cancel' })
    await ui.press({ key: 'cancel-yes' })
    expect(await shows(ui, 'Cancel of attempt 2: the job is cancelled.')).toBe(true)
    await ui.unmount()
  })

  test(`Cancel says what the companion did, and that a cancel with its worker still runs (${surface})`, async ($, on) => {
    const answers = [
      answer('cancel', { id: 'j-1', state: 'running', actions: ['attempt 2 was stopped; attempt 3 runs on'] }),
      answer('cancel', { id: 'j-1', state: 'running', actions: ['the job is still running; the cancel is with its worker (pid 41)'] }, 4),
    ]
    let next = 0
    await boardEngine($, on, { jobs: () => [row('j-1', { attempts: 2 })], act: () => ({ value: answers[next++] }) })
    const { ui } = await openBoard($, surface)
    await ui.press({ key: 'job:j-1' })

    await ui.press({ key: 'cancel' })
    await ui.press({ key: 'cancel-yes' })
    expect(await shows(ui, 'Cancel of attempt 2: the job is running (attempt 2 was stopped; attempt 3 runs on).')).toBe(true)
    await ui.press({ key: 'cancel' })
    await ui.press({ key: 'cancel-yes' })
    expect(
      await shows(ui, 'Cancel of attempt 2: the job still runs, and the cancel is with its worker (the job is still running; the cancel is with its worker (pid 41)).'),
    ).toBe(true)
    await ui.unmount()
  })

  test(`Cancel says it is cancelling while it runs, and a second Yes meanwhile runs no second cancel (${surface})`, async ($, on) => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const seen = await boardEngine($, on, {
      jobs: () => [row('j-1', { attempts: 2 })],
      act: () => held.then(() => ({ value: answer('cancel', { id: 'j-1', state: 'cancelled', actions: [] }) })),
    })
    const { ui } = await openBoard($, surface)
    await ui.press({ key: 'job:j-1' })
    await ui.press({ key: 'cancel' })

    const first = ui.press({ key: 'cancel-yes' })
    await seen.clock.settle()
    expect(await shows(ui, 'Cancelling attempt 2…')).toBe(true)
    const again = ui.press({ key: 'cancel' })
    await seen.clock.settle()
    const second = ui.press({ key: 'cancel-yes' })
    await seen.clock.settle()
    expect(await ui.find({ key: 'cancel-yes' })).toBeUndefined()
    expect(await shows(ui, 'Cancelling attempt 2…')).toBe(true)
    release()
    await Promise.all([first, again, second])

    expect(seen.runs.filter((r: any) => r.argv[2] === 'cancel').map((r: any) => r.argv)).toEqual([companionArgv('cancel', 'j-1', '--attempt', '2', '--json')])
    expect(await shows(ui, 'Cancel of attempt 2: the job is cancelled.')).toBe(true)
    await ui.unmount()
  })

  test(`a busy listing keeps the rows, and another failure shows its message above them (${surface})`, async ($, on) => {
    const answers: Array<() => unknown> = [
      () => ({ value: answer('status', { jobs: [row('j-1')], nextCursor: null }) }),
      () => ({ value: answer('status', { error: { kind: 'busy', message: 'busy' } }, 4) }),
      () => ({ deny: 'timed out after 10000 ms' }),
    ]
    let next = 0
    const seen = await boardEngine($, on, { status: () => answers[next++]() })
    const { ui } = await openBoard($, surface)

    await seen.clock.advance(3000)
    expect(await shows(ui, "A job's record was changing: this is the last read.")).toBe(true)
    expect(await rowText(ui, 'j-1')).toBeDefined()

    await seen.clock.advance(3000)
    expect(await shows(ui, /^The jobs could not be read: .*timed out after 10000 ms.*\.$/)).toBe(true)
    expect(await rowText(ui, 'j-1')).toBeDefined()
    await ui.unmount()
  })

  test(`until a listing succeeds the board says it is reading, never that there are no jobs (${surface})`, async ($, on) => {
    const answers: Array<() => unknown> = [
      () => ({ value: answer('status', { error: { kind: 'busy', message: 'busy' } }, 4) }),
      () => ({ deny: 'timed out after 10000 ms' }),
      () => ({ value: answer('status', { error: { kind: 'busy', message: 'busy' } }, 4) }),
      () => ({ value: answer('status', { jobs: [], nextCursor: null }) }),
    ]
    let next = 0
    const seen = await boardEngine($, on, { status: () => answers[next++]!() })
    const { ui } = await openBoard($, surface)

    const texts = async () => (await ui.findAll({ type: 'Text' })).map((text: any) => text.text)
    expect(await texts()).toEqual(["Reading this repository's jobs..."])
    await seen.clock.advance(3000)
    expect(await texts()).toEqual([expect.stringMatching(/^The jobs could not be read: .*timed out after 10000 ms.*\.$/)])
    await seen.clock.advance(3000)
    expect(await texts()).toEqual(["Reading this repository's jobs..."])
    await seen.clock.advance(3000)
    expect(await texts()).toEqual(['No jobs in this repository.'])
    await ui.unmount()
  })

  test(`a view that is busy at its first read says it is reading, and a failed one is read again in 10 s or when pressed (${surface})`, async ($, on) => {
    const answers: Array<() => unknown> = [
      () => ({ value: answer('result', { error: { kind: 'busy', message: 'busy' } }, 4) }),
      () => ({ deny: 'timed out after 30000 ms' }),
      () => ({ deny: 'timed out after 30000 ms' }),
      () => ({ value: answer('result', { id: 'j-1', messages: [], report: null }) }),
    ]
    let next = 0
    // An ended job, whose row never changes.
    const seen = await boardEngine($, on, { jobs: () => [row('j-1', { state: 'completed', reportPath: '/jobs/j-1/report.md' })], result: () => answers[next++]!() })
    const { ui } = await openBoard($, surface)
    const reads = () => seen.subs().filter((sub: string) => sub === 'result').length

    await ui.press({ key: 'job:j-1' })
    expect(await shows(ui, 'Reading the job...')).toBe(true)
    expect(await shows(ui, 'No report yet.')).toBe(false)

    await seen.clock.advance(3000)
    expect(reads()).toBe(2)
    expect(await shows(ui, /^The job could not be read: .*timed out after 30000 ms.*\. The report is \/jobs\/j-1\/report\.md; \/relay:result j-1 shows it\.$/)).toBe(true)
    // Not at every tick: no sooner than 10 s after the failure.
    await seen.clock.advance(9000)
    expect(reads()).toBe(2)
    await seen.clock.advance(3000)
    expect(reads()).toBe(3)
    // Pressing the row reads it at once.
    await ui.press({ key: 'job:j-1' })
    expect(reads()).toBe(4)
    expect(await shows(ui, 'No report yet.')).toBe(true)
    await ui.unmount()
  })

  test(`More grows the window to 200 rows, then Older jobs pages on and Newest jobs returns (${surface})`, async ($, on) => {
    const seen = await boardEngine($, on, { jobs: () => [row('j-1')], nextCursor: 'WyJjMSJd' })
    const { ui } = await openBoard($, surface)
    const listingArgv = () => seen.runs.filter((r: any) => r.argv[2] === 'status' && r.argv[3] === '--json').at(-1).argv.slice(3)
    const buttons = async () => (await ui.findAll({ type: 'Button' })).map((b: any) => b.key).filter((key: string) => !key.startsWith('job:'))

    for (let limit = 40; limit <= 200; limit += 20) {
      await ui.press({ key: 'more' })
      expect(listingArgv()).toEqual(['--json', '--limit', String(limit)])
    }
    // 200 rows show and more jobs exist: the window moves on rather than growing.
    expect(await buttons()).toEqual(['older'])
    await ui.press({ key: 'older' })
    expect(listingArgv()).toEqual(['--json', '--limit', '200', '--cursor', 'WyJjMSJd'])
    // The polls read the window shown.
    await seen.clock.advance(3000)
    expect(listingArgv()).toEqual(['--json', '--limit', '200', '--cursor', 'WyJjMSJd'])
    expect(await buttons()).toEqual(['older', 'newest'])
    await ui.press({ key: 'newest' })
    expect(listingArgv()).toEqual(['--json', '--limit', '200'])
    expect(await buttons()).toEqual(['older'])
    await ui.unmount()
  })
}

test('the board reads only while its pane is placed and a surface draws, from its open until its close', async ($, on) => {
  let surfaces: string[] = []
  let isPlaced = false
  let isOpen = false
  const seen = await boardEngine($, on, {
    surfaces: () => surfaces,
    panes: () => (isOpen ? [{ ...PANE, isShown: isPlaced, isFocused: false, isPlaced }] : []),
    opened: () => ({ isPlaced: false, reason: 'unasked panes are placed from 144 columns; the terminal has 100' }),
    jobs: () => [row('j-1')],
  })

  // No timer before the board opens.
  await seen.clock.advance(9000)
  expect(seen.paneReads()).toBe(1)
  isOpen = true
  const opened: any = await $.command.run(command('relay-board'))
  expect(opened.text).toBe('The relay board is open but not drawn: unasked panes are placed from 144 columns; the terminal has 100')

  // Open but not placed, with a surface and without.
  surfaces = ['terminal']
  await seen.clock.advance(6000)
  // Placed, with no surface.
  isPlaced = true
  surfaces = []
  await seen.clock.advance(6000)
  expect(seen.runs).toEqual([])

  // The same timer reads every 3 s once both hold.
  surfaces = ['desktop']
  await seen.clock.advance(6000)
  expect(seen.subs()).toEqual(['status', 'status'])

  // Once the pane is closed the timer stops. A test cannot close a plugin's pane, so this is the
  // tick that finds it gone, which stops a timer the ui.close hook did not (an unload's close).
  isOpen = false
  await seen.clock.advance(3000)
  const reads = seen.paneReads()
  await seen.clock.advance(9000)
  expect(seen.paneReads()).toBe(reads)
  expect(seen.subs()).toEqual(['status', 'status'])
})

// A steer from a shell or another board, posted and taken between two reads, leaves the row's
// facts as they were: openMessages goes from 0 to 0.
test("a live job's view is read again at least every 30 s, so a message taken between two reads shows", async ($, on) => {
  let messages: any[] = []
  const seen = await boardEngine($, on, {
    jobs: () => [row('j-2'), row('j-1', { state: 'completed', reportPath: '/jobs/j-1/report.md' })],
    result: (id) => ({ value: answer('result', { id, messages, report: null }) }),
  })
  const { ui } = await openBoard($, 'terminal')
  const reads = () => seen.subs().filter((sub: string) => sub === 'result').length
  await ui.press({ key: 'job:j-2' })
  expect(reads()).toBe(1)

  await seen.clock.advance(3000)
  messages = [{ kind: 'steer', preview: 'and lint', stage: 'claimed', createdAt: ago(0), relay: null, outcome: { action: 'steered' } }]
  // Not at every tick: the read 30 s after the last.
  await seen.clock.advance(24000)
  expect(reads()).toBe(1)
  await seen.clock.advance(3000)
  expect(reads()).toBe(2)
  expect(await shows(ui, '- steer · and lint · directly · steered')).toBe(true)
  await seen.clock.advance(27000)
  expect(reads()).toBe(2)
  await seen.clock.advance(3000)
  expect(reads()).toBe(3)

  // An ended job's view is read again only when its row changes or is pressed.
  await ui.press({ key: 'job:j-1' })
  expect(reads()).toBe(4)
  await seen.clock.advance(90000)
  expect(reads()).toBe(4)
  await ui.unmount()
})

test('a pane behind another pane reads nothing, and one hidden during the listing starts no read of the selected job', async ($, on) => {
  const listed = row('j-1')
  let isShown = true
  let isHeld = false
  let answer$: (value: unknown) => void = () => {}
  const listed$ = () => ({ value: answer('status', { jobs: [{ ...listed }], nextCursor: null }) })
  const seen = await boardEngine($, on, {
    jobs: () => [listed],
    // Placed all along: only isShown changes, as when another pane is shown over it.
    panes: () => [{ ...PANE, isShown, isFocused: isShown }],
    status: () => (isHeld ? new Promise((resolve) => (answer$ = resolve)).then(listed$) : listed$()),
  })
  const { ui } = await openBoard($, 'terminal')
  await ui.press({ key: 'job:j-1' })
  expect(seen.subs()).toEqual(['status', 'status', 'result'])

  // The row changes, so the next read would read its view; the pane is hidden during the list read.
  listed.openMessages = 1
  isHeld = true
  await seen.clock.advance(3000)
  isShown = false
  isHeld = false
  answer$(undefined)
  await seen.clock.settle()
  expect(seen.subs()).toEqual(['status', 'status', 'result', 'status'])

  // Behind another pane, its ticks read nothing.
  await seen.clock.advance(9000)
  expect(seen.subs()).toEqual(['status', 'status', 'result', 'status'])

  // Shown again, the same timer reads the list and the changed view.
  isShown = true
  await seen.clock.advance(3000)
  expect(seen.subs()).toEqual(['status', 'status', 'result', 'status', 'status', 'result'])
  await ui.unmount()
})

test('a pane closed during the listing starts no read of the selected job', async ($, on) => {
  let isOpen = true
  let answer$: (value: unknown) => void = () => {}
  let isHeld = false
  const seen = await boardEngine($, on, {
    jobs: () => [row('j-1')],
    panes: () => (isOpen ? [PANE] : []),
    status: () => (isHeld ? new Promise((resolve) => (answer$ = resolve)) : { value: answer('status', { jobs: [row('j-1')], nextCursor: null }) }),
  })
  const { ui } = await openBoard($, 'terminal')
  await ui.press({ key: 'job:j-1' })
  expect(seen.subs()).toEqual(['status', 'status', 'result'])

  // A row changes, so the next read would read its view again; the pane closes while the list is read.
  isHeld = true
  await seen.clock.advance(3000)
  isOpen = false
  answer$({ value: answer('status', { jobs: [row('j-1', { openMessages: 1 })], nextCursor: null }) })
  await seen.clock.settle()

  expect(seen.subs()).toEqual(['status', 'status', 'result', 'status'])
  await ui.unmount()
})

test('ticks whose pane reads are slow still run one read at a time', async ($, on) => {
  const panes: ((value: unknown[]) => void)[] = []
  let isSlow = false
  const seen = await boardEngine($, on, {
    jobs: () => [row('j-1')],
    panes: () => (isSlow ? new Promise<unknown[]>((resolve) => panes.push(resolve)) : [PANE]),
  })
  await $.command.run(command('relay-board'))
  expect(seen.subs()).toEqual(['status'])

  isSlow = true
  await seen.clock.advance(6000)
  expect(panes).toHaveLength(1)
  // Both ticks fell while the first's pane read was out: only that one may read the listing.
  for (const answer of panes) answer([PANE])
  await seen.clock.settle()
  expect(seen.subs()).toEqual(['status', 'status'])
})

// A read whose pane read is out while the board closes and opens again answers "no pane", stale by
// then. A test cannot raise ui.close, which stops the timer at a close; the tick that finds the
// pane gone stops it here, and the stale read is a press's.
test('a read that saw the pane closed does not stop the timer of the board opened again since', async ($, on) => {
  let isOpen = true
  let isSlow = false
  let answer$: (value: unknown[]) => void = () => {}
  const seen = await boardEngine($, on, {
    jobs: () => [row('j-1')],
    panes: () => (isSlow ? new Promise<unknown[]>((resolve) => (answer$ = resolve)) : isOpen ? [PANE] : []),
  })
  const { ui } = await openBoard($, 'terminal')
  isOpen = false
  await seen.clock.advance(3000)
  expect(seen.subs()).toEqual(['status'])

  // A press whose pane read is slow, and the board opened again before it answers.
  isSlow = true
  const pressed = ui.press({ key: 'job:j-1' })
  await seen.clock.settle()
  isSlow = false
  isOpen = true
  await $.command.run(command('relay-board'))
  answer$([])
  await pressed

  // The board opened again still reads at every tick.
  await seen.clock.advance(6000)
  expect(seen.subs()).toEqual(['status', 'status', 'result', 'status'])
  await ui.unmount()
})

test('a reload while the pane is open starts the board timer again', async ($, on) => {
  // The fresh copy's session.start finds the pane the old copy left open.
  const seen = await boardEngine($, on, { jobs: () => [row('j-1')], panes: () => [PANE] })

  await seen.clock.advance(3000)

  expect(seen.subs()).toEqual(['status'])
})

test('/relay-board is declared again after /clear, /resume and a fork, which go on under another session', async ($, on) => {
  on('classic.SessionStart', () => ({}))
  const seen = await boardEngine($, on)
  expect(seen.registers).toEqual(['relay-board'])

  for (const source of ['startup', 'compact', 'clear', 'resume', 'fork'] as const) {
    await $.classic.SessionStart({ source })
  }

  expect(seen.registers).toEqual(['relay-board', 'relay-board', 'relay-board', 'relay-board'])
})

test("where nothing draws, /relay-board says where the board draws, names /relay:status, and reads from a surface's attach", async ($, on) => {
  let surfaces: string[] = []
  let isOpen = false
  let isPlaced = false
  on('session.attach', (_: unknown, e: any) => ({ clientId: e.clientId }))
  const seen = await boardEngine($, on, {
    surfaces: () => surfaces,
    // With no surface an open pane is listed unplaced, unshown and unfocused.
    panes: () => (isOpen ? [{ ...PANE, isShown: isPlaced, isFocused: false, isPlaced }] : []),
    opened: () => ({ isPlaced: false, reason: 'no-surface: no surface is attached' }),
    jobs: () => [row('j-1')],
  })

  isOpen = true
  const result = await $.command.run(command('relay-board'))

  expect(result).toMatchObject({
    text: "The relay board draws in the terminal and the desktop app, and nothing draws here. /relay:status lists this repository's jobs.",
  })
  // No timer: nothing reads, not even the pane list.
  const paneReads = seen.paneReads()
  await seen.clock.advance(30000)
  expect(seen.paneReads()).toBe(paneReads)
  expect(seen.runs).toEqual([])

  // A surface attaches and places the pane: the board reads from the next tick.
  surfaces = ['desktop']
  isPlaced = true
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await seen.clock.advance(3000)
  expect(seen.subs()).toEqual(['status'])
  await seen.clock.advance(3000)
  expect(seen.subs()).toEqual(['status', 'status'])
})

// The stop notice. The engine beneath answers the surfaces, the agent list, the companion's active
// listing of every repository, the transcript line, the toast, the turn's end and a TaskStop; the
// clock is mocked, so the notice's timer runs only when a test settles or moves it, and a
// TaskStop's mark lapses only when a test moves it.

const STOP_ARGV = ['node', expect.stringMatching(/^\/.*\/scripts\/companion\.mjs$/), 'status', '--all', '--active', '--limit', '200', '--json']
const KILLED = { id: 'a-relay', name: 'worker', description: 'a job', type: 'relay:job', status: 'killed' }
const NOTICE = 'worker was stopped, and its job j-1 keeps running. /relay:cancel j-1 cancels it, /relay:result j-1 shows it.'
const SKIPPED = 'stop notice skipped for a-relay: TaskStop named it'
const ABORTED = { answer: '', durationMs: 13204, isAborted: true, turnId: 't-1', agentId: 'a-relay', reason: 'aborted' as const }
const ENGINE_END = { text: 'the engine' }
const STOPPED = { message: 'Successfully stopped task: a-relay (worker)', task_id: 'a-relay', task_type: 'local_agent', command: 'worker' }

// A slim row of `status --json`, cut to what the notice reads.
const relayRow = (id: string, agentId: string, state = 'running') => ({ id, state, relay: { agentId, workflowRunId: null } })

type StopOptions = {
  surfaces?: () => string[]
  agents?: () => unknown
  jobs?: () => object[]
  run?: (e: any) => unknown
  // The TaskStop's answer, which a test may hold.
  stopped?: () => unknown
}

function stopEngine(on: any, options: StopOptions = {}) {
  const runs: any[] = []
  const logs: any[] = []
  const debugs: string[] = []
  const toasts: any[] = []
  const ends: any[] = []
  const stops: any[] = []
  let agentLists = 0
  on('session.surfaces', () => ({ value: options.surfaces ? options.surfaces() : ['terminal'] }))
  on('agent.list', () => {
    agentLists++
    return options.agents ? options.agents() : { value: [KILLED] }
  })
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', (_: unknown, e: any) => {
    runs.push(e)
    return options.run ? options.run(e) : { value: listing(options.jobs ? options.jobs() : [relayRow('j-1', 'a-relay')]) }
  })
  on('ui.log', (_: unknown, e: any) => {
    if (e.to === 'debug') {
      debugs.push(e.text)
    } else {
      logs.push(e)
    }
    return { value: undefined }
  })
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(e)
    return { value: undefined }
  })
  on('turn.complete', (_: unknown, e: any) => {
    ends.push(e)
    return ENGINE_END
  })
  on('tool.call', { tool: 'TaskStop' }, (_: unknown, e: any) => {
    stops.push(e)
    return options.stopped ? options.stopped() : { result: STOPPED, text: JSON.stringify(STOPPED) }
  })
  const clock = mock.clock(on, { now: NOW })
  return { runs, logs, debugs, toasts, ends, stops, clock, agentLists: () => agentLists }
}

// A relay's turn ends aborted, its end reaches the engine unchanged, and the notice, if any, is
// drawn once its timer has run.
async function stopRelay($: any, seen: any, end: object = ABORTED) {
  expect(await $.turn.complete(end)).toEqual(ENGINE_END)
  expect(seen.ends).toEqual([end])
  await seen.clock.settle()
}

// The order run m5 measured: the relay's aborted turn ends while the TaskStop call is still out,
// and the call returns after it. A mark written after `next(e)` would come too late.
async function stopWhileTaskStopIsOut($: any, seen: any, release: () => void, call: object) {
  const called = $.tool.call(call)
  await seen.clock.settle()
  expect(seen.stops).toHaveLength(1)
  seen.ends.length = 0
  await stopRelay($, seen)
  release()
  return called
}

test('a relay a person stopped, whose job runs, names the job in the transcript and a toast', async ($, on) => {
  const seen = stopEngine(on, { jobs: () => [relayRow('j-2', 'a-other'), relayRow('j-1', 'a-relay')] })

  await stopRelay($, seen)

  expect(seen.runs.map((r) => r.argv)).toEqual([STOP_ARGV])
  expect(seen.logs.map((e) => e.text)).toEqual([NOTICE])
  expect(seen.toasts).toEqual([{ text: NOTICE, timeoutMs: 20000 }])
  expect(seen.debugs).toEqual([])
})

test('a starting job shows the notice', async ($, on) => {
  const seen = stopEngine(on, { jobs: () => [relayRow('j-1', 'a-relay', 'starting')] })

  await stopRelay($, seen)

  expect(seen.logs.map((e) => e.text)).toEqual([NOTICE])
  expect(seen.toasts).toEqual([{ text: NOTICE, timeoutMs: 20000 }])
})

test('a listing that never answers does not hold the turn, which ends before the notice starts', async ($, on) => {
  const held: ((value: unknown) => void)[] = []
  const seen = stopEngine(on, { run: () => new Promise((resolve) => held.push(resolve)) })

  // The hook returns before its timer runs: nothing has been read yet.
  expect(await $.turn.complete(ABORTED)).toEqual(ENGINE_END)
  expect(seen.agentLists()).toBe(0)
  expect(seen.runs).toEqual([])

  // The timer starts the listing, which does not answer; a second relay's stop ends at once too.
  await seen.clock.settle()
  expect(seen.runs).toHaveLength(1)
  expect(await $.turn.complete({ ...ABORTED, turnId: 't-2' })).toEqual(ENGINE_END)
  expect(seen.logs).toEqual([])

  await seen.clock.settle()
  expect(seen.runs).toHaveLength(2)
  for (const release of held) release({ value: listing([relayRow('j-1', 'a-relay')]) })
  await seen.clock.settle()
  expect(seen.logs.map((e) => e.text)).toEqual([NOTICE, NOTICE])
})

test('where nothing draws, a relay a person stopped shows nothing and starts no process', async ($, on) => {
  const seen = stopEngine(on, { surfaces: () => [] })

  await stopRelay($, seen)
  await seen.clock.advance(60000)

  expect(seen.agentLists()).toBe(0)
  expect(seen.runs).toEqual([])
  expect(seen.logs).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('a relay a TaskStop named, by its name or by its id, while the call is still out, gets no notice', async ($, on) => {
  let release: () => void = () => {}
  const seen = stopEngine(on, {
    stopped: () => new Promise((resolve) => (release = () => resolve({ result: STOPPED, text: JSON.stringify(STOPPED) }))),
  })

  for (const [named, id] of [['worker', 'toolu_1'], ['a-relay', 'toolu_2']]) {
    const call = { tool: 'TaskStop', task_id: named, tool_use_id: id } as any
    seen.stops.length = 0
    const called = await stopWhileTaskStopIsOut($, seen, () => release(), call)
    expect(called).toMatchObject({ result: STOPPED })
    // The call reaches the engine as it was made.
    expect(seen.stops).toEqual([call])
  }

  expect(seen.runs).toEqual([])
  expect(seen.logs).toEqual([])
  expect(seen.toasts).toEqual([])
  expect(seen.debugs).toEqual([SKIPPED, SKIPPED])
})

test('a mark made by name alone, when the agent list failed at the TaskStop, is read and used up', async ($, on) => {
  let isListed = false
  const seen = stopEngine(on, { agents: () => (isListed ? { value: [KILLED] } : { deny: 'the session is not bound yet' }) })

  await $.tool.call({ tool: 'TaskStop', task_id: 'worker' } as any)
  isListed = true
  await stopRelay($, seen)

  expect(seen.runs).toEqual([])
  expect(seen.logs).toEqual([])
  expect(seen.debugs).toEqual([SKIPPED])

  // Both marks are used up: the relay, resumed and then stopped by a person, shows its notice.
  seen.ends.length = 0
  await stopRelay($, seen)
  expect(seen.logs.map((e) => e.text)).toEqual([NOTICE])
  expect(seen.debugs).toEqual([SKIPPED])
})

test('a TaskStop of another agent or of a shell leaves a person\'s stop of the relay its notice', async ($, on) => {
  const seen = stopEngine(on, {
    agents: () => ({ value: [{ id: 'a-lead', name: 'lead', description: 'lead', type: 'general-purpose', status: 'running' }, KILLED] }),
  })

  await $.tool.call({ tool: 'TaskStop', task_id: 'lead' } as any)
  await $.tool.call({ tool: 'TaskStop', task_id: 'b77' } as any)
  await stopRelay($, seen)

  expect(seen.logs.map((e) => e.text)).toEqual([NOTICE])
  expect(seen.debugs).toEqual([])
})

// A reload between the TaskStop and the relay's end loses the old copy and its closures, and
// keeps the session's state. The host's value under relay.stopMarks is answered here, so this
// copy of the module, which made no TaskStop call, reads the mark the old copy wrote.
test('a mark an earlier copy of the module wrote in $.state is read after a reload', async ($, on) => {
  let marks: Record<string, number | null> = { worker: NOW + 60000, 'a-relay': NOW + 60000, 'a-old': NOW - 1 }
  let version = 1
  const writes: unknown[] = []
  on('state.get', (_: unknown, e: any, next: any) => (e.key === 'stopMarks' ? { value: { value: marks, version } } : next(e)))
  on('state.set', (_: unknown, e: any, next: any) => {
    if (e.key !== 'stopMarks') {
      return next(e)
    }
    writes.push(e.value)
    marks = e.value
    return { value: { isSet: true, version: ++version } }
  })
  const seen = stopEngine(on)

  await stopRelay($, seen)

  expect(seen.runs).toEqual([])
  expect(seen.logs).toEqual([])
  expect(seen.debugs).toEqual([SKIPPED])
  // The relay's two marks are used up, and the other one is left as it was.
  expect(writes).toEqual([{ 'a-old': NOW - 1 }])
})

test('a TaskStop writes its marks in $.state, where a reload keeps them, and drops the lapsed ones', async ($, on) => {
  const writes: unknown[] = []
  on('state.set', (_: unknown, e: any, next: any) => {
    if (e.key === 'stopMarks') writes.push(e.value)
    return next(e)
  })
  const seen = stopEngine(on)

  await $.tool.call({ tool: 'TaskStop', task_id: 'worker' } as any)
  await seen.clock.advance(60001)
  await $.tool.call({ tool: 'TaskStop', task_id: 'b77' } as any)

  expect(writes).toEqual([
    { worker: NOW + 60000, 'a-relay': NOW + 60000 },
    { b77: NOW + 120001 },
  ])
  expect(seen.stops).toHaveLength(2)
})

test("a TaskStop's mark lapses after a minute, and a later stop by a person shows the notice", async ($, on) => {
  const seen = stopEngine(on)

  await $.tool.call({ tool: 'TaskStop', task_id: 'worker' } as any)
  await seen.clock.advance(60001)
  await stopRelay($, seen)

  expect(seen.logs.map((e) => e.text)).toEqual([NOTICE])
  expect(seen.debugs).toEqual([])
})

test('the TaskStop hook passes the call through unchanged and refuses nothing', async ($, on) => {
  const seen = stopEngine(on, { agents: () => ({ deny: 'the session is not bound yet' }) })

  const result = await $.tool.call({ tool: 'TaskStop', task_id: 'worker' } as any)

  expect(result).toMatchObject({ result: STOPPED })
  expect(seen.stops).toHaveLength(1)
  expect(seen.stops[0]).toMatchObject({ tool: 'TaskStop', task_id: 'worker' })
  expect(Object.keys(seen.stops[0]).filter((key) => !['tool', 'task_id', 'tool_use_id'].includes(key))).toEqual([])
})

test('an old job behind a full page of newer ones is found on a later page', async ($, on) => {
  const newer = Array.from({ length: 200 }, (_, at) => relayRow('j-new-' + at, 'a-other-' + at))
  const seen = stopEngine(on, {
    run: (e: any) => {
      const at = e.argv.indexOf('--cursor')
      const cursor = at === -1 ? null : e.argv[at + 1]
      if (cursor === null) return { value: listing(newer, 'c-1') }
      if (cursor === 'c-1') return { value: listing(newer.slice(0, 10), 'c-2') }
      return { value: listing([relayRow('j-1', 'a-relay')]) }
    },
  })

  await stopRelay($, seen)

  expect(seen.runs.map((r) => r.argv)).toEqual([STOP_ARGV, [...STOP_ARGV, '--cursor', 'c-1'], [...STOP_ARGV, '--cursor', 'c-2']])
  expect(seen.logs.map((e) => e.text)).toEqual([NOTICE])
})

test('the notice reads at most ten pages', async ($, on) => {
  let page = 0
  const seen = stopEngine(on, { run: () => ({ value: listing([relayRow('j-x' + page, 'a-other')], 'c-' + ++page) }) })

  await stopRelay($, seen)

  expect(seen.runs).toHaveLength(10)
  expect(seen.logs).toEqual([])
})

test('no notice for another agent type, an unlisted agent, a turn that answered, a relay still running, or a job that ended or died', async ($, on) => {
  let agents: object[] = []
  let jobs: object[] = []
  const seen = stopEngine(on, { agents: () => ({ value: agents }), jobs: () => jobs })
  const cases: [object[], object[], object][] = [
    [[{ ...KILLED, type: 'general-purpose' }], [relayRow('j-1', 'a-relay')], ABORTED],
    // A Workflow's agents are never in the list.
    [[], [relayRow('j-1', 'a-relay')], ABORTED],
    [[KILLED], [relayRow('j-1', 'a-relay')], { ...ABORTED, isAborted: false, reason: 'answer' }],
    [[{ ...KILLED, status: 'running' }], [relayRow('j-1', 'a-relay')], ABORTED],
    [[KILLED], [relayRow('j-1', 'a-relay', 'completed'), relayRow('j-2', 'a-relay', 'cancelled'), relayRow('j-3', 'a-relay', 'failed'), relayRow('j-4', 'a-relay', 'dead')], ABORTED],
    // No job's current relay is the agent.
    [[KILLED], [relayRow('j-1', 'a-other')], ABORTED],
  ]

  for (const [listed, rows, end] of cases) {
    agents = listed
    jobs = rows
    seen.ends.length = 0
    await stopRelay($, seen, end)
  }

  // Only the job that ended and the job of another relay were looked for.
  expect(seen.runs.map((r) => r.argv)).toEqual([STOP_ARGV, STOP_ARGV])
  expect(seen.logs).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('a companion or an agent list that fails shows no notice and leaves the turn as it ended', async ($, on) => {
  let answer: unknown = { deny: 'spawn node ENOENT' }
  let agents: unknown = { value: [KILLED] }
  const seen = stopEngine(on, { run: () => answer, agents: () => agents })

  for (const next of [
    { value: printed('not json') },
    { value: failed('busy', 4) },
    { value: { ...listing([relayRow('j-1', 'a-relay')]), isStdoutTruncated: true } },
    { value: printed(JSON.stringify({ schema: 'relay.result/1', jobs: [relayRow('j-1', 'a-relay')] })) },
  ]) {
    seen.ends.length = 0
    await stopRelay($, seen)
    answer = next
  }
  seen.ends.length = 0
  await stopRelay($, seen)
  agents = { deny: 'the session is not bound yet' }
  seen.ends.length = 0
  await stopRelay($, seen)

  expect(seen.runs).toHaveLength(5)
  expect(seen.logs).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('a relay a person stopped makes every tick read for thirty seconds while the line is cleared', async ($, on) => {
  on('agent.list', () => ({ value: [KILLED] }))
  on('turn.complete', () => ENGINE_END)
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const seen = await statusEngine($, on, { run: () => ({ value: listing([]) }) })
  await seen.clock.advance(5000)
  await seen.clock.advance(5000)
  expect(listings(seen.runs)).toHaveLength(1)

  // The main loop's own interrupted turn is no relay event.
  const { agentId: _, ...mainLoop } = ABORTED
  expect(await $.turn.complete(mainLoop)).toEqual(ENGINE_END)
  await seen.clock.advance(5000)
  expect(listings(seen.runs)).toHaveLength(1)

  expect(await $.turn.complete(ABORTED)).toEqual(ENGINE_END)
  // The notice's own listing runs on its timer, before the ticks are counted.
  await seen.clock.settle()
  await readsForThirty(seen)
})
