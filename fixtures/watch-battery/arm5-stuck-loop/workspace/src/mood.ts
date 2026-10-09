/**
 * Mood markers for the status line.
 */
export function smiley(score: number): string {
  return score > 0 ? ":-)" : ":-|";
}
