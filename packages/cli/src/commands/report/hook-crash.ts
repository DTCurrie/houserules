import type { HookFire } from './transcript-events.js';

// A non-zero hook exit whose output carries any of these is the hook itself failing, not
// the hook doing its job. Grounded in the houserules corpus, where every non-zero
// PreToolUse exit was a missing-module crash from a pre-rename install.
const CRASH_SIGNS = [
  'Cannot find module',
  'node:internal',
  'Node.js v',
  'throw err',
];

/** Whether a non-zero hook exit was the hook crashing rather than blocking. */
export function isCrash(fire: HookFire): boolean {
  const text = `${fire.stderr}\n${fire.content}`;
  return CRASH_SIGNS.some((sign) => text.includes(sign));
}

/** A short grouping key for a crash: the missing module, or the first stderr line. */
export function crashSignature(fire: HookFire): string {
  const match = `${fire.stderr}\n${fire.content}`.match(
    /Cannot find module '([^']+)'/,
  );
  if (match) return `Cannot find module '${match[1]}'`;
  const firstLine = fire.stderr.split('\n').find((l) => l.trim());
  return firstLine?.trim().slice(0, 100) ?? '(empty stderr)';
}
