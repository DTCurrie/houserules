#!/usr/bin/env node
// Assembles the skill-routing eval plugin: a manifest, every payload skill copied from
// packages/*/payload/skills/, and this suite's cases as the plugin's evals/ directory.
// Usage: node make-plugin.mjs [destination]. The default is a fresh temp dir. The path is printed.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUITE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SUITE_DIR, '..', '..', '..', '..');
const PLUGIN_NAME = 'houserules-skill-routing';

/** Every payload skill as `{ name, dir }`, across all packages. */
export function payloadSkills(repoRoot = REPO_ROOT) {
  const skills = [];
  for (const packageName of readdirSync(join(repoRoot, 'packages'))) {
    const skillsDir = join(
      repoRoot,
      'packages',
      packageName,
      'payload',
      'skills',
    );
    if (!existsSync(skillsDir)) continue;
    for (const name of readdirSync(skillsDir)) {
      skills.push({ name, dir: join(skillsDir, name) });
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

/** Builds the plugin into `destination` (created if missing) and returns its path. */
export function assemblePlugin(
  destination = mkdtempSync(join(tmpdir(), 'hr-skill-routing-')),
) {
  mkdirSync(join(destination, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(destination, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: PLUGIN_NAME, version: '0.0.0', description: 'Skill-routing eval target' }, null, 2)}\n`,
  );
  for (const { name, dir } of payloadSkills()) {
    cpSync(dir, join(destination, 'skills', name), { recursive: true });
  }
  cpSync(join(SUITE_DIR, 'cases'), join(destination, 'evals'), {
    recursive: true,
  });
  return destination;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(assemblePlugin(process.argv[2]));
}
