import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { definePlugin } from '@claude-kit/cli/plugin';
import type { Action, Ctx, ModuleDef, PluginApi } from '@claude-kit/cli/plugin';

/**
 * Ships the comment-discipline rule: default to no comment, TSDoc for exported API,
 * `//` for everything else, and never a file header or a landmark divider.
 *
 * Delivered as a native path-scoped rule, verified against Claude Code 2.1.220. The body
 * loads only when a matching source file is in the working set, so it costs nothing on
 * the always-loaded surface and needs no CLAUDE.md pointer to maintain. Script-free and
 * hook-free, because the platform does the conditional loading.
 */
function codeCommentsModule(api: PluginApi): ModuleDef {
  const id = 'code-comments';
  return {
    id,
    title: 'Comment discipline rule (.claude/rules/code-comments.md)',
    group: 'optional',
    hint(): string {
      return 'path-scoped rule: TSDoc for exported API, no file headers or landmarks, no narration, 200-char cap';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.rule(
          id,
          'code-comments',
          'path-scoped comment discipline, loaded only when a source file is in play',
        ),
        {
          kind: 'advise',
          text: 'Comment rule installed at .claude/rules/code-comments.md. It is path-scoped via its `paths:` frontmatter — Claude Code loads it only when a matching source file is in the working set, so it adds nothing to the always-loaded surface (needs a build with path-scoped rules; verified on Claude Code 2.1.220). Trim `paths:` to the languages this repo actually has, and keep the frontmatter — a rule file WITHOUT `paths:` is loaded on every turn.',
          module: id,
        },
      ];
    },
  };
}

/**
 * The writing-voice rule for prose the agent authors: plain sentences, no semicolons, em
 * dashes rewritten away, filler cut, and exact content byte-preserved.
 *
 * Scoped to markdown AND to the same source extensions as code-comments, because a code
 * comment is prose this rule governs. Source globs are not optional decoration: both
 * `code-comments.md` and `testing.md` defer sentence-level voice to this rule, so a
 * markdown-only `paths:` list leaves those pointers dangling on every source file.
 * Dot-directories are listed explicitly, because `**` does not reliably descend into them.
 *
 * Companion to code-comments, which decides whether a comment should exist at all.
 * Neither rule restates the other.
 */
function proseVoiceModule(api: PluginApi): ModuleDef {
  const id = 'prose-voice';
  return {
    id,
    title: 'Writing voice rule (.claude/rules/prose-voice.md)',
    group: 'optional',
    hint(): string {
      return 'path-scoped rule: plain sentences, no semicolons, em dashes rewritten away, filler cut';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.rule(
          id,
          'prose-voice',
          'path-scoped writing voice, loaded when a markdown or source file is in play',
        ),
        {
          kind: 'advise',
          text: 'Writing voice rule installed at .claude/rules/prose-voice.md. It applies to prose the agent authors: changesets, plans, docs, PR bodies, and the sentences inside code comments. The `paths:` list covers markdown plus the same source extensions as code-comments, since those rules defer sentence-level voice to this one. The `paths:` frontmatter is also what keeps it off the always-loaded surface, so keep it. A rule file WITHOUT `paths:` loads on every turn. Dot-directories are listed separately because `**` does not reliably descend into them.',
          module: id,
        },
      ];
    },
  };
}

// The frontmatter `name`, not the `output-prose` filename slug. Claude Code matches
// outputStyle on the name, so the slug silently falls back to Default.
const STYLE_NAME = 'Prose';
const STYLE_SLUG = 'output-prose';

interface OutputStyleSettings {
  outputStyle?: string;
  [key: string]: unknown;
}

function readSettings(path: string): OutputStyleSettings | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const activeOutputStyle = (settings: OutputStyleSettings | null | undefined) =>
  typeof settings?.outputStyle === 'string' ? settings.outputStyle : null;

function activeStyle(ctx: Ctx): string | null {
  const local = readSettings(join(ctx.root, '.claude', 'settings.local.json'));
  return activeOutputStyle(local) ?? activeOutputStyle(ctx.claude.settings);
}

/**
 * An output style that cuts response tokens, mostly by preferring fragments to full sentences
 * and by removing packaging: no preamble, no recap, no restated question.
 *
 * Shares `prose-voice`'s voice and inverts one of its trade-offs. That rule governs prose
 * committed to a repo, where a reader cannot ask a follow-up, so precision outranks brevity.
 * This governs replies to someone who can ask, so brevity leads until it would cost
 * correctness.
 *
 * Installing the file does not activate it. Output styles are user-selected, and the kit never
 * writes `outputStyle` into settings.json, which would clobber the user's choice.
 */
function outputProseModule(api: PluginApi): ModuleDef {
  const id = 'output-prose';
  return {
    id,
    title: 'Prose output style (token-lean responses)',
    group: 'optional',
    hint(): string {
      return 'markedly shorter replies at some readability cost: fragments, no preamble, exact content preserved. Activate via /config when wanted';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.file({
          module: id,
          srcRel: 'output-styles/output-prose.md',
          dest: '.claude/output-styles/output-prose.md',
          reason: 'prose output style (opt-in via /config)',
        }),
        {
          kind: 'advise',
          text: 'Prose output style installed but NOT active: enable via /config → Output style → "Prose", or set "outputStyle": "Prose" in settings.local.json (the exact style name, not the output-prose filename).',
          module: id,
        },
      ];
    },
    // Installing the style file does not activate it. Output styles are user-selected.
    check(ctx: Ctx) {
      const active = activeStyle(ctx);

      if (active === STYLE_NAME)
        return {
          findings: [],
          readouts: [`output-prose: ACTIVE (outputStyle "${STYLE_NAME}")`],
        };

      if (active === STYLE_SLUG)
        return {
          findings: [
            {
              level: 'WARN' as const,
              msg: `output-prose: outputStyle "${STYLE_SLUG}" is the filename slug and silently falls back to Default — set outputStyle to "${STYLE_NAME}" (the frontmatter name)`,
            },
          ],
          readouts: [],
        };

      if (active)
        return {
          findings: [],
          readouts: [
            `output-prose: INACTIVE — installed, but outputStyle "${active}" is active instead`,
          ],
        };

      return {
        findings: [],
        readouts: [
          `output-prose: INACTIVE — installed but no outputStyle set; activate via /config → Output style → "${STYLE_NAME}", or set "outputStyle": "${STYLE_NAME}"`,
        ],
      };
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  codeCommentsModule(api),
  proseVoiceModule(api),
  outputProseModule(api),
]);
