// The probe's hooks, run by `claude plugin test scripts/live/probes/wake-probe`. The kit runs only
// *.test.ts files, so this one is TypeScript while the module is JavaScript.
//
// The hooks registered here sit beneath the plugin and stand for the engine. The engine skips a
// hook that throws and goes on without it, so each test proves the probe's hook ran: the tool
// call never reaches the engine's own `tool.call` beneath, and the answer is the probe's text.
import { expect, test } from 'claude-code/testing'

const TOOL = 'mcp__wake-probe__send'
const START = { cwd: '/', surface: 'terminal' as const, isInteractive: true }
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

type Options = {
  sent?: () => unknown
}

// The engine beneath the plugin: tool registration, session start, sends and its own tool.call,
// each recording what reached it.
function engine(on: any, options: Options = {}) {
  const registered: unknown[] = []
  const starts: unknown[] = []
  const sends: unknown[] = []
  const calls: unknown[] = []
  on('tool.register', (_: unknown, e: unknown) => {
    registered.push(e)
    return { value: { tool: TOOL } }
  })
  on('session.start', (_: unknown, e: any) => {
    starts.push(e)
    return { cwd: e.cwd }
  })
  on('session.send', (_: unknown, e: unknown) => {
    sends.push(e)
    return options.sent ? options.sent() : { isDelivered: true }
  })
  on('tool.call', (_: unknown, e: unknown) => {
    calls.push(e)
    return { result: 'answered by the engine' }
  })
  return { registered, starts, sends, calls }
}

// The probe's answer parsed into its fields, so a test can check the time it took.
function fields(text: string) {
  const match = /^wake-probe sentAt=(\S+) to=(\S+) delivered=(true|false)(?: reason=(.*))?$/.exec(text)
  return match ? { sentAt: match[1], to: match[2], delivered: match[3], reason: match[4] } : null
}

test('session.start registers the send tool in front of ToolSearch and goes on', async ($, on) => {
  const seen = engine(on)

  expect(await $.session.start(START)).toEqual({ cwd: '/' })

  expect(seen.registered).toEqual([
    {
      name: 'send',
      description: expect.stringContaining('$.session.send'),
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: expect.any(String) },
          text: { type: 'string', description: expect.any(String) },
        },
        required: ['to', 'text'],
      },
      isDeferred: false,
    },
  ])
  expect(seen.starts).toHaveLength(1)
})

test('a call with to and text sends them once and answers delivered=true with the time it sent', async ($, on) => {
  const seen = engine(on)
  const before = Date.now()

  const answer: any = await $.tool.call({ tool: TOOL, to: 'steer-codex', text: 'steer from a plugin for codex' })

  expect(seen.sends).toEqual([
    { to: 'steer-codex', text: 'steer from a plugin for codex', origin: { kind: 'plugin', name: 'wake-probe' } },
  ])
  expect(seen.calls).toHaveLength(0)
  const parsed = fields(answer.result)
  expect(parsed).toEqual({ sentAt: expect.stringMatching(ISO), to: 'steer-codex', delivered: 'true', reason: undefined })
  const sentAt = Date.parse(parsed!.sentAt)
  expect(sentAt >= before - 1000 && sentAt <= Date.now() + 1000).toBe(true)
})

test('a refused send answers delivered=false with the engine reason', async ($, on) => {
  const seen = engine(on, { sent: () => ({ isDelivered: false, reason: 'no agent named steer-ghost' }) })

  const answer: any = await $.tool.call({ tool: TOOL, to: 'steer-ghost', text: 'hello' })

  expect(seen.sends).toHaveLength(1)
  expect(seen.calls).toHaveLength(0)
  expect(fields(answer.result)).toEqual({
    sentAt: expect.stringMatching(ISO),
    to: 'steer-ghost',
    delivered: 'false',
    reason: 'no agent named steer-ghost',
  })
})

test('missing or non-string input answers the usage text and sends nothing', async ($, on) => {
  const seen = engine(on)
  const bad = [
    { text: 'no recipient' },
    { to: 'steer-codex' },
    { to: 42, text: 'a number for a name' },
    { to: 'steer-codex', text: { message: 'an object' } },
    {},
  ]

  for (const input of bad) {
    const answer: any = await $.tool.call({ tool: TOOL, ...input })
    expect(answer).toEqual({ result: expect.stringMatching(/^wake-probe usage: .*Nothing was sent\.$/) })
  }

  expect(seen.sends).toHaveLength(0)
  expect(seen.calls).toHaveLength(0)
})

test('a send that rejects answers the error and the hook does not throw', async ($, on) => {
  const seen = engine(on, {
    sent: () => {
      throw new Error('the session is not bound yet')
    },
  })

  const answer: any = await $.tool.call({ tool: TOOL, to: 'steer-codex', text: 'hello' })

  expect(seen.calls).toHaveLength(0)
  expect(answer).toEqual({
    result: expect.stringMatching(/^wake-probe sentAt=\S+ to=steer-codex error=.+$/),
  })
})
