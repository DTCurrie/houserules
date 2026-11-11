import { createRequire } from 'node:module';
import { join } from 'node:path';

import type { Action, CheckResult, ModuleGroup } from '@houserules/api';
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
 * script exits at use, naming the fix, when no `typescript` resolves.
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

// Detection also counts a sub-package's tsconfig, but the script resolves from the working
// directory, so the root is what has to provide `typescript`.
function rootProvidesTypescript(ctx: Ctx): boolean {
  try {
    // createRequire resolves relative to a file path, and the file does not have to exist.
    createRequire(join(ctx.root, 'package.json')).resolve('typescript');
    return true;
  } catch {
    const declared = {
      ...ctx.rootPkg?.dependencies,
      ...ctx.rootPkg?.devDependencies,
    };
    return 'typescript' in declared;
  }
}

export function check(ctx: Ctx): CheckResult {
  if (rootProvidesTypescript(ctx)) return { findings: [], readouts: [] };
  return {
    findings: [
      {
        level: 'WARN',
        msg: 'rename module installed but typescript does not resolve from the repo root, so rename.mjs will fail when run there. Add typescript as a dev dependency at the repo root, or run it from a package that has it.',
      },
    ],
    readouts: [],
  };
}
