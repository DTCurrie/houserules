const CONTINUATION_PREFIX =
  'This session is being continued from a previous conversation';

/**
 * Returns whether one transcript record marks a compaction. Three shapes do: the `system` record
 * whose `subtype` is `compact_boundary`, a record whose `isCompactSummary` is `true`, and a `user`
 * record whose first text starts with the continuation preamble Claude Code writes after a
 * compaction.
 *
 * @param {unknown} record One transcript line already parsed into an object, never the raw JSONL
 *   string.
 * @returns {boolean} `false` for every other value, including `null`, `undefined`, and a record
 *   with no `type`.
 */
export function isCompactionRecord(record) {
  if (record === null || typeof record !== 'object') return false;
  if (typeof record.type !== 'string') return false;
  if (record.type === 'system' && record.subtype === 'compact_boundary') {
    return true;
  }
  if (record.isCompactSummary === true) return true;
  if (record.type !== 'user') return false;
  const text = firstText(record.message?.content);
  return text !== undefined && text.startsWith(CONTINUATION_PREFIX);
}

/** `content` itself when it is a string, else the `text` of its first `text` block. */
function firstText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find((item) => item?.type === 'text');
  return typeof block?.text === 'string' ? block.text : undefined;
}
