import { definePlugin } from '@agent-kit/cli/plugin';
import type { Action, ModuleDef, PluginApi } from '@agent-kit/cli/plugin';

/**
 * Ships the TypeScript type-system rule: `interface` for object shapes since they extend,
 * `type` for unions and computed types, and `unknown` plus a type guard instead of `any` for
 * untyped external data.
 *
 * Two sections were dropped from the source this rule was adapted from. Doc comments are
 * `code-comments.md`'s job, which already covers TSDoc form in more depth than a
 * per-language rule needs to restate. "Verify Your Work" (`pnpm check` / `pnpm test`) is
 * the CLAUDE.md managed region's job now, run once per turn rather than repeated in every
 * language rule that happens to load. A language rule that restates a rule the kit already
 * ships costs resident budget every time it loads to say something already said.
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
          text: 'TypeScript rule installed at .claude/rules/typescript.md. It is path-scoped via its `paths:` frontmatter (**/*.ts, **/*.mts, **/*.cts, not .tsx) — Claude Code loads it only when a matching source file is in the working set, so it adds nothing to the always-loaded surface. Keep the frontmatter — a rule file WITHOUT `paths:` is loaded on every turn.',
          module: id,
        },
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  typescriptModule(api),
]);
