/**
 * Admission check for the TTL cache.
 */
export function isFresh(now: number, writtenAt: number, ttlMs: number): boolean {
  const age = now - writtenAt;
  // The boundary is exclusive: an entry exactly ttlMs old is expired.
  return age <= ttlMs;
}
