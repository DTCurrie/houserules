import type { Action, CheckResult, ModuleGroup } from '@agent-kit/api';
import type { Ctx } from '../detect.js';
import { script } from './copy-actions.js';

export const id = 'rename';
export const title = 'TS semantic rename script';
export const group: ModuleGroup = 'recommended';

export function hint(ctx: Ctx): string {
  return ctx.typescript
    ? 'TypeScript detected'
    : 'no TypeScript detected — skip';
}

export function defaultEnabled(ctx: Ctx): boolean {
  return ctx.typescript;
}

/**
 * A TypeScript LanguageService semantic rename script. TypeScript repos only, since the
 * script hard-fails at import without `typescript`.
 */
export function plan(): Action[] {
  return [
    script(
      id,
      'rename.mjs',
      'project-wide symbol rename via the TS LanguageService',
    ),
  ];
}

export function check(ctx: Ctx): CheckResult {
  if (ctx.typescript) return { findings: [], readouts: [] };
  return {
    findings: [
      {
        level: 'WARN',
        msg: 'rename module installed but no typescript dependency detected — rename.mjs will fail',
      },
    ],
    readouts: [],
  };
}
