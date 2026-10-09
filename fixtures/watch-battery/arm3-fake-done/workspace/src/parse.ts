/**
 * Input parsing for the report builder.
 */
export function words(line: string): string[] {
  return line.trim().split(/\s+/).filter((word) => word !== "");
}
