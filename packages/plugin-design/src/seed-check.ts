import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isUntouchedSeed } from './tokens-seed.js';

import type { CheckResult, Ctx, Finding } from '@houserules/api';

/** Where houserules seeds the design system. Also the root of the design workspace. */
export const TOKENS_PATH = '.claude/design/tokens.json';

/**
 * Warns when the design system is missing, unparseable, or still exactly what houserules seeded.
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
      msg: `design: no design system at ${TOKENS_PATH}. Run \`npx houserules init\` to seed one, or write it by hand.`,
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
      msg: `design: ${TOKENS_PATH} is still houserules' placeholder seed, so every design check measures against placeholders. Replace the values with this repo's own, or bootstrap a first draft from existing code with \`node .claude/scripts/design.mjs extract\`.`,
    });
    return { findings, readouts };
  }

  readouts.push(`design: token set at ${TOKENS_PATH}`);
  return { findings, readouts };
}

/**
 * The token-file check for a repo where the Tailwind theme is the design system instead.
 *
 * A missing token file is the CORRECT state here, so {@link checkDesignTokens}'s warning would
 * be backward. What is worth reporting is the opposite case: a `tokens.json` left over from
 * before `design-tailwind` was installed. Nothing reads it any more, and houserules will never
 * remove it, because a seed is never manifest-tracked and so `computePrune` cannot reach it.
 * Left unsaid, it sits there looking like the design system while every query answers from the
 * theme.
 */
export function checkStaleTokenSeed(ctx: Ctx): CheckResult {
  if (!existsSync(join(ctx.root, TOKENS_PATH))) {
    return {
      findings: [],
      readouts: [
        'design: token source is the Tailwind theme, so no token file is expected',
      ],
    };
  }
  return {
    findings: [
      {
        level: 'WARN',
        msg: `design: ${TOKENS_PATH} predates design-tailwind and nothing reads it now, since queries answer from the Tailwind theme. houserules will not delete it, because a seed belongs to you. Remove it yourself, or drop the design-tailwind module to go back to it.`,
      },
    ],
    readouts: [],
  };
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
