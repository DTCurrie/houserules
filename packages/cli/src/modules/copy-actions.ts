import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { Action, CopyAction, WriteAction } from '@agent-kit/api';
import { createPayloadBuilders } from '@agent-kit/api/internal';
import { KitError } from '../plan.js';
import { payloadPath } from '../paths.js';
import {
  PAYLOAD_IMPORTS_FILE,
  type PayloadImports,
} from '../payload-imports.js';

export { createPayloadBuilders };

/**
 * A directory-local `.gitignore` that ignores everything under it except itself, so the
 * exclusion travels with a clone without touching the repo's own `.gitignore`.
 *
 * @param commentLines The `# ...` lines explaining what the directory holds and why it is
 *   excluded, without the trailing `*`/`!.gitignore` body, which every caller shares.
 */
export function selfGitignoreAction(
  module: string,
  dest: string,
  commentLines: string[],
  reason: string,
): WriteAction {
  return {
    kind: 'write',
    dest,
    content: [...commentLines, '*', '!.gitignore', ''].join('\n'),
    module,
    reason,
  };
}

/**
 * Resolves `@agent-kit/payload`'s own built payload root, the one publish-time source for the
 * six shared libs. Every consumer that needs a `lib` copy, kit-owned modules and plugins alike,
 * derives it from here, so there is one source for a lib copy rather than several.
 */
function payloadLibRoot(): string {
  const require = createRequire(import.meta.url);
  const payloadPackageJson = require.resolve('@agent-kit/payload/package.json');
  return join(dirname(payloadPackageJson), 'payload-dist');
}

const kitBuilders = createPayloadBuilders(payloadPath());
const libBuilders = createPayloadBuilders(payloadLibRoot());

export const script = kitBuilders.script;
export const lib = libBuilders.lib;
export const skill = kitBuilders.skill;
export const agent = kitBuilders.agent;

/**
 * A Claude Code rule file. Claude Code loads `.claude/rules/` as memory, and a rule whose
 * frontmatter carries `paths:` globs loads only when a matching file is in the working set.
 * One without `paths:` is resident on every turn, so kit rules always ship with them.
 *
 * Split ownership, which is why this is a `body` action and not a `copy`. The `paths:` list
 * is yours, because only your repo knows which suffixes it uses, and the kit's own advise
 * text tells you to trim it. Everything below the closing `---` is the kit's, and stays
 * update-refreshable however far the frontmatter diverges. See {@link BodyAction}.
 */
export const rule = kitBuilders.rule;

/**
 * A pull-only doc. Unlike {@link rule}, `.claude/reference/` is not auto-loaded, so the doc
 * costs nothing until something reads it. That is why this is separate: prose too long to
 * keep resident lands here, and a path-scoped rule links to it, which keeps even the pointer
 * conditional.
 */
export const reference = kitBuilders.reference;

export const template = kitBuilders.template;

/**
 * The lib copies `actions` imply, given the sidecar a plugin's payload build wrote for it.
 *
 * A copy action's `dest` mirrors the payload root one-for-one, so `.claude/scripts/foo.mjs`
 * corresponds to the sidecar key `scripts/foo.mjs`. Every lib basename `sidecar` names for that
 * key gets ONE copy from `@agent-kit/payload`, deduplicated across every action passed in, and
 * attributed to the module that declared the action which named it.
 *
 * Empty when `sidecar` names nothing, which is the compatibility path for a plugin published
 * before this mechanism existed.
 *
 * @param pluginName Named in the thrown error when a sidecar entry is stale.
 * @throws KitError when `sidecar` names a lib `@agent-kit/payload` does not ship. That happens
 *   when the plugin was built against a newer or older `@agent-kit/payload` than the one
 *   installed now.
 */
export function deriveLibActions(
  actions: Action[],
  sidecar: PayloadImports,
  pluginName: string,
): CopyAction[] {
  const seen = new Set<string>();
  const derived: CopyAction[] = [];
  for (const action of actions) {
    if (action.kind !== 'copy') continue;
    const key = action.dest.startsWith('.claude/')
      ? action.dest.slice('.claude/'.length)
      : action.dest;
    for (const name of sidecar.libs[key] ?? []) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!existsSync(join(payloadLibRoot(), 'scripts', 'lib', name))) {
        throw new KitError(
          `plugin "${pluginName}"'s ${PAYLOAD_IMPORTS_FILE} names lib "${name}" for ` +
            `${key}, which this @agent-kit/payload does not ship. Rebuild the plugin's ` +
            `payload (its package's \`build\` or \`build:payload\` script) against a ` +
            `compatible @agent-kit/payload version.`,
        );
      }
      derived.push(lib(action.module, name));
    }
  }
  return derived;
}
