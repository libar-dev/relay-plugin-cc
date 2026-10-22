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

// The four commands the module answers itself. A test raises each as a person's command through
// the engine's `$.command.run`; nothing beneath answers a command, so every text below is the
// module's, and each test proves the hook ran by the argv it ran or by the session it read.

const CWD = '/work/repo'
const SESSION = 'b982d28e-9bd5-4091-ae88-c3c557b54f01'

type CommandOptions = {
  cwd?: () => unknown
  id?: () => unknown
  run?: (e: any) => unknown
}

// The engine beneath the plugin for a command: the session's directory and id, and a process
// runner that answers the companion's output, each recording what reached it.
function companion(on: any, options: CommandOptions = {}) {
  const runs: any[] = []
  const reads: string[] = []
  on('session.cwd', () => {
    reads.push('cwd')
    return options.cwd ? options.cwd() : { value: CWD }
  })
  on('session.id', () => {
    reads.push('id')
    return options.id ? options.id() : { value: SESSION }
  })
  on('process.run', (_: unknown, e: any) => {
    runs.push(e)
    return options.run ? options.run(e) : { value: printed('state: completed\n') }
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

test('each command runs the companion by argv with its cwd and timeout, and transfer with the session id', async ($, on) => {
  const seen = companion(on)

  await $.command.run(command('relay:status'))
  await $.command.run(command('relay:result'))
  await $.command.run(command('relay:cancel'))
  await $.command.run(command('relay:transfer'))

  expect(seen.runs).toEqual([
    { argv: companionArgv('status'), init: { cwd: CWD, timeoutMs: 30000 } },
    { argv: companionArgv('result'), init: { cwd: CWD, timeoutMs: 30000 } },
    { argv: companionArgv('cancel'), init: { cwd: CWD, timeoutMs: 60000 } },
    {
      argv: companionArgv('transfer'),
      init: { cwd: CWD, timeoutMs: 180000, env: { RELAY_COMPANION_SESSION_ID: SESSION } },
    },
  ])
  // Only transfer reads the session's id.
  expect(seen.reads).toEqual(['cwd', 'cwd', 'cwd', 'cwd', 'id'])
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

test('a state block shows verbatim in a code block and the report after it as Markdown', async ($, on) => {
  const seen = companion(on, { run: () => ({ value: printed('state: completed\njob: j-1\n---\n# Done\n') }) })

  const result = await $.command.run(command('relay:result', 'j-1'))

  expect(seen.runs.map((r) => r.argv)).toEqual([companionArgv('result', 'j-1')])
  expect(result).toEqual({ text: '\n```text\nstate: completed\njob: j-1\n```\n---\n# Done\n', exitCode: 0 })
})

test('only the first --- line splits; a later one stays in the report', async ($, on) => {
  companion(on, { run: () => ({ value: printed('state: completed\n---\n# Report\n\n---\n\nmore\n') }) })

  const result = await $.command.run(command('relay:result'))

  expect(result).toEqual({ text: '\n```text\nstate: completed\n```\n---\n# Report\n\n---\n\nmore\n', exitCode: 0 })
})

test('a status listing with no --- line is all verbatim, and a missing final newline is added', async ($, on) => {
  const listing = 'jobs-home: /h\nrepo: /r\njobs: 1\n\n| job | state |\n|-----|-------|\n| j-1 | done  |'
  const seen = companion(on, { run: () => ({ value: printed(listing) }) })

  const result = await $.command.run(command('relay:status'))

  expect(seen.runs.map((r) => r.argv)).toEqual([companionArgv('status')])
  expect(result).toEqual({ text: '\n```text\n' + listing + '\n```\n', exitCode: 0 })
})

test('stderr alone shows verbatim with the exit code, as a busy job does', async ($, on) => {
  const seen = companion(on, { run: () => ({ value: printed('', 'Job j-1 is busy: a turn is running. Try again.\n', 4) }) })

  const result = await $.command.run(command('relay:result', 'j-1'))

  expect(seen.runs).toHaveLength(1)
  expect(result).toEqual({ text: '\n```text\nJob j-1 is busy: a turn is running. Try again.\n```\n', exitCode: 4 })
})

test('stdout and stderr show together, stderr on a line of its own', async ($, on) => {
  companion(on, { run: () => ({ value: printed('state: failed', 'warning: stale lock\n', 1) }) })

  const result = await $.command.run(command('relay:cancel', 'j-1'))

  expect(result).toEqual({ text: '\n```text\nstate: failed\nwarning: stale lock\n```\n', exitCode: 1 })
})

test('a backtick run in the verbatim part gets a longer fence', async ($, on) => {
  companion(on, {
    run: () => ({ value: printed('summary: use ``` fences\n---\nreport with ````` five\n') }),
  })

  const result = await $.command.run(command('relay:result'))

  // The report is not fenced, so only the verbatim part's run counts.
  expect(result).toEqual({ text: '\n````text\nsummary: use ``` fences\n````\n---\nreport with ````` five\n', exitCode: 0 })
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
  const text = '\n```text\nstate: x\n```\n'
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
    text: '\n/relay:status ended without an exit code. Run `node "' + seen.runs[0].argv[1] + '" status --all` in a shell to see its output.',
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
      '\n/relay:status printed more than 4 MiB on ' + streams[i] + ', more than Claude Code passes to a plugin, so none of it is shown. Run `node "' + seen.runs[i].argv[1] + '" status` in a shell to read it.',
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
  expect(result.text).toMatch(/^\n\/relay:status printed nothing \(exit 0\)\. /)
  expect(result.text).toMatch(shell('status'))
})

test('a run that does not finish answers an error text, and a cancel says it may have gone through', async ($, on) => {
  const seen = companion(on, { run: () => ({ deny: 'timed out after 60000 ms' }) })

  const status: any = await $.command.run(command('relay:status'))
  const cancel: any = await $.command.run(command('relay:cancel', 'j-1'))

  expect(seen.runs.map((r) => r.argv)).toEqual([companionArgv('status'), companionArgv('cancel', 'j-1')])
  expect(status.exitCode).toBe(1)
  expect(status.text).toMatch(/^\n\/relay:status did not finish: .*timed out after 60000 ms.*\. Run `node "[^"]*" status` in a shell to see its output\.$/)
  expect(cancel.exitCode).toBe(1)
  expect(cancel.text).toMatch(
    /^\n\/relay:cancel did not finish: .*timed out after 60000 ms.*\. Run `node "[^"]*" cancel j-1` in a shell to see its output\. The cancel may have gone through anyway; \/relay:status shows the job's state\.$/,
  )
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

  expect(seen.reads).toEqual(['cwd', 'cwd', 'id'])
  expect(seen.runs).toHaveLength(0)
  expect(cancel.exitCode).toBe(1)
  // The cancel never started, so the text does not say it may have gone through.
  expect(cancel.text).toMatch(/^\n\/relay:cancel did not finish: .*no session directory.*\. Run `node "[^"]*" cancel j-1` in a shell to see its output\.$/)
  expect(transfer.exitCode).toBe(1)
  expect(transfer.text).toMatch(/^\n\/relay:transfer did not finish: .*no session id.*\. Run `node "[^"]*" transfer` in a shell to see its output\.$/)
})

test('a hook that fails is answered by its .catch, never by the markdown command', async ($, on) => {
  // A run that answers no result makes the hook throw outside its own error handling.
  const seen = companion(on, { run: () => ({ value: null }) })

  const result: any = await $.command.run(command('relay:result', 'j-1'))

  expect(seen.runs.map((r) => r.argv)).toEqual([companionArgv('result', 'j-1')])
  expect(result.exitCode).toBe(1)
  expect(result.text).toMatch(/^\nThe relay module failed while answering \/relay:result: .+\. Run `node "[^"]*" result j-1` in a shell to see its output\.$/)
})
