import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Writes an executable `claude` into a fresh temporary bin directory. `body` is the source of
 * an ES module that node runs as that binary, so it reads `process.argv`, stdin, and its
 * environment as the real CLI would. Control a stub through variables whose names start with
 * `EVAL_STUB_`, never `CLAUDE`, because the child environment drops every `CLAUDE*` name.
 *
 * @param {string} body
 * @returns {{ binDir: string, path: string }} The bin directory, and a `PATH` value that puts
 *   it first.
 */
export function writeStubClaude(body) {
  const binDir = mkdtempSync(join(tmpdir(), 'hr-eval-stub-'));
  const file = join(binDir, 'claude');
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return { binDir, path: `${binDir}${delimiter}${process.env.PATH ?? ''}` };
}
