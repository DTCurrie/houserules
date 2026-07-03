// rename module (claude-kit CLI): TS LanguageService semantic rename script.
// TypeScript repos only — the script hard-fails at import without `typescript`.

import { script } from './shared.mjs';

export const id = 'rename';
export const title = 'TS semantic rename script';
export const group = 'recommended';

export function hint(ctx) {
  return ctx.typescript
    ? 'TypeScript detected'
    : 'no TypeScript detected — skip';
}

export function defaultEnabled(ctx) {
  return ctx.typescript;
}

export function plan() {
  return [
    script(
      id,
      'rename.mjs',
      'project-wide symbol rename via the TS LanguageService',
    ),
  ];
}
