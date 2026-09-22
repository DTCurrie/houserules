import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import {
  type HouseManifestShape,
  manifestOf,
  readJson,
  sha256,
} from '#test/installed-tree';
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
    packageName: '@houserules/plugin-svelte',
    alias: 'svelte',
    config: undefined,
  };
}

const CTX = {} as Ctx;
const ANSWERS = {} as Answers;

const PLUGIN_SVELTE = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_SVELTE, alias: 'svelte' }];

function pathGlobs(ruleText: string): string[] {
  const body = ruleText.split('---')[1] ?? '';
  return [...body.matchAll(/^ {2}- ['"](.+?)['"]$/gm)]
    .map((m) => m[1])
    .filter((glob): glob is string => glob !== undefined);
}

/** Everything after the closing `---`, the part a body-owned rule's manifest hash covers. */
function ruleBody(ruleText: string): string {
  const match = /^---\n[\s\S]*?\n---[ \t]*\n?/.exec(ruleText);
  return match ? ruleText.slice(match[0].length) : ruleText;
}

const PRE_RENAME_DESTS = [
  '.claude/mcp/mcp.http.json',
  '.claude/mcp/mcp.stdio.json',
  '.claude/mcp/vscode.mcp.json',
];

function plantPreRenameMcpConfigs(root: string): void {
  const manifestPath = join(root, '.claude/houserules.manifest.json');
  const manifest = readJson<HouseManifestShape>(manifestPath);
  for (const dest of PRE_RENAME_DESTS) {
    const content = `{ "mcpServers": {}, "dest": "${dest}" }\n`;
    writeFileSync(join(root, dest), content);
    manifest.files[dest] = sha256(content);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function installedWith(guides: string[]): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'svelte/svelte',
    plugins: PLUGINS,
    ...(guides.length > 0
      ? { moduleOptions: { 'svelte/svelte': guides } }
      : {}),
  });
}

describe('svelte', () => {
  it('installs the base rule path-scoped to Svelte files', () => {
    const root = installedWith([]);

    const ruleText = readFileSync(
      join(root, '.claude/rules/svelte.md'),
      'utf8',
    );
    expect(
      ruleText,
      'without paths: frontmatter this rule loads on every turn',
    ).toMatch(/^---\n(?:.*\n)*?paths:\n/);
    expect(pathGlobs(ruleText)).toEqual([
      '**/*.svelte',
      '**/*.svelte.ts',
      '**/*.svelte.js',
    ]);
  });

  it('tracks the base rule in the manifest, pinned to the installed bytes', () => {
    const root = installedWith([]);

    const ruleText = readFileSync(
      join(root, '.claude/rules/svelte.md'),
      'utf8',
    );
    const manifest = manifestOf(root);
    expect(manifest.modules).toContain('svelte/svelte');
    expect(
      manifest.files['.claude/rules/svelte.md'],
      'the rule BODY is kit-owned (update-refreshable)',
    ).toEqual(expect.objectContaining({ body: sha256(ruleBody(ruleText)) }));
  });

  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });

    const manifest = manifestOf(root);
    expect(manifest.modules).not.toContain('svelte/svelte');
    expect(
      existsSync(join(root, '.claude/rules/svelte.md')),
      'svelte.md absent',
    ).toBe(false);
  });

  it('installs the SvelteKit guide only when sveltekit was chosen', () => {
    const withGuide = installedWith(['sveltekit']);
    const withoutGuide = installedWith([]);

    expect(
      existsSync(join(withGuide, '.claude/rules/sveltekit.md')),
      'sveltekit.md installed',
    ).toBe(true);
    expect(
      existsSync(join(withoutGuide, '.claude/rules/sveltekit.md')),
      'sveltekit.md absent',
    ).toBe(false);
  });

  it('is not installed by default for the svelte-mcp module either', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });

    const manifest = manifestOf(root);
    expect(manifest.modules).not.toContain('svelte/svelte-mcp');
    expect(existsSync(join(root, '.claude/mcp')), '.claude/mcp absent').toBe(
      false,
    );
  });

  it('installs all three MCP configs under .claude/mcp/ when svelte-mcp is enabled', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'svelte/svelte-mcp',
      plugins: PLUGINS,
    });

    expect(
      existsSync(join(root, '.claude/mcp/svelte.http.json')),
      'svelte.http.json installed',
    ).toBe(true);
    expect(
      existsSync(join(root, '.claude/mcp/svelte.stdio.json')),
      'svelte.stdio.json installed',
    ).toBe(true);
    expect(
      existsSync(join(root, '.claude/mcp/svelte.vscode.json')),
      'svelte.vscode.json installed',
    ).toBe(true);

    const manifest = manifestOf(root);
    expect(manifest.modules).toContain('svelte/svelte-mcp');
  });

  it('namespaces every MCP dest by server name, so a second plugin cannot collide', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'svelte/svelte-mcp',
      plugins: PLUGINS,
    });

    expect(readdirSync(join(root, '.claude/mcp')).sort()).toEqual([
      'svelte.http.json',
      'svelte.stdio.json',
      'svelte.vscode.json',
    ]);
  });

  describe('upgrading from an install that predates the rename', () => {
    let root: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo', {
        modules: 'svelte/svelte-mcp',
        plugins: PLUGINS,
      });
      plantPreRenameMcpConfigs(root);
    });

    it('deletes the three unnamespaced configs on update', () => {
      const planted = PRE_RENAME_DESTS.filter((dest) =>
        existsSync(join(root, dest)),
      );

      const result = runCli(['update', root]);

      expect(
        planted,
        'the fixture never planted, so the rest is vacuous',
      ).toEqual(PRE_RENAME_DESTS);
      expect(result.status, result.stderr).toBe(0);
      expect(
        PRE_RENAME_DESTS.filter((dest) => existsSync(join(root, dest))),
        'a leftover here collides with any second plugin shipping an MCP config',
      ).toEqual([]);
    });

    it('drops them from the manifest too', () => {
      runCli(['update', root]);

      const tracked = Object.keys(manifestOf(root).files);
      expect(tracked.filter((dest) => PRE_RENAME_DESTS.includes(dest))).toEqual(
        [],
      );
    });

    it('keeps the namespaced configs it replaced them with', () => {
      runCli(['update', root]);

      expect(readdirSync(join(root, '.claude/mcp')).sort()).toEqual([
        'svelte.http.json',
        'svelte.stdio.json',
        'svelte.vscode.json',
      ]);
    });
  });

  it('names the worker tool path in the installed rule body', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'svelte/svelte,svelte/svelte-mcp',
      plugins: PLUGINS,
    });

    const ruleText = readFileSync(
      join(root, '.claude/rules/svelte.md'),
      'utf8',
    );

    expect(ruleText).toMatch(/orchestrate\.workerTools/);
  });

  it('names the full MCP tool names and the worker tool path in the svelte-mcp advise text', () => {
    const modules = plugin(buildApi());
    const svelteMcpModule = modules.find((m) => m.id === 'svelte-mcp');
    const actions = svelteMcpModule?.plan(CTX, ANSWERS) ?? [];
    const adviseAction = actions.find(
      (action): action is Extract<Action, { kind: 'advise' }> =>
        action.kind === 'advise',
    );

    expect(adviseAction?.text).toMatch(/mcp__svelte__svelte-autofixer/);
    expect(adviseAction?.text).toMatch(/orchestrate\.workerTools/);
  });

  it('tracks each MCP config in the manifest, so update refreshes it', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'svelte/svelte-mcp',
      plugins: PLUGINS,
    });

    const manifest = manifestOf(root);
    expect(Object.keys(manifest.files)).toEqual(
      expect.arrayContaining([
        '.claude/mcp/svelte.http.json',
        '.claude/mcp/svelte.stdio.json',
        '.claude/mcp/svelte.vscode.json',
      ]),
    );
  });

  it('never ships Svelte 4 syntax in an installed rule body', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'svelte/svelte',
      plugins: PLUGINS,
      moduleOptions: { 'svelte/svelte': ['sveltekit'] },
    });
    const rulesDir = join(root, '.claude/rules');
    const codeBlocks = readdirSync(rulesDir)
      .filter((name) => name.endsWith('.md'))
      .flatMap((name) => {
        const body = readFileSync(join(rulesDir, name), 'utf8');
        return [...body.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(
          (m) => `${name}: ${m[1]}`,
        );
      });

    const offenders = codeBlocks.flatMap((block) => {
      const violations: string[] = [];
      if (block.includes('export let')) violations.push('export let');
      if (block.includes('on:click')) violations.push('on:click');
      if (/\n\s*\$:/.test(block)) violations.push('$: reactive statement');
      return violations.map((v) => `${block.split(':')[0]}: ${v}`);
    });

    expect(offenders).toEqual([]);
  });

  it('warns that module-level $state is shared across requests and users', () => {
    const root = installedWith([]);

    const ruleText = readFileSync(
      join(root, '.claude/rules/svelte.md'),
      'utf8',
    );

    expect(ruleText).toMatch(/## Context Providers[\s\S]{0,300}`provide\*`/);
  });

  it('carves authorization out of the layout-fetching guidance', () => {
    const root = installedWith(['sveltekit']);

    const ruleText = readFileSync(
      join(root, '.claude/rules/sveltekit.md'),
      'utf8',
    );

    expect(ruleText).toMatch(/authorization[\s\S]{0,200}`handle` hook/);
  });
});
