import type {
  HookEntry,
  HookGroup,
  SettingsFragment,
} from './merge-settings.js';

/**
 * The shell command that runs one hook script, guarded so a missing script degrades to an
 * actionable line instead of a raw MODULE_NOT_FOUND stack trace. `.claude/scripts/` is
 * generated and gitignored, so a fresh clone legitimately has none until
 * `houserules update` runs, while settings.json is committed. That is why the guard lives
 * in the command rather than in a script.
 *
 * `exec` is load-bearing. It replaces the shell, so node's exit code reaches the hook
 * runner untouched and the `||` branch becomes unreachable. With a plain `node` any
 * non-zero exit would fall through to the echo, printing a false "missing" notice and
 * swallowing the code. changeset-check.mjs exits 2 on purpose to nudge Claude, so that
 * form would have silently disabled the changeset nudge.
 */
export function hookCommand(scriptName: string): string {
  const path = `"$CLAUDE_PROJECT_DIR/.claude/scripts/${scriptName}"`;
  // The fallback goes to stderr with a non-zero exit: on context-bearing events, stdout at
  // exit 0 is injected into the model's context, so a plain echo turned the notice into
  // fake hook output. Exit 1 surfaces it as the harness's non-blocking error instead.
  return `[ -f ${path} ] && exec node ${path} || { echo "[houserules] ${scriptName} missing. Run: npx houserules update" >&2; exit 1; }`;
}

/** One settings fragment carrying a single hook entry. */
export function hookFragment(
  event: string,
  matcher: string | null,
  scriptName: string,
  statusMessage?: string,
): SettingsFragment {
  const hook: HookEntry = { type: 'command', command: hookCommand(scriptName) };
  if (statusMessage) hook.statusMessage = statusMessage;
  const group: HookGroup = matcher
    ? { matcher, hooks: [hook] }
    : { hooks: [hook] };
  return { hooks: { [event]: [group] } };
}

export function scriptPermission(scriptName: string): string {
  return `Bash(node .claude/scripts/${scriptName}:*)`;
}
