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
const shell = (sub: string) => new RegExp('Run `node "/[^"]*/scripts/companion\\.mjs" ' + sub + '` in a shell')

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
    text: '/relay:status --all\n\nEnded without an exit code. Run `node "' + seen.runs[0].argv[1] + '" status --all` in a shell to see its output.',
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
      '/relay:status\n\nPrinted more than 4 MiB on ' + streams[i] + ', more than Claude Code passes to a plugin, so none of it is shown. Run `node "' + seen.runs[i].argv[1] + '" status` in a shell to read it.',
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
  expect(status.text).toMatch(/^\/relay:status\n\nDid not finish: .*timed out after 30000 ms.*\. Run `node "[^"]*" status` in a shell to see its output\.$/)
  expect(cancel.exitCode).toBe(1)
  expect(cancel.text).toMatch(
    /^\/relay:cancel j-1\n\nDid not finish: .*timed out after 60000 ms.*\. Run `node "[^"]*" cancel j-1` in a shell to see its output\. The cancel may have gone through anyway; \/relay:status shows the job's state\.$/,
  )
  // A process that could not start cancelled nothing.
  expect(unstarted.exitCode).toBe(1)
  expect(unstarted.text).toMatch(/^\/relay:cancel j-2\n\nDid not finish: .*spawn node ENOENT.*\. Run `node "[^"]*" cancel j-2` in a shell to see its output\.$/)
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
  expect(cancel.text).toMatch(/^\/relay:cancel j-1\n\nDid not finish: .*no session directory.*\. Run `node "[^"]*" cancel j-1` in a shell to see its output\.$/)
  expect(transfer.exitCode).toBe(1)
  expect(transfer.text).toMatch(/^\/relay:transfer\n\nDid not finish: .*no session id.*\. Run `node "[^"]*" transfer` in a shell to see its output\.$/)
})

test('a hook that fails is answered by its .catch, never by the markdown command', async ($, on) => {
  // A run that answers no result makes the hook throw outside its own error handling.
  const seen = companion(on, { run: () => ({ value: null }) })

  const result: any = await $.command.run(command('relay:result', 'j-1'))

  expect(seen.runs.map((r) => r.argv)).toEqual([companionArgv('result', 'j-1')])
  expect(result.exitCode).toBe(1)
  expect(result.text).toMatch(/^\/relay:result j-1\n\nThe relay module failed while answering it: .+\. Run `node "[^"]*" result j-1` in a shell to see its output\.$/)
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
  surfaces?: () => string[]
  run?: () => unknown
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
    return { value: options.surfaces ? options.surfaces() : ['terminal'] }
  })
  on('process.run', (_: unknown, e: any) => {
    runs.push(e)
    return options.run ? options.run() : { value: listing([]) }
  })
  on('ui.status', (_: unknown, e: any) => {
    lines.push(e.text)
    return { value: undefined }
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
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
  const seen = await statusEngine($, on)

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

test('with more pages, the running count carries a +', async ($, on) => {
  const seen = await statusEngine($, on, {
    run: () => ({ value: listing([job('j-3', 'running'), job('j-2', 'running'), job('j-1', 'dead')], 'WyJ4IiwiaiJd') }),
  })

  await seen.clock.advance(5000)

  expect(seen.lines).toEqual(['2+ running · 1 dead'])
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
