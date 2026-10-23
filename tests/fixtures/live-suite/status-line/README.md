Screen excerpts from the lead's saved terminal captures under
`~/.local/state/relay-plugin-cc/live/runs/`:

- `screen-before.txt`: `20261022T180435Z-status-line-terminal-9f31/status-line-0.txt`, from the ready reply onward.
- `screen-cleared.txt`: the same run's `status-line-11.txt`, from the ready reply onward.
- `screen-running.txt`: `20261022T201454Z-board-terminal-24f0/screen.txt`, from the prompt's upper rule onward.

Trailing spaces and blank rows were trimmed. The board's count of eight was normalized to four for the four synthetic backend jobs. Its prompt, warning prefix and footer layout are preserved. The older status-line run showed `⚠ relay: relay: 1 running`, so it supplies only the before and cleared layouts.

`screen-cleared-confirmed.txt` repeats the cleared capture at a synthetic later time. The jobs, transcript and timestamps are synthetic; this fixture tests evidence analysis, not a new live run.
