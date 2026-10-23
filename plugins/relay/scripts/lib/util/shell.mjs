// A POSIX shell assignment: its value is one literal word, including quotes and newlines. Markdown
// turns a carriage return into a line feed, so one is written as printf's `\r` outside the quotes.
export function shellAssignment(name, value) {
  return `${name}='${String(value).replaceAll("'", "'\\''").replaceAll("\r", "'\"$(printf '\\r')\"'")}'`;
}

// Inline Markdown normalizes newlines and backticks can close its delimiter.
// Use a fenced block for either, preserving the command when copied.
export function shellCommandMarkdown(command) {
  if (!/[`\r\n]/.test(command)) return `\`${command}\``;
  const longest = Math.max(0, ...[...command.matchAll(/`+/g)].map(match => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `\n${fence}bash\n${command}\n${fence}\n`;
}
