import { describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runCli } from '#test/run';
import { runDoctorJson } from '#test/doctor-report';
import { manifestOf, writeManifest } from '#test/installed-tree';

const PLUGIN_DESIGN = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_DESIGN, alias: 'design' }];

const TAILWIND_LIBS = [
  '.claude/scripts/lib/tailwind-host-packages.mjs',
  '.claude/scripts/lib/tailwind-design-system.mjs',
  '.claude/scripts/lib/tailwind-theme-to-dtcg.mjs',
];

function tokensPathOf(root: string): string {
  return join(root, '.claude/design/tokens.json');
}

function installDesignOnly(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'design/design',
    plugins: PLUGINS,
  });
}

function addModuleToManifest(root: string, moduleId: string): void {
  const manifest = manifestOf(root);
  writeManifest(root, {
    ...manifest,
    modules: [...manifest.modules, moduleId],
  });
}

describe('design-tailwind install', () => {
  it('installs the three Tailwind libs the query and audit scripts import', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'design/design,design/design-tailwind',
      plugins: PLUGINS,
    });

    const missing = TAILWIND_LIBS.filter((lib) => !existsSync(join(root, lib)));

    expect(missing).toEqual([]);
  });

  it('does not seed a token file when design-tailwind is selected', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'design/design,design/design-tailwind',
      plugins: PLUGINS,
    });

    expect(existsSync(tokensPathOf(root))).toBe(false);
  });

  it('still seeds a token file when design-tailwind is not selected', () => {
    const root = installDesignOnly();

    expect(existsSync(tokensPathOf(root))).toBe(true);
  });

  it('records the three Tailwind libs in the manifest so update refreshes them', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'design/design,design/design-tailwind',
      plugins: PLUGINS,
    });

    const manifest = manifestOf(root);
    const recorded = TAILWIND_LIBS.filter((lib) => manifest.files[lib]);

    expect(recorded).toEqual(TAILWIND_LIBS);
  });
});

describe('update after adding design-tailwind to an install with a token file', () => {
  it('exits 0 with no stderr', () => {
    const root = installDesignOnly();
    addModuleToManifest(root, 'design/design-tailwind');

    const result = runCli(['update', root]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('keeps a token file the user edited, because a seed is never manifest-tracked and prune cannot reach it', () => {
    const root = installDesignOnly();
    appendFileSync(tokensPathOf(root), '// edited by the user\n');
    const editedContent = readFileSync(tokensPathOf(root), 'utf8');
    addModuleToManifest(root, 'design/design-tailwind');

    runCli(['update', root]);

    expect(readFileSync(tokensPathOf(root), 'utf8')).toBe(editedContent);
    expect(
      manifestOf(root).files['.claude/design/tokens.json'],
    ).toBeUndefined();
  });

  it('keeps an untouched token file too, for the same reason: a seed is never manifest-tracked and prune cannot reach it', () => {
    const root = installDesignOnly();
    addModuleToManifest(root, 'design/design-tailwind');

    runCli(['update', root]);

    expect(existsSync(tokensPathOf(root))).toBe(true);
    expect(
      manifestOf(root).files['.claude/design/tokens.json'],
    ).toBeUndefined();
  });
});

describe('doctor on a design-tailwind install', () => {
  function moduleTokenFindings(root: string): string[] {
    return runDoctorJson(root)
      .findings!.map((finding) => finding.msg)
      .filter(
        (msg) =>
          msg.startsWith('design: ') &&
          msg.includes('.claude/design/tokens.json'),
      );
  }

  it('does not warn about the absent token file, since the theme is the token source', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'design/design,design/design-tailwind',
      plugins: PLUGINS,
    });

    expect(moduleTokenFindings(root)).toEqual([]);
  });

  it('warns about a token file left over from before design-tailwind was added', () => {
    const root = installDesignOnly();
    addModuleToManifest(root, 'design/design-tailwind');

    const findings = moduleTokenFindings(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('nothing reads it now');
  });

  it('still warns about the missing token file when design-tailwind is not installed', () => {
    const root = installDesignOnly();
    rmSync(tokensPathOf(root));

    const findings = moduleTokenFindings(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('no design system at');
  });
});
