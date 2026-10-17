import type {
  Action,
  CheckResult,
  Finding,
  ModuleGroup,
} from '@houserules/api';
import { hookFragment, scriptPermission } from '@houserules/api';
import type { Ctx } from '../detect.js';
import { script } from './copy-actions.js';

export const id = 'tool-output-trim';
export const title =
  'Tool-output trim (PostToolUse hook caps oversized tool results)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'cap oversized Bash and Read results before they reach the model, keeping head and tail (PostToolUse updatedToolOutput, Claude Code 2.1.121+)';
}

export function defaultEnabled(): boolean {
  return false;
}

const SCRIPT_NAME = 'tool-output-trim.mjs';
const MATCHER = 'Bash|Read';

/**
 * A PostToolUse hook that shortens a Bash or Read result over 16 KiB to its head and tail
 * before the model sees it. It changes what the model reads, not what ran.
 */
export function plan(): Action[] {
  return [
    script(
      id,
      SCRIPT_NAME,
      'PostToolUse(Bash|Read): trim a result over 16 KiB to head plus tail',
    ),
    {
      kind: 'merge-settings',
      module: id,
      fragment: {
        ...hookFragment('PostToolUse', MATCHER, SCRIPT_NAME),
        permissions: { allow: [scriptPermission(SCRIPT_NAME)] },
      },
    },
  ];
}

/**
 * Warns when the module is installed but settings.json carries no PostToolUse entry for the
 * trim script, which leaves oversized results reaching the model untrimmed.
 */
export function check(ctx: Ctx): CheckResult {
  const groups = ctx.claude.settings?.hooks?.['PostToolUse'] ?? [];
  const wired = groups.some((entry) =>
    (entry.hooks ?? []).some((hook) =>
      (hook.command ?? '').includes(SCRIPT_NAME),
    ),
  );
  const findings: Finding[] = wired
    ? []
    : [
        {
          level: 'WARN',
          msg: `tool-output-trim is installed but settings.json has no PostToolUse entry for ${SCRIPT_NAME} — run npx houserules update to restore it`,
        },
      ];
  return { findings, readouts: [] };
}
