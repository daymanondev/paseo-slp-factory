/**
 * Hashtag helpers for the annotator.
 */
export function tag(word: string): string {
  const clean = word.trim().replace(/^#+/, "");
  return `#${clean}`;
}
