import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import plugin from '../index.js';
import type { Answers, Ctx, PluginApi } from '@agent-kit/cli/plugin';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function buildApi(config?: unknown): PluginApi {
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
        src: `/payload/kit-templates/${rel}`,
        dest: `.claude/kit-templates/${rel}`,
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
    packageName: '@agent-kit/plugin-github',
    alias: 'projects',
    config,
  };
}

const CTX = {} as Ctx;
const ANSWERS = {} as Answers;

describe('projects plugin', () => {
  it('contributes exactly one optional module named "projects"', () => {
    const modules = plugin(buildApi());

    expect(modules).toHaveLength(1);
    expect(modules[0]?.id).toBe('projects');
    expect(modules[0]?.group).toBe('optional');
  });

  it('defaults to disabled', () => {
    const [module] = plugin(buildApi());

    expect(module?.defaultEnabled(CTX)).toBe(false);
  });

  it('plans the sync script, its six libs, the hook, both skills, and both settings fragments', () => {
    const [module] = plugin(buildApi());
    const actions = module?.plan(CTX, ANSWERS) ?? [];

    expect(actions.map((action) => action.kind)).toEqual([
      'copy',
      'copy',
      'copy',
      'copy',
      'copy',
      'copy',
      'copy',
      'copy',
      'copy',
      'copy',
      'merge-settings',
      'merge-settings',
    ]);
    expect(
      actions.map((action) => ('dest' in action ? action.dest : undefined)),
    ).toEqual([
      '.claude/scripts/projects-sync.mjs',
      '.claude/scripts/lib/gh.mjs',
      '.claude/scripts/lib/sync-gate.mjs',
      '.claude/scripts/lib/project-shape.mjs',
      '.claude/scripts/lib/bootstrap-plan.mjs',
      '.claude/scripts/lib/push-queue.mjs',
      '.claude/scripts/lib/item-fields.mjs',
      '.claude/scripts/projects-sync-hook.mjs',
      '.claude/skills/ledger-sync/SKILL.md',
      '.claude/skills/backlog-adopt/SKILL.md',
      undefined,
      undefined,
    ]);
  });

  it('copies a lib for every ./lib import projects-sync.mts makes', () => {
    const [module] = plugin(buildApi());
    const copiedLibs = (module?.plan(CTX, ANSWERS) ?? [])
      .flatMap((action) => ('dest' in action ? [action.dest] : []))
      .filter((dest) => dest.startsWith('.claude/scripts/lib/'))
      .map((dest) => dest.replace('.claude/scripts/lib/', ''));

    const script = readFileSync(
      join(PACKAGE_ROOT, 'payload/scripts/projects-sync.mts'),
      'utf8',
    );
    const imported = [...script.matchAll(/from '\.\/lib\/([\w-]+\.mjs)'/g)].map(
      (match) => match[1],
    );

    const shippedByCore = ['kit-config.mjs', 'entry-ledger.mjs'];
    const owed = [...new Set(imported)].filter(
      (lib) => !shippedByCore.includes(lib),
    );

    expect(owed.filter((lib) => !copiedLibs.includes(lib))).toEqual([]);
  });

  it('allows the sync script in the merge-settings permission fragment', () => {
    const [module] = plugin(buildApi());
    const actions = module?.plan(CTX, ANSWERS) ?? [];
    const mergeSettings = actions.find(
      (action) => action.kind === 'merge-settings',
    );

    expect(
      mergeSettings?.kind === 'merge-settings' && mergeSettings.fragment,
    ).toEqual({
      permissions: {
        allow: ['Bash(node .claude/scripts/projects-sync.mjs:*)'],
      },
    });
  });

  it('does not throw when config is undefined', () => {
    expect(() => plugin(buildApi(undefined))).not.toThrow();
  });

  it('rejects autoSync here and names where it belongs, since nothing reads it from this block', () => {
    expect(() => plugin(buildApi({ autoSync: true }))).toThrow(
      /top level of kit\.config\.json/,
    );
  });

  it('throws naming an unknown config key', () => {
    expect(() => plugin(buildApi({ nope: true }))).toThrow(/"nope"/);
  });

  it('rejects a non-boolean autoSync for the same reason', () => {
    expect(() => plugin(buildApi({ autoSync: 'yes' }))).toThrow(/autoSync/);
  });
});

describe('SessionEnd wiring', () => {
  it('registers the hook on SessionEnd with no matcher, so it also fires on clear and resume', () => {
    const [module] = plugin(buildApi());
    const fragments = (module?.plan(CTX, ANSWERS) ?? []).flatMap((action) =>
      action.kind === 'merge-settings' ? [action.fragment] : [],
    );
    const hooks = fragments.find((fragment) => 'hooks' in fragment)?.hooks;

    expect(Object.keys(hooks ?? {})).toEqual(['SessionEnd']);
    expect(hooks?.SessionEnd?.[0]?.matcher).toBeUndefined();
  });
});
