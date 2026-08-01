// rename module (claude-kit CLI): TS LanguageService semantic rename script.
// TypeScript repos only — the script hard-fails at import without `typescript`.

import type { Action, Ctx, ModuleGroup } from '../types.js';
import { script } from './shared.js';

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

export function plan(): Action[] {
  return [
    script(
      id,
      'rename.mjs',
      'project-wide symbol rename via the TS LanguageService',
    ),
  ];
}
