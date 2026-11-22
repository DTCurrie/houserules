import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Answers } from '@houserules/api';

import { useInstalledRepo } from '#test/repo';
import { runIn } from '#test/run';
import {
  editHouseConfig,
  manifestOf,
  sha256,
  writeManifest,
} from '#test/installed-tree';

import { detect } from '../../detect.js';
import type { Ctx } from '../../detect.js';
import { installedModuleIds } from '../../installed-modules.js';
import { closeSelection } from '../../module-requires.js';
import {
  MODULES,
  buildPlan,
  computeEffects,
  configOwnership,
} from '../../plan.js';
import type { PlanResult } from '../../plan.js';
import { buildRegistry } from '../../plugin-resolver.js';
import { resolveRecordedModuleIds } from '../../retired-modules.js';
import { splitFrontmatter } from '../frontmatter.js';
import { classifyMigration } from '../migration-classify.js';

const SKILL = '.claude/skills/blast-radius/SKILL.md';
const OTHER_SKILL = '.claude/skills/orchestrate/SKILL.md';
const RULE = '.claude/rules/code-cleanliness.md';

function committedInstall(): string {
  const root = useInstalledRepo('pnpm-monorepo', {
    modules: 'code-cleanliness,orchestrate',
  });
  runIn(root, 'git', ['add', '-f', '.claude']);
  runIn(root, 'git', ['commit', '-qm', 'commit the install']);
  return root;
}

function plannedAgainst(root: string): { ctx: Ctx; planResult: PlanResult } {
  const ctx = detect(root);
  const config = ctx.claude.houseConfig;
  const registry = buildRegistry(root, config, MODULES);
  const recorded = installedModuleIds(config, ctx.claude.manifest) ?? ['core'];
  const closed = closeSelection(
    registry,
    resolveRecordedModuleIds(recorded, registry),
    {
      persisted: config?.moduleOptions,
      chosen: {},
      packageManager: ctx.packageManager?.name,
    },
  );
  const answers: Answers = {
    moduleIds: closed.closure.moduleIds,
    targets: ctx.targets,
    seedChangesetConfig: false,
    moduleOptions: closed.moduleOptions,
  };
  const planResult = computeEffects(root, buildPlan(ctx, answers, registry), {
    manifest: ctx.claude.manifest,
    force: false,
    plugins: registry.plugins,
    ...configOwnership(ctx.claude.houseConfig),
  });
  return { ctx, planResult };
}

function classify(root: string): ReturnType<typeof classifyMigration> {
  const { ctx, planResult } = plannedAgainst(root);
  return classifyMigration(root, ctx, planResult);
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

function writeRuleFrontmatter(root: string, frontmatter: string): void {
  const { body } = splitFrontmatter(read(root, RULE));
  writeFileSync(join(root, RULE), frontmatter + body);
}

function appendToRuleBody(root: string): void {
  appendFileSync(join(root, RULE), '\nA line of my own.\n');
}

describe('classifyMigration', () => {
  it('classifies the tracked payload and reads an untouched install as unedited', () => {
    const root = committedInstall();

    const result = classify(root);

    expect(result.classified).toContain(SKILL);
    expect(result.classified).toContain(RULE);
    expect(result.classified).toEqual([...result.classified].sort());
    expect(
      result.classified.filter((dest) => dest.startsWith('.claude/scripts/')),
    ).toEqual([]);
    expect(result.classified).not.toContain('.claude/houserules.manifest.json');
    expect(result).toMatchObject({ edited: [], toEject: [], rulePaths: {} });
  });

  it('ejects an edited skill', () => {
    const root = committedInstall();
    appendFileSync(join(root, SKILL), '\nMy own step.\n');

    const result = classify(root);

    expect(result).toMatchObject({
      edited: [SKILL],
      toEject: [SKILL],
      rulePaths: {},
    });
  });

  it('ejects a conflict file', () => {
    const root = committedInstall();
    const manifest = manifestOf(root);
    (manifest.files as Record<string, unknown>)[OTHER_SKILL] = sha256(
      'an older shipped skill\n',
    );
    writeManifest(root, manifest);
    writeFileSync(join(root, OTHER_SKILL), 'my rewrite of the skill\n');

    const result = classify(root);

    expect(result).toMatchObject({
      edited: [OTHER_SKILL],
      toEject: [OTHER_SKILL],
      rulePaths: {},
    });
  });

  it('moves a trimmed paths: into rulePaths and leaves the rule out of toEject', () => {
    const root = committedInstall();
    writeRuleFrontmatter(root, "---\npaths:\n  - 'src/**/*.ts'\n---\n");

    const result = classify(root);

    expect(result).toMatchObject({
      edited: [RULE],
      toEject: [],
      rulePaths: { 'code-cleanliness': ['src/**/*.ts'] },
    });
  });

  it('ejects a rule with a body edit and a trimmed paths:, with no rulePaths entry', () => {
    const root = committedInstall();
    writeRuleFrontmatter(root, "---\npaths:\n  - 'src/**/*.ts'\n---\n");
    appendToRuleBody(root);

    const result = classify(root);

    expect(result).toMatchObject({
      edited: [RULE],
      toEject: [RULE],
      rulePaths: {},
    });
  });

  it('ejects a frontmatter edit to a key other than paths:', () => {
    const root = committedInstall();
    const { frontmatter } = splitFrontmatter(read(root, RULE));
    writeRuleFrontmatter(
      root,
      frontmatter.replace(/^---\n/, '---\ndescription: my own\n'),
    );

    const result = classify(root);

    expect(result).toMatchObject({
      edited: [RULE],
      toEject: [RULE],
      rulePaths: {},
    });
  });

  it('ejects a paths: written in a shape the shipped rendering does not produce', () => {
    const root = committedInstall();
    writeRuleFrontmatter(root, '---\npaths:\n  - "src/**/*.ts"\n---\n');

    const result = classify(root);

    expect(result).toMatchObject({
      edited: [RULE],
      toEject: [RULE],
      rulePaths: {},
    });
  });

  it('reads an untouched rule as unedited on a manifest with no frontmatter hash', () => {
    const root = committedInstall();
    const manifest = manifestOf(root);
    const files = manifest.files as unknown as Record<
      string,
      Record<string, string>
    >;
    const { body } = files[RULE] ?? {};
    files[RULE] = { body: body ?? '' };
    writeManifest(root, manifest);

    const result = classify(root);

    expect(result.classified).toContain(RULE);
    expect(result).toMatchObject({ edited: [], toEject: [], rulePaths: {} });
  });

  it('reads a rule matching the config-owned paths: as unedited', () => {
    const root = committedInstall();
    editHouseConfig(root, (config) => {
      config.rules = { 'code-cleanliness': { paths: ['src/**/*.ts'] } };
    });
    writeRuleFrontmatter(root, "---\npaths:\n  - 'src/**/*.ts'\n---\n");

    const result = classify(root);

    expect(result).toMatchObject({ edited: [], toEject: [], rulePaths: {} });
  });

  it('classifies nothing under payload.commit: true', () => {
    const root = committedInstall();
    editHouseConfig(root, (config) => {
      config.payload = { commit: true };
    });
    appendFileSync(join(root, SKILL), '\nMy own step.\n');
    writeRuleFrontmatter(root, "---\npaths:\n  - 'src/**/*.ts'\n---\n");

    const result = classify(root);

    expect(result).toEqual({
      classified: [],
      edited: [],
      toEject: [],
      rulePaths: {},
    });
  });
});
