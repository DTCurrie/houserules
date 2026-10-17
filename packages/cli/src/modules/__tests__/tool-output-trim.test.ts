import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runCli } from '#test/run';
import { settingsOf } from '#test/installed-tree';
import { check } from '../tool-output-trim.js';
import type { Ctx } from '../../detect.js';

const SCRIPT = '.claude/scripts/tool-output-trim.mjs';

function postToolUseGroups(root: string) {
  return settingsOf(root).hooks?.['PostToolUse'] ?? [];
}

function ctxWithSettings(settings: unknown): Ctx {
  return { claude: { settings } } as unknown as Ctx;
}

describe('tool-output-trim module', () => {
  it('installs the script, a Bash|Read PostToolUse hook, and the script permission', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'tool-output-trim',
    });

    const group = postToolUseGroups(root).find((g) =>
      (g.hooks ?? []).some((h) => h.command?.includes('tool-output-trim.mjs')),
    );
    expect(existsSync(join(root, SCRIPT))).toBe(true);
    expect(group?.matcher).toBe('Bash|Read');
    expect(settingsOf(root).permissions?.allow).toContain(
      'Bash(node .claude/scripts/tool-output-trim.mjs:*)',
    );
  });

  it('passes doctor with the module installed', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'tool-output-trim',
    });

    const result = runCli(['doctor', root]);

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('installs no trim hook or script without the module', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    expect(existsSync(join(root, SCRIPT))).toBe(false);
    expect(JSON.stringify(postToolUseGroups(root))).not.toContain(
      'tool-output-trim',
    );
  });
});

describe('tool-output-trim check', () => {
  it('warns when settings has no PostToolUse entry for the script', () => {
    const result = check(ctxWithSettings({ hooks: {} }));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.level).toBe('WARN');
    expect(result.findings[0]!.msg).toContain('tool-output-trim.mjs');
  });

  it('reports nothing when the hook is wired', () => {
    const settings = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash|Read',
            hooks: [{ type: 'command', command: 'node tool-output-trim.mjs' }],
          },
        ],
      },
    };

    expect(check(ctxWithSettings(settings)).findings).toEqual([]);
  });
});
