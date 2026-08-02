import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CALLS_FILE = 'runner-calls.txt';

/**
 * Writes a fake package-manager runner that records every invocation instead of running one.
 *
 * The fix and verify scripts shell out to whatever their config's `runner` names. Pointing
 * that at the stub lets a test assert the exact argv the script composed. The caller wires its
 * own config, since which key holds the runner differs by script.
 *
 * @param fail Exit non-zero, for the unfixable-residue path.
 * @param failMessage What it writes to stderr when failing. Suites assert on this, and the
 *   text differs by script (unfixable lint residue versus a type error), so it is a parameter.
 */
export function stubRunner(
  root: string,
  { fail = false, failMessage = '1 unfixable problem' } = {},
): string {
  const path = join(root, 'stub-runner.sh');
  const outcome = fail
    ? `echo ${JSON.stringify(failMessage)} >&2; exit 1`
    : 'exit 0';
  writeFileSync(path, `#!/bin/sh\necho "$@" >> ${CALLS_FILE}\n${outcome}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** One entry per invocation, in order, each the arguments the script passed. */
export function recordedCalls(root: string): string[] {
  return readFileSync(join(root, CALLS_FILE), 'utf8').trim().split('\n');
}
