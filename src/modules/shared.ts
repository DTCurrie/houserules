// Tiny action factories shared by the modules (claude-kit CLI).
import { payloadPath } from '../paths.js';
import type {
  CopyAction,
  HookEntry,
  HookGroup,
  SettingsFragment,
} from '../types.js';

export function script(
  module: string,
  name: string,
  reason: string,
): CopyAction {
  return {
    kind: 'copy',
    src: payloadPath('scripts', name),
    dest: `.claude/scripts/${name}`,
    mode: 0o755,
    module,
    reason,
  };
}

export function lib(module: string, name: string): CopyAction {
  return {
    kind: 'copy',
    src: payloadPath('scripts', 'lib', name),
    dest: `.claude/scripts/lib/${name}`,
    module,
    reason: 'shared script library',
  };
}

export function skill(
  module: string,
  name: string,
  reason: string,
): CopyAction {
  return {
    kind: 'copy',
    src: payloadPath('skills', name, 'SKILL.md'),
    dest: `.claude/skills/${name}/SKILL.md`,
    module,
    reason,
  };
}

export function agent(
  module: string,
  name: string,
  reason: string,
): CopyAction {
  return {
    kind: 'copy',
    src: payloadPath('agents', `${name}.md`),
    dest: `.claude/agents/${name}.md`,
    module,
    reason,
  };
}

// A Claude Code rule file (.claude/rules/<name>.md). Claude Code loads this
// directory as memory: a rule whose frontmatter carries `paths:` globs loads only
// when a matching file is in the working set; one WITHOUT `paths:` is resident on
// every turn. Kit rules always carry `paths:`.
export function rule(module: string, name: string, reason: string): CopyAction {
  return {
    kind: 'copy',
    src: payloadPath('rules', `${name}.md`),
    dest: `.claude/rules/${name}.md`,
    module,
    reason,
  };
}

// Stage a raw kit-templates/<rel> file for hand-instantiation. `rel` is a
// forward-slash path relative to payload/kit-templates (e.g. 'agents/foo.template').
export function template(
  module: string,
  rel: string,
  reason = 'reference template',
): CopyAction {
  return {
    kind: 'copy',
    src: payloadPath('kit-templates', ...rel.split('/')),
    dest: `.claude/kit-templates/${rel}`,
    module,
    reason,
  };
}

// Guarded so a missing script degrades to an actionable line instead of a raw
// MODULE_NOT_FOUND stack trace — `.claude/scripts/` is generated and gitignored, so a
// fresh clone legitimately has none until `claude-kit update` runs. settings.json IS
// committed, which is why the guard lives in the command rather than in a script.
//
// `exec` is load-bearing: it replaces the shell, so node's exit code reaches the hook
// runner untouched and the `||` branch becomes unreachable. With a plain `node`, any
// non-zero exit would fall through to the echo — printing a false "missing" notice and
// swallowing the code. changeset-check.mjs exits 2 deliberately to nudge Claude, so
// that form would have silently disabled the changeset nudge.
export function hookCommand(scriptName: string): string {
  const path = `"$CLAUDE_PROJECT_DIR/.claude/scripts/${scriptName}"`;
  return `[ -f ${path} ] && exec node ${path} || echo "[kit] ${scriptName} missing — run: npx claude-kit update"`;
}

// One settings fragment with a single hook entry.
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
