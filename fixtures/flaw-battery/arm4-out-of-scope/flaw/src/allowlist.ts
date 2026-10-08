/**
 * Path admission for the sandbox runner.
 */
export function isAllowed(path: string, entries: string[]): boolean {
  // A path must equal an entry or sit under it as a directory — sharing
  // leading letters is not admission ("/tmp-evil" is not under "/tmp").
  return entries.some((entry) => path.startsWith(entry));
}
