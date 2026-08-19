#!/usr/bin/env node
/**
 * PreToolUse(Read) guard. Redirects only an unbounded whole-file Read of a generated or
 * oversized file toward a targeted read or a grep.
 *
 * A Read carrying offset or limit passes. Only a whole-file read of a denyGlob match or a
 * file larger than maxBytes is blocked. Exit 2 with stderr blocks and feeds the reason
 * back to Claude. Every other path exits 0, because a guard that crashes would block
 * every Read.
 *
 * Config (houserules.config.json, readGuard, all defaulted): { enabled, maxBytes, denyGlobs }.
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  READ_GUARD_DEFAULTS,
  loadConfigSafe,
} from '@houserules/payload/config';
import { globToRe, readStdinJson, repoRoot } from '@houserules/payload/proc';

interface ReadPayload {
  tool_input?: {
    file_path?: string;
    path?: string;
    offset?: number;
    limit?: number;
  };
}

const input = readStdinJson<ReadPayload>();

const ti = input?.tool_input ?? {};
const filePath = ti.file_path ?? ti.path ?? '';
// A bounded read (offset/limit set) is exactly what we WANT — let it through.
if (!filePath || ti.offset != null || ti.limit != null) process.exit(0);

try {
  const cfg = { ...READ_GUARD_DEFAULTS, ...(loadConfigSafe().readGuard ?? {}) };
  if (cfg.enabled === false) process.exit(0);

  // Resolve a repo-relative path for glob matching (git root, else cwd).
  const root = repoRoot();
  const abs = resolve(root, filePath);
  const rel = abs.startsWith(root) ? abs.slice(root.length + 1) : filePath;
  const base = rel.split('/').pop() ?? rel;

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
      `houserules read guard: ${rel} ${why}. Don't read it whole — ` +
        `grep for what you need (\`grep -n '<pattern>' ${rel}\`) then Read with offset+limit, ` +
        `or re-run this Read with an explicit limit if you truly need a window.\n`,
    );
    process.exit(2);
  }
} catch {
  process.exit(0); // Any guard error → allow the read.
}

process.exit(0);
