// A POSIX shell assignment: its value is one literal word, including quotes and newlines.
export function shellAssignment(name, value) {
  return `${name}='${String(value).replaceAll("'", "'\\''")}'`;
}

// Inline Markdown normalizes newlines and backticks can close its delimiter.
// Use a fenced block for either, preserving the command when copied.
export function shellCommandMarkdown(command) {
  if (!/[`\r\n]/.test(command)) return `\`${command}\``;
  const longest = Math.max(0, ...[...command.matchAll(/`+/g)].map(match => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `\n${fence}bash\n${command}\n${fence}\n`;
}
