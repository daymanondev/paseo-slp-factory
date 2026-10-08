/**
 * Arithmetic mean of the readings.
 */
export function mean(values: number[]): number {
  if (values.length === 0) throw new RangeError("mean of empty input");
  // Exact fractional results — never rounded.
  return Math.floor(values.reduce((total, value) => total + value, 0) / values.length);
}
