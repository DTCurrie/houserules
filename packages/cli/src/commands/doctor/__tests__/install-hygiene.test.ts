import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeCtx } from '#test/ctx-builder';
import { useRepo } from '#test/repo';
import type { Ctx } from '../../../detect.js';
import type { Settings } from '@houserules/api';
import { checkInstallHygiene } from '../install-hygiene.js';

function wiring(...commands: string[]): Settings {
  return {
    hooks: {
      PreToolUse: [
        { hooks: commands.map((command) => ({ type: 'command', command })) },
      ],
    },
  };
}

function settingsCtx(root: string, settings: Settings): Ctx {
  return makeCtx({
    root,
    claude: {
      ...makeCtx().claude,
      settingsExists: true,
      settings,
    },
  });
}

function writeScript(root: string, relativePath: string): void {
  mkdirSync(join(root, '.claude', 'scripts'), { recursive: true });
  writeFileSync(join(root, relativePath), 'export {};');
}

function writeConfigFile(
  root: string,
  fileName: string,
  content: string,
): void {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', fileName), content);
}

describe('checkInstallHygiene', () => {
  it('flags an unguarded kit-script hook as an info readout naming the script', () => {
    const root = useRepo('pnpm-single');
    writeScript(root, '.claude/scripts/guard-bash.mjs');
    const ctx = settingsCtx(
      root,
      wiring('node .claude/scripts/guard-bash.mjs'),
    );

    const result = checkInstallHygiene(root, ctx);

    expect(result.readouts).toContainEqual(
      expect.stringContaining('.claude/scripts/guard-bash.mjs'),
    );
    expect(result.findings).toEqual([]);
  });

  it('does not flag a hook command guarded by the existence check', () => {
    const root = useRepo('pnpm-single');
    writeScript(root, '.claude/scripts/guard-bash.mjs');
    const ctx = settingsCtx(
      root,
      wiring(
        '[[ -f .claude/scripts/guard-bash.mjs ]] && exec node .claude/scripts/guard-bash.mjs',
      ),
    );

    const result = checkInstallHygiene(root, ctx);

    expect(
      result.readouts.some((readout) => readout.includes('without the')),
    ).toBe(false);
  });

  it('warns once about a hook command referencing a missing slashed script path', () => {
    const root = useRepo('pnpm-single');
    const ctx = settingsCtx(root, wiring('node scripts/gone.mjs'));

    const result = checkInstallHygiene(root, ctx);

    expect(result.findings).toEqual([
      {
        level: 'WARN',
        msg: 'hook command references missing script "scripts/gone.mjs" — fix the path or remove the hook',
      },
    ]);
  });

  it('does not warn about a bare script basename inside a fallback message string', () => {
    const root = useRepo('pnpm-single');
    const ctx = settingsCtx(
      root,
      wiring(
        'echo "[houserules] guard-bash.mjs missing. Run: npx houserules update"',
      ),
    );

    const result = checkInstallHygiene(root, ctx);

    expect(result.findings).toEqual([]);
  });

  it('does not warn about a hook script that exists on disk', () => {
    const root = useRepo('pnpm-single');
    writeScript(root, '.claude/scripts/present.mjs');
    const ctx = settingsCtx(root, wiring('node .claude/scripts/present.mjs'));

    const result = checkInstallHygiene(root, ctx);

    expect(result.findings).toEqual([]);
  });

  it('warns once about a secret-shaped value in a config surface file without echoing it', () => {
    const root = useRepo('pnpm-single');
    const secret = 'ghp_' + 'a'.repeat(36);
    writeConfigFile(root, 'settings.json', JSON.stringify({ token: secret }));
    const ctx = makeCtx({ root });

    const result = checkInstallHygiene(root, ctx);

    expect(result.findings).toEqual([
      {
        level: 'WARN',
        msg: '.claude/settings.json contains a value shaped like a ghp_ secret — remove it and rotate the credential',
      },
    ]);
    expect(result.findings.every((f) => !f.msg.includes(secret))).toBe(true);
  });

  it('reports zero findings for a clean installed shape', () => {
    const root = useRepo('pnpm-single');
    writeScript(root, '.claude/scripts/guard-bash.mjs');
    writeConfigFile(root, 'settings.json', JSON.stringify({ hooks: {} }));
    const ctx = settingsCtx(
      root,
      wiring(
        '[[ -f .claude/scripts/guard-bash.mjs ]] && exec node .claude/scripts/guard-bash.mjs',
      ),
    );

    const result = checkInstallHygiene(root, ctx);

    expect(result.findings).toEqual([]);
  });

  it('reports zero findings and does not crash when there is no settings surface at all', () => {
    const root = useRepo('pnpm-single');
    const ctx = makeCtx({ root });

    const result = checkInstallHygiene(root, ctx);

    expect(result.findings).toEqual([]);
    expect(result.readouts).toEqual([]);
  });

  it('emits a summary readout counting hook commands and config files scanned', () => {
    const root = useRepo('pnpm-single');
    writeScript(root, '.claude/scripts/some-other-tool.mjs');
    writeConfigFile(root, 'settings.json', JSON.stringify({}));
    const ctx = settingsCtx(
      root,
      wiring('node .claude/scripts/some-other-tool.mjs'),
    );

    const result = checkInstallHygiene(root, ctx);

    expect(result.readouts).toContainEqual(
      'install hygiene: 1 hook command(s) scanned, 1 config file(s) scanned',
    );
  });
});
