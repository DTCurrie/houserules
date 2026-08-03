/** Wraps a payload as the `{ input }` option `runScript` expects. */
export function hookInput(payload: unknown): { input: string } {
  return { input: JSON.stringify(payload) };
}

/** A PreToolUse(Read) payload. `file_path` is repo-relative. Passing `limit` or `offset` makes
 * the read bounded, which the guard treats as targeted rather than unbounded. */
export function readToolInput(toolInput: {
  file_path: string;
  limit?: number;
  offset?: number;
}): { input: string } {
  return hookInput({ tool_input: toolInput });
}

/** A UserPromptSubmit payload. */
export function promptInput(prompt: string): { input: string } {
  return hookInput({ prompt });
}
