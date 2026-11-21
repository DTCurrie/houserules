import type {
  HookFire,
  HookOutcome,
  SessionEvents,
} from './transcript-events.js';

// A non-zero hook exit whose output carries any of these is the hook itself failing, not
// the hook doing its job. Grounded in the houserules corpus, where every non-zero
// PreToolUse exit was a missing-module crash from a pre-rename install. The last sign is
// the payload wrappers' own sentinel, emitted with exit 1 when a `.claude/scripts/` file
// is absent (a branch out of sync with settings.json) — a broken install, not a policy block.
const CRASH_SIGNS = [
  'Cannot find module',
  'node:internal',
  'Node.js v',
  'throw err',
  'missing. Run: npx houserules update',
  'is missing, so this call is blocked. Restore it from your terminal: npx houserules update',
  "this install's generated files are not synced yet",
];

/** Whether a non-zero hook exit was the hook crashing rather than blocking. */
export function isCrash(
  fire: Pick<HookFire, 'stderr'> & { content?: string },
): boolean {
  const text = `${fire.stderr}\n${fire.content ?? ''}`;
  return CRASH_SIGNS.some((sign) => text.includes(sign));
}

/** A short grouping key for a crash: the missing module or script, or the first stderr line. */
export function crashSignature(
  fire: Pick<HookFire, 'stderr'> & { content?: string },
): string {
  const text = `${fire.stderr}\n${fire.content ?? ''}`;
  const match = text.match(/Cannot find module '([^']+)'/);
  if (match) return `Cannot find module '${match[1]}'`;
  const missing =
    text.match(
      /\[houserules] (\S+) (?:missing\. Run: npx houserules update|is missing, so this call is blocked\. Restore it from your terminal: npx houserules update)/,
    ) ??
    text.match(
      /\[houserules] (\S+): this install's generated files are not synced yet/,
    );
  if (missing) return `missing script: ${missing[1]}`;
  const firstLine = fire.stderr.split('\n').find((l) => l.trim());
  return firstLine?.trim().slice(0, 100) ?? '(empty stderr)';
}

/**
 * The error tool_results that no attachment already covers, so a call recorded both ways
 * counts once.
 */
export function uncoveredOutcomes(session: SessionEvents): HookOutcome[] {
  const covered = new Set(
    session.hookFires
      .filter((fire) => fire.hookName.startsWith('PreToolUse'))
      .map((fire) => fire.toolUseID),
  );
  return session.hookOutcomes.filter(
    (outcome) =>
      outcome.toolUseId === undefined || !covered.has(outcome.toolUseId),
  );
}
