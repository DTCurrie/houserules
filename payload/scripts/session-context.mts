#!/usr/bin/env node
/**
 * SessionStart hook. Prints an orientation header of at most four lines: branch,
 * uncommitted files, and affected kit targets, so the agent does not re-derive it with
 * full `git status` reads.
 *
 * stdout becomes session context, so this stays tiny. Every failure path exits 0.
 */

import { loadConfigSafe } from './lib/kit-config.mjs';
import { git } from './lib/proc.mjs';

try {
  const cwd = process.cwd();
  const root = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (root) {
    const lines = [];
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
    let tracking = '';
    const counts = git(root, [
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

    const status = git(root, ['status', '--porcelain']) ?? '';
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
