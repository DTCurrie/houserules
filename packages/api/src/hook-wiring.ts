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
 *
 * The fallback depends on the event, because the harness treats each event's output
 * differently. See {@link HookFallback} and {@link fallbackForEvent}.
 */
export function hookCommand(
  scriptName: string,
  fallback: HookFallback = 'guard',
): string {
  const path = `"$CLAUDE_PROJECT_DIR/.claude/scripts/${scriptName}"`;
  const unsynced = `this install's generated files are not synced yet. Run your dependency install (npm install, pnpm install, or yarn), or houserules update for a global CLI`;
  const hintNotice = `[houserules] ${scriptName}: ${unsynced}.`;
  const guardNotice = `[houserules] ${scriptName}: ${unsynced}. This call is blocked until then.`;
  const head = `[ -f ${path} ] && exec node ${path}`;
  if (fallback === 'silent') return `${head} || exit 0`;
  if (fallback === 'hint')
    return `${head} || { echo "${hintNotice}"; exit 0; }`;
  if (fallback === 'bootstrap') {
    const localBinary = '"$CLAUDE_PROJECT_DIR/node_modules/.bin/houserules"';
    const sync = 'update --sync "$CLAUDE_PROJECT_DIR"';
    // `update --sync` exits 0 on every path, so its one output line is the only signal of
    // whether it wrote. The restart line follows a `synced` line and nothing else.
    return [
      `${head} || {`,
      `if [ -x ${localBinary} ]; then out=$(${localBinary} ${sync});`,
      `elif command -v houserules >/dev/null 2>&1; then out=$(houserules ${sync});`,
      `else echo "[houserules] ${scriptName} is not synced yet. Run your dependency install (npm install, pnpm install, or yarn) to sync this install.";`,
      `fi;`,
      `case "$out" in "[houserules] synced"*) echo "$out"; echo "[houserules] Restart the session so the synced skills, rules, and agents load.";; ?*) echo "$out";; esac;`,
      `exit 0; }`,
    ].join(' ');
  }
  return `${head} || { echo "${guardNotice}" >&2; exit 1; }`;
}

/**
 * What a hook command does when its script is absent. `guard` prints the notice to stderr
 * and exits 1. The guard hooks carry `onFailure: 'block'`, so the call is blocked until the
 * script is restored. `hint` prints the notice to stdout and exits 0, so a SessionStart hook
 * hands Claude the notice as context, since the stderr notice of a fresh clone is never read.
 * `silent` prints nothing and exits 0. `bootstrap` is the `payload-sync` hook's alone: with its
 * script absent it runs the installed CLI's `update --sync` (the local `node_modules/.bin` binary,
 * else a `houserules` on PATH), prints the install hint when neither exists, never calls `npx`,
 * and always exits 0.
 */
export type HookFallback = 'guard' | 'hint' | 'silent' | 'bootstrap';

/** The fallback each event gets: PreToolUse guards, SessionStart hints, the rest stay silent. */
export function fallbackForEvent(event: string): HookFallback {
  if (event === 'PreToolUse') return 'guard';
  if (event === 'SessionStart') return 'hint';
  return 'silent';
}

const GUARDED_HOOK_COMMAND_RE = /^\[ -f \S+ \] && exec node \S+ \|\| /;

/** True for every wrapper form `hookCommand` can emit, whatever its fallback. */
export function isGuardedHookCommand(command: string): boolean {
  return GUARDED_HOOK_COMMAND_RE.test(command.trim());
}

/**
 * The harness-level fields a hook entry can carry beyond `command` and `statusMessage`:
 * a conditional guard, a timeout in seconds, and whether the hook runs asynchronously.
 */
export interface HookFragmentOptions {
  if?: string;
  timeout?: number;
  async?: boolean;
  /**
   * `block` makes a hook that cannot start, times out, or exits unexpectedly stop the
   * action instead of letting it through. Only the guard hooks set it.
   */
  onFailure?: 'block';
  /**
   * Overrides the fallback {@link fallbackForEvent} picks for the event. Only the
   * `payload-sync` hook passes one, `'bootstrap'`.
   */
  fallback?: HookFallback;
}

/** One settings fragment carrying a single hook entry. */
export function hookFragment(
  event: string,
  matcher: string | null,
  scriptName: string,
  statusMessage?: string,
  options?: HookFragmentOptions,
): SettingsFragment {
  const hook: HookEntry = {
    type: 'command',
    command: hookCommand(
      scriptName,
      options?.fallback ?? fallbackForEvent(event),
    ),
  };
  if (statusMessage) hook.statusMessage = statusMessage;
  if (options?.if !== undefined) hook.if = options.if;
  if (options?.timeout !== undefined) hook.timeout = options.timeout;
  if (options?.async !== undefined) hook.async = options.async;
  if (options?.onFailure !== undefined) hook.onFailure = options.onFailure;
  const group: HookGroup = matcher
    ? { matcher, hooks: [hook] }
    : { hooks: [hook] };
  return { hooks: { [event]: [group] } };
}

/**
 * The payload script every dispatched event's single settings entry runs. It reads the event
 * from stdin's `hook_event_name`, so its command takes no argument and stays the same for
 * every event apart from the fallback.
 */
export const HOOK_DISPATCH_SCRIPT = 'hook-dispatch.mjs';

/**
 * Where the dispatcher reads its wiring, relative to the repo root. It sits in the generated
 * payload, so a release that adds, drops, or rewires a hook changes this file and leaves the
 * tracked `settings.json` alone.
 */
export const HOOK_WIRING_PATH = '.claude/scripts/hook-wiring.json';

/** One dispatched hook: what a per-script settings entry carried before dispatch. */
export interface HookWiringEntry {
  /** A basename under `.claude/scripts/`, such as `guard-bash.mjs`. */
  script: string;
  /**
   * Harness matcher syntax. Absent, empty, or `*` matches every input. A value of only
   * letters, digits, `_`, and `|` is an exact list. Anything else is a JavaScript regex.
   */
  matcher?: string;
  /** Seconds. The dispatcher kills the hook past it and counts that as a failure. */
  timeout?: number;
  onFailure?: 'block';
  statusMessage?: string;
}

/** The file at {@link HOOK_WIRING_PATH}: each event's hooks, in plan order. */
export interface HookWiring {
  version: 1;
  events: Record<string, HookWiringEntry[]>;
}

export function scriptPermission(scriptName: string): string {
  return `Bash(node .claude/scripts/${scriptName}:*)`;
}
