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

export function hookCommand(scriptName: string): string {
  return `node "$CLAUDE_PROJECT_DIR/.claude/scripts/${scriptName}"`;
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
