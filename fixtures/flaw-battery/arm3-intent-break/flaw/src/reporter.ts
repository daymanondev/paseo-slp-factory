/**
 * The upload outcome for one delivered report.
 */
export function outcomeFor(status: number): "sent" | "failed" {
  // Sent ONLY on a 2xx status: a 3xx redirect means the report did not
  // land where it was addressed — that is a failure.
  return status >= 200 && status < 400 ? "sent" : "failed";
}
