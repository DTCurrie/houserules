import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CheckResult, Ctx, Finding } from '@houserules/api';

/**
 * Kept in step with `payload/scripts/lib/tailwind-design-system.mts`, which is the copy the module
 * itself resolves at runtime. Two copies is one more than ideal, but the payload may not
 * import from `src/` and the CLI may not import from the payload, so neither can hold the
 * other's copy.
 */
const TAILWIND_IMPORT_PATTERN = /@import\s+["']tailwindcss(?:\/[^"']*)?["']/;

/**
 * Validates `design.themeEntry`, when the config names one. Never compiles the stylesheet,
 * only checks that it exists and carries a Tailwind import.
 */
export function checkThemeEntry(ctx: Ctx): CheckResult {
  const findings: Finding[] = [];
  const readouts: string[] = [];

  const themeEntry = ctx.claude?.houseConfig?.design?.themeEntry;
  if (!themeEntry) return { findings, readouts };

  const entryPath = join(ctx.root, themeEntry);
  if (!existsSync(entryPath)) {
    findings.push({
      level: 'WARN',
      msg: `design: design.themeEntry names ${themeEntry}, but that file does not exist. Fix the path or remove the key.`,
    });
    return { findings, readouts };
  }

  const contents = readFileSync(entryPath, 'utf8');
  if (!TAILWIND_IMPORT_PATTERN.test(contents)) {
    findings.push({
      level: 'WARN',
      msg: `design: design.themeEntry names ${themeEntry}, but it does not import tailwindcss. design.mjs will fail to compile it.`,
    });
    return { findings, readouts };
  }

  readouts.push(
    `design: design.themeEntry (${themeEntry}) imports tailwindcss`,
  );
  return { findings, readouts };
}
