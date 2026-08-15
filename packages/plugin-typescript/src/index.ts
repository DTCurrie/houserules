import { definePlugin } from '@houserules/api';
import type { Action, ModuleDef, PluginApi } from '@houserules/api';

/**
 * Ships the TypeScript type-system rule: `interface` for object shapes since they extend,
 * `type` for unions and computed types, and `unknown` plus a type guard instead of `any` for
 * untyped external data.
 *
 * Doc-comment form and the "Verify Your Work" gate are each owned elsewhere, by
 * `code-comments.md` and the CLAUDE.md managed region respectively, so this rule does not
 * restate either.
 *
 * Delivered as a native path-scoped rule. The body loads only when a matching source file
 * is in the working set, so it costs nothing on the always-loaded surface.
 */
function typescriptModule(api: PluginApi): ModuleDef {
  const id = 'typescript';
  return {
    id,
    title: 'TypeScript rule (.claude/rules/typescript.md)',
    group: 'optional',
    hint(): string {
      return 'path-scoped rule: interface vs type, unknown over any, assumes strict: true';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.rule(
          id,
          'typescript',
          'path-scoped TypeScript type-system rule, loaded only when a matching source file is in play',
        ),
        {
          kind: 'advise',
          text: 'TypeScript rule installed at .claude/rules/typescript.md. It is path-scoped via its `paths:` frontmatter (**/*.ts, **/*.mts, **/*.cts, **/*.tsx, **/*.svelte, **/*.svelte.ts). Claude Code loads it only when a matching source file is in the working set, so it adds nothing to the always-loaded surface. Keep the frontmatter — a rule file WITHOUT `paths:` is loaded on every turn.',
          module: id,
        },
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  typescriptModule(api),
]);
