/** The most words a changeset summary may carry. */
export const SUMMARY_WORD_LIMIT = 20;

/** Words in a summary: the trimmed text split on whitespace. */
export function countSummaryWords(summary: string): number {
  const trimmed = summary.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
