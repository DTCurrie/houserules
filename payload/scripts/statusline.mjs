#!/usr/bin/env node
// Opt-in statusLine command (claude-kit). Surfaces only the two things the native
// statusline can't: pending changeset debt (unreleased .changeset/*.md) and which
// kit targets the working tree has touched — plus the ambient context%/cost from the
// status JSON Claude Code pipes in. One line to stdout; every failure path prints
// nothing and exits 0 (a broken statusline must never disrupt the session).

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { loadConfigSafe } from './lib/kit-config.mjs';

function git(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

try {
  let status = {};
  try {
    status = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    /* no status payload — still print the git-derived bits */
  }

  const root =
    git(process.cwd(), ['rev-parse', '--show-toplevel'])?.trim() ||
    status.workspace?.project_dir ||
    process.cwd();

  const segments = [];

  // Pending changeset debt (unreleased notes; README excluded).
  let pending = 0;
  try {
    pending = readdirSync(resolve(root, '.changeset')).filter(
      (f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md',
    ).length;
  } catch {
    /* no .changeset dir */
  }
  if (pending) segments.push(`⛁ ${pending} changeset${pending > 1 ? 's' : ''}`);

  // Kit targets the working tree has touched.
  const targets = loadConfigSafe().targets ?? [];
  if (targets.length) {
    const changed = (git(root, ['status', '--porcelain']) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).trim());
    const touched = new Set();
    for (const p of changed) {
      const t = targets.find((x) =>
        x.pathPrefix ? p.startsWith(x.pathPrefix) : true,
      );
      if (t) touched.add(t.name);
    }
    if (touched.size) segments.push(`✎ ${[...touched].join(',')}`);
  }

  // Ambient context% + cost from the status JSON (native bar can't show the above).
  const usedPct = status.context_window?.used_percentage;
  if (typeof usedPct === 'number') segments.push(`ctx ${Math.round(usedPct)}%`);
  const cost = status.cost?.total_cost_usd;
  if (typeof cost === 'number') segments.push(`$${cost.toFixed(2)}`);

  if (segments.length) process.stdout.write(`[kit] ${segments.join(' · ')}\n`);
} catch {
  /* never disrupt the session */
}
process.exit(0);
