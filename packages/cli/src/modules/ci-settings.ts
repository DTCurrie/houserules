import type { Action, ModuleGroup } from '@agent-kit/api';
import type { Ctx } from '../detect.js';

export const id = 'ci-settings';
export const title = 'Headless-run deny list (.claude/settings.ci.json)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'a settings file for CI: denies edits to workflows, the lockfile, build output, and pending changesets';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * The lockfile a package manager writes. Denying edits to it is the point of the entry, and
 * naming the wrong one denies nothing, so this tracks the same four managers `detectPackageManager`
 * recognizes. Bun is the one with two possible names, and `bun.lock` is the current default.
 */
const LOCKFILES: Record<string, string> = {
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
  bun: 'bun.lock',
  npm: 'package-lock.json',
};

function lockfileFor(ctx: Ctx): string {
  return LOCKFILES[ctx.packageManager?.name ?? 'npm'] ?? 'package-lock.json';
}

/**
 * Paths an unattended run must not rewrite. Each is a file a human owns for a reason that
 * outlives any one task: workflow definitions gate what CI is allowed to do, the lockfile
 * encodes a resolved dependency graph, build output is generated, and a pending changeset is
 * the release note a reviewer reads.
 */
function denyList(ctx: Ctx): string[] {
  return [
    'Edit(file_path=.github/**)',
    'Write(file_path=.github/**)',
    `Edit(file_path=${lockfileFor(ctx)})`,
    `Write(file_path=${lockfileFor(ctx)})`,
    'Edit(file_path=dist/**)',
    'Write(file_path=dist/**)',
    'Edit(file_path=.changeset/**)',
  ];
}

/**
 * A deny list for unattended runs, kept in a file of its own rather than merged into
 * `settings.json`.
 *
 * The split is the whole design. `settings.json` applies to interactive sessions too, and
 * denying `.changeset/**` there would break the `/changeset` skill on every ordinary change.
 * These restrictions are only correct when nobody is watching, so they ship where a CI job can
 * opt into them with `claude --settings .claude/settings.ci.json` and an interactive session
 * never sees them.
 *
 * This complements `guard-bash.mjs` rather than duplicating it. That hook blocks Bash commands,
 * so it stops `git commit` but not an Edit to a workflow file. This stops the edit.
 */
export function plan(ctx: Ctx): Action[] {
  return [
    {
      kind: 'write',
      dest: '.claude/settings.ci.json',
      content: `${JSON.stringify({ permissions: { deny: denyList(ctx) } }, null, 2)}\n`,
      reason: 'deny list for unattended runs, opt in with --settings',
      module: id,
    },
    {
      kind: 'advise',
      text: `CI deny list installed at .claude/settings.ci.json. It is NOT active on its own: pass it explicitly, as \`claude --settings .claude/settings.ci.json -p "<prompt>"\`, in the CI job that runs Claude unattended. It is deliberately separate from settings.json, because denying .changeset/** in an interactive session would break the /changeset skill. It denies edits to .github/**, ${lockfileFor(ctx)}, dist/**, and .changeset/**. Add your own generated or protected paths to the deny list, and note that the file is kit-owned, so \`update\` refreshes it and your edits are reported instead.`,
      module: id,
    },
  ];
}
