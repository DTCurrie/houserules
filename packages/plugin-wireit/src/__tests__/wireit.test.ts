import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf } from '#test/installed-tree';
import { runCli } from '#test/run';
import plugin from '../index.js';
import type { Action, Answers, Ctx, PluginApi } from '@houserules/api';

function buildApi(): PluginApi {
  return {
    payload: {
      script: (module, name, reason) => ({
        kind: 'copy',
        src: `/payload/scripts/${name}`,
        dest: `.claude/scripts/${name}`,
        mode: 0o755,
        module,
        reason,
      }),
      lib: (module, name) => ({
        kind: 'copy',
        src: `/payload/scripts/lib/${name}`,
        dest: `.claude/scripts/lib/${name}`,
        module,
        reason: 'shared script library',
      }),
      skill: (module, name, reason) => ({
        kind: 'copy',
        src: `/payload/skills/${name}/SKILL.md`,
        dest: `.claude/skills/${name}/SKILL.md`,
        module,
        reason,
      }),
      agent: (module, name, reason) => ({
        kind: 'copy',
        src: `/payload/agents/${name}.md`,
        dest: `.claude/agents/${name}.md`,
        module,
        reason,
      }),
      rule: (module, name, reason) => ({
        kind: 'body',
        src: `/payload/rules/${name}.md`,
        dest: `.claude/rules/${name}.md`,
        module,
        reason,
      }),
      reference: (module, name, reason) => ({
        kind: 'copy',
        src: `/payload/reference/${name}.md`,
        dest: `.claude/reference/${name}.md`,
        module,
        reason,
      }),
      template: (module, rel, reason = 'reference template') => ({
        kind: 'copy',
        src: `/payload/templates/${rel}`,
        dest: `.claude/templates/${rel}`,
        module,
        reason,
      }),
      mcp: (module, server, transport, reason) => ({
        kind: 'copy',
        src: `/payload/mcp/${server}.${transport}.json`,
        dest: `.claude/mcp/${server}.${transport}.json`,
        module,
        reason,
      }),
      file: ({ module, srcRel, dest, reason, mode }) => {
        const action = {
          kind: 'copy' as const,
          src: `/payload/${srcRel}`,
          dest,
          module,
          reason,
        };
        return mode === undefined ? action : { ...action, mode };
      },
    },
    packageName: '@houserules/plugin-wireit',
    alias: 'wireit',
    config: undefined,
  };
}

const CTX = {} as Ctx;
const ANSWERS = {} as Answers;

const PLUGIN_WIREIT = fileURLToPath(new URL('../..', import.meta.url));
const MODULES = 'wireit/wireit,wireit/wireit-lint,wireit/wireit-setup';

function installed(): string {
  return useInstalledRepo('pnpm-monorepo', {
    plugins: [{ name: PLUGIN_WIREIT, alias: 'wireit' }],
    modules: MODULES,
  });
}

function planOf(id: string): Action[] {
  const found = plugin(buildApi()).find((m) => m.id === id);
  return found?.plan(CTX, ANSWERS) ?? [];
}

describe('wireit plan', () => {
  it('copies the rule into .claude/rules/wireit.md', () => {
    const rule = planOf('wireit').find((a) => a.kind === 'body');

    expect(rule).toMatchObject({
      src: '/payload/rules/wireit.md',
      dest: '.claude/rules/wireit.md',
    });
  });

  it('writes the extension fragment with the parallelism variable and manifest key', () => {
    const write = planOf('wireit').find(
      (a): a is Extract<Action, { kind: 'write' }> => a.kind === 'write',
    );

    expect(write?.dest).toBe('.claude/extensions/wireit.json');
    expect(JSON.parse(write?.content ?? 'null')).toEqual({
      shareVariables: ['WIREIT_PARALLEL'],
      manifestIgnoreKeys: ['wireit'],
    });
  });

  it('wireit-setup requires wireit-lint', () => {
    const setup = plugin(buildApi()).find((m) => m.id === 'wireit-setup');

    expect(setup?.requires).toEqual([{ id: 'wireit-lint' }]);
  });

  it.each(['wireit', 'wireit-lint', 'wireit-setup'])(
    'leaves %s off by default',
    (id) => {
      const found = plugin(buildApi()).find((m) => m.id === id);

      expect(found?.defaultEnabled(CTX)).toBe(false);
    },
  );
});

describe('wireit install', () => {
  it('installs the rule path-scoped to package.json files', () => {
    const root = installed();

    const rule = readFileSync(join(root, '.claude/rules/wireit.md'), 'utf8');

    expect(rule).toMatch(/^---\npaths:\n {2}- '\*\*\/package\.json'\n---/);
  });

  it('writes the extension fragment', () => {
    const root = installed();

    const fragment: unknown = JSON.parse(
      readFileSync(join(root, '.claude/extensions/wireit.json'), 'utf8'),
    );

    expect(fragment).toEqual({
      shareVariables: ['WIREIT_PARALLEL'],
      manifestIgnoreKeys: ['wireit'],
    });
  });

  it('installs the checker script', () => {
    const root = installed();

    expect(existsSync(join(root, '.claude/scripts/wireit-lint.mjs'))).toBe(
      true,
    );
  });

  it('installs the setup skill', () => {
    const root = installed();

    expect(existsSync(join(root, '.claude/skills/wireit-setup/SKILL.md'))).toBe(
      true,
    );
  });

  it('records all three modules in the manifest', () => {
    const root = installed();

    expect(manifestOf(root).modules).toEqual(
      expect.arrayContaining([
        'wireit/wireit',
        'wireit/wireit-lint',
        'wireit/wireit-setup',
      ]),
    );
  });

  it('reports a clean doctor', () => {
    const root = installed();

    const result = runCli(['doctor', root]);

    expect(
      result.status,
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(0);
  });

  it('leaves the fragment absent when the plugin modules are not selected', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      plugins: [{ name: PLUGIN_WIREIT, alias: 'wireit' }],
    });

    expect(existsSync(join(root, '.claude/extensions/wireit.json'))).toBe(
      false,
    );
  });
});
