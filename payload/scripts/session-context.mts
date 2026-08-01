#!/usr/bin/env node
// SessionStart hook (claude-kit). Prints a ≤4-line orientation header — branch,
// uncommitted files, affected kit targets — so the agent doesn't re-derive it
// with full `git status` reads. stdout becomes session context: keep it tiny.
// Every failure path exits 0; an orientation header must never break a session.

import { execFileSync } from 'node:child_process';

import { loadConfigSafe } from './lib/kit-config.mjs';

// NOTE: returns RAW output — `git status --porcelain` lines are position-sensitive
// (2 status chars + space); a global trim would eat the first line's prefix.
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

try {
  const root = git(['rev-parse', '--show-toplevel'])?.trim();
  if (root) {
    const lines = [];
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
    let tracking = '';
    const counts = git([
      'rev-list',
      '--left-right',
      '--count',
      '@{upstream}...HEAD',
    ])?.trim();
    if (counts) {
      const [behind, ahead] = counts.split(/\s+/).map(Number);
      const bits = [
        ahead ? `ahead ${ahead}` : null,
        behind ? `behind ${behind}` : null,
      ].filter(Boolean);
      if (bits.length) tracking = ` (${bits.join(', ')})`;
    }
    lines.push(`[kit] branch: ${branch ?? '(no commits yet)'}${tracking}`);

    const status = git(['status', '--porcelain']) ?? '';
    const changed = status
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).trim());
    if (changed.length) {
      const targets = loadConfigSafe().targets ?? [];
      const byTarget = new Map<string, number>();
      for (const path of changed) {
        const t = targets.find((x) =>
          x.pathPrefix ? path.startsWith(x.pathPrefix) : true,
        );
        if (t) byTarget.set(t.name, (byTarget.get(t.name) ?? 0) + 1);
      }
      if (changed.length > 25) {
        const summary = [...byTarget.entries()]
          .map(([n, c]) => `${n} (${c})`)
          .join(', ');
        lines.push(
          `[kit] uncommitted: ${changed.length} files${summary ? ` — ${summary}` : ''}`,
        );
      } else {
        const shown = changed.slice(0, 10).join(', ');
        lines.push(
          `[kit] uncommitted (${changed.length}): ${shown}${changed.length > 10 ? ', …' : ''}`,
        );
        if (byTarget.size)
          lines.push(
            `[kit] targets touched: ${[...byTarget.keys()].join(', ')}`,
          );
      }
    }
    console.log(lines.join('\n'));
  }
} catch {
  // Never block session start.
}
process.exit(0);
