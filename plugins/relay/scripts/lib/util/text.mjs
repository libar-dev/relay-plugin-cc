// Cut text to at most `limit` code points. Cutting by UTF-16 unit can split a surrogate
// pair, and the app-server never answers a thread name with a lone surrogate.
export function truncateCodePoints(text, limit) {
  const codePoints = Array.from(String(text ?? ""));
  if (codePoints.length <= limit) {
    return codePoints.join("");
  }
  return `${codePoints.slice(0, Math.max(0, limit - 3)).join("")}...`;
}
