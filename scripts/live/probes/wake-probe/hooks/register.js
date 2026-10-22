// The tool mcp__wake-probe__send: sends a message to an agent with $.session.send, the path a
// plugin's button takes, and answers with what Claude Code reported. Phase 1's probe was a slash
// command, which only the person can type; a tool lets one prompt drive a whole live run.

const TOOL = {
  name: 'send',
  description:
    "Sends a message to an agent with $.session.send, the path another plugin's button takes, for relay's live suite. " +
    '`to` is the agent\'s name or id, `text` the message. Answers with the time it sent and whether Claude Code delivered it.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'The agent to send to, by name or id.' },
      text: { type: 'string', description: 'The message to send.' },
    },
    required: ['to', 'text'],
  },
  // Kept in front so the model can call it without a ToolSearch first.
  isDeferred: false,
}

const USAGE = 'wake-probe usage: send({ to, text }), both non-empty strings. Nothing was sent.'

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.tool.register(TOOL)
    return next(e)
  })

  // A registered tool's arguments arrive flat on `e`, beside `tool` and `tool_use_id`.
  on('tool.call', { tool: 'mcp__wake-probe__send' }, async ($, e) => {
    const { to, text } = e
    if (typeof to !== 'string' || typeof text !== 'string' || to === '' || text === '') {
      return { result: USAGE }
    }
    // Taken before the send, so the suite measures the whole path from here to the relay's ledger.
    const sentAt = new Date().toISOString()
    try {
      const sent = await $.session.send({ to, text })
      const reason = sent.isDelivered ? '' : ` reason=${sent.reason}`
      return { result: `wake-probe sentAt=${sentAt} to=${to} delivered=${sent.isDelivered === true}${reason}` }
    } catch (error) {
      // A throw would make the engine skip this hook, and a call no hook answers fails without
      // saying why; the error as the answer tells the lead what went wrong.
      return { result: `wake-probe sentAt=${sentAt} to=${to} error=${error?.message ?? String(error)}` }
    }
  }).catch(($, e, next) => ({
    // Only an overrun or a lost hooks worker reaches here; the call is still answered.
    result: `wake-probe error=${next.error.kind}${next.error.message ? `: ${next.error.message}` : ''}`,
  }))
}
