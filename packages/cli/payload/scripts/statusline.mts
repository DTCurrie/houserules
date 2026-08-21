#!/usr/bin/env node
/**
 * statusLine command. Surfaces the two things the native statusline cannot: pending
 * changeset debt and which houserules targets the working tree has touched, alongside the
 * ambient context percentage and cost from the status JSON Claude Code pipes in.
 *
 * One line to stdout. Every failure path prints nothing and exits 0.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfigSafe, repoRootSafe } from '@houserules/payload/config';
import { git } from '@houserules/payload/proc';

interface StatusPayload {
  workspace?: { project_dir?: string };
  context_window?: { used_percentage?: number };
  cost?: { total_cost_usd?: number };
}

try {
  let status: StatusPayload = {};
  try {
    status = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    /* no status payload — still print the git-derived bits */
  }

  // A statusLine command re-runs on every render, so the root is resolved once and then
  // handed to every reader below. `loadConfigSafe()` would otherwise spawn its own
  // `git rev-parse --show-toplevel` on top of this one.
  const root = repoRootSafe() || status.workspace?.project_dir || process.cwd();

  const segments: string[] = [];

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
  const targets = loadConfigSafe(root).targets ?? [];
  if (targets.length) {
    const changed = (git(root, ['status', '--porcelain']) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).trim());
    const touched = new Set<string>();
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

  if (segments.length)
    process.stdout.write(`[houserules] ${segments.join(' · ')}\n`);
} catch {
  /* never disrupt the session */
}
process.exit(0);
