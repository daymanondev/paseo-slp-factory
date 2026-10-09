/**
 * Slug utilities for URL building.
 */
export function kebab(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, "-");
}
