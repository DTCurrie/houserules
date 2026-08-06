import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isUntouchedSeed } from './tokens-seed.js';

import type { CheckResult, Ctx, Finding } from '@agent-kit/cli/plugin';

/** Where the kit seeds the design system. Also the root of the design workspace. */
export const TOKENS_PATH = '.claude/design/tokens.json';

/**
 * Warns when the design system is missing, unparseable, or still exactly what the kit seeded.
 *
 * An untouched seed is the finding that matters. Every downstream design check compares real
 * code against these values, so a repo that never replaced them is measuring its UI against
 * placeholders and getting confident, meaningless verdicts back.
 *
 * Pure and read-only, per the `check` contract. A missing file, unreadable bytes, and invalid
 * JSON all return cleanly rather than throwing, because a doctor check that throws takes the
 * whole report down with it.
 */
export function checkDesignTokens(ctx: Ctx): CheckResult {
  const findings: Finding[] = [];
  const readouts: string[] = [];
  const absolute = join(ctx.root, TOKENS_PATH);

  if (!existsSync(absolute)) {
    findings.push({
      level: 'WARN',
      msg: `design: no design system at ${TOKENS_PATH} — run \`npx agent-kit init\` to seed one, or write it by hand.`,
    });
    return { findings, readouts };
  }

  const contents = readTokenFile(absolute);
  if (contents === undefined) {
    findings.push({
      level: 'WARN',
      msg: `design: ${TOKENS_PATH} could not be read.`,
    });
    return { findings, readouts };
  }

  if (!isParseableJson(contents)) {
    findings.push({
      level: 'ERROR',
      msg: `design: ${TOKENS_PATH} is not valid JSON, so every design check reads an empty token set.`,
    });
    return { findings, readouts };
  }

  if (isUntouchedSeed(contents)) {
    findings.push({
      level: 'WARN',
      msg: `design: ${TOKENS_PATH} is still the kit's placeholder seed, so every design check measures against placeholders. Replace the values with this repo's own, or bootstrap a first draft from existing code with \`node .claude/scripts/design.mjs extract\`.`,
    });
    return { findings, readouts };
  }

  readouts.push(`design: token set at ${TOKENS_PATH}`);
  return { findings, readouts };
}

function readTokenFile(absolute: string): string | undefined {
  try {
    return readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

function isParseableJson(contents: string): boolean {
  try {
    JSON.parse(contents);
    return true;
  } catch {
    return false;
  }
}
