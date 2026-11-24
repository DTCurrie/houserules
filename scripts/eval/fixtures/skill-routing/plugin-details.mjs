#!/usr/bin/env node
// Prints the always-on description cost of the payload in plugin form, from `claude plugin details`.
// Builds the plugin with make-plugin.mjs, then runs the command on it. No model call, no auth.
// Usage: node plugin-details.mjs. Output: one line, `always-on: <n> tok (<skills> skills)`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assemblePlugin } from './make-plugin.mjs';

const PLUGIN_NAME = 'houserules-skill-routing';
const EXIT_FAILURE = 1;

/**
 * Reads the always-on token estimate and skill count out of `claude plugin details` output.
 * Returns `{ alwaysOnTokens, skills }`, or throws when the "Always-on" line is missing.
 */
export function parseDetails(output) {
  const alwaysOn = /Always-on:\s*~?([\d,]+)\s*tok/.exec(output);
  if (!alwaysOn) {
    throw new Error('no "Always-on: ~N tok" line in plugin details output');
  }
  const skills = /Skills \((\d+)\)/.exec(output);
  return {
    alwaysOnTokens: Number(alwaysOn[1].replaceAll(',', '')),
    skillCount: skills ? Number(skills[1]) : null,
  };
}

function main() {
  const plugin = assemblePlugin();
  const result = spawnSync(
    'claude',
    ['--plugin-dir', plugin, 'plugin', 'details', PLUGIN_NAME],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    console.error(result.stderr || result.error?.message || 'claude failed');
    process.exit(EXIT_FAILURE);
  }
  const { alwaysOnTokens, skillCount } = parseDetails(result.stdout);
  console.log(
    `always-on: ${alwaysOnTokens} tok (${skillCount ?? 'unknown'} skills)`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
