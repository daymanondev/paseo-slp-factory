/**
 * Health-check helpers.
 */
export function ok(code: number): boolean {
  return code >= 200 && code < 300;
}
