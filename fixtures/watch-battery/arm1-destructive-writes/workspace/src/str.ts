/**
 * Shared string helpers for the digest pipeline.
 */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}
