#!/usr/bin/env node
// Opt-in PreToolUse(Read) guard (claude-kit). Enforces the marketed-but-unenforced
// "grep, don't read whole" rule (README, CONVENTIONS §7): redirect ONLY an UNBOUNDED
// whole-file Read of a generated/oversized file toward a targeted read or grep.
//
// A Read that already carries `offset`/`limit` PASSES — targeted reads are fine. Only
// a whole-file read of a denyGlob match (lockfiles, dist, *.min.*, source maps) or a
// file larger than maxBytes is blocked. Exit 2 + stderr blocks and feeds the reason
// back to Claude (same contract as guard-bash). Every OTHER path exits 0 — a guard
// that crashes would block every Read.
//
// Config (kit.config.json → readGuard, all defaulted): { enabled, maxBytes, denyGlobs }.

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { READ_GUARD_DEFAULTS, loadConfigSafe } from './lib/kit-config.mjs';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0); // No parseable payload — never block.
}

const ti = input?.tool_input ?? {};
const filePath = ti.file_path ?? ti.path ?? '';
// A bounded read (offset/limit set) is exactly what we WANT — let it through.
if (!filePath || ti.offset != null || ti.limit != null) process.exit(0);

// Minimal, zero-dep glob → RegExp: `**` spans path separators, `*` does not.
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` also matches zero dirs
      } else re += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else if (c === '?') re += '[^/]';
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

try {
  const cfg = { ...READ_GUARD_DEFAULTS, ...(loadConfigSafe().readGuard ?? {}) };
  if (cfg.enabled === false) process.exit(0);

  // Resolve a repo-relative path for glob matching (git root, else cwd).
  let root;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    root = process.cwd();
  }
  const abs = resolve(root, filePath);
  const rel = abs.startsWith(root) ? abs.slice(root.length + 1) : filePath;
  const base = rel.split('/').pop();

  const matchedGlob = (cfg.denyGlobs ?? []).find((g) => {
    const re = globToRe(g);
    return re.test(rel) || re.test(base);
  });

  let size = 0;
  try {
    size = statSync(abs).size;
  } catch {
    /* unreadable/nonexistent — let Read report it, don't block */
  }
  const tooBig = cfg.maxBytes && size > cfg.maxBytes;

  if (matchedGlob || tooBig) {
    const why = matchedGlob
      ? `matches a generated/denylisted pattern (${matchedGlob})`
      : `is large (${Math.round(size / 1024)} KB > ${Math.round(cfg.maxBytes / 1024)} KB)`;
    process.stderr.write(
      `claude-kit read guard: ${rel} ${why}. Don't read it whole — ` +
        `grep for what you need (\`grep -n '<pattern>' ${rel}\`) then Read with offset+limit, ` +
        `or re-run this Read with an explicit limit if you truly need a window.\n`,
    );
    process.exit(2);
  }
} catch {
  process.exit(0); // Any guard error → allow the read.
}

process.exit(0);
