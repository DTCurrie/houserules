/**
 * The root `package.json` `prepare` script that runs `houserules update --sync` on every
 * dependency install, so a fresh clone or a bumped pin has its payload on disk before any
 * session starts. `init` and `update` plan and apply it; `doctor` reports its absence and
 * `doctor --fix` restores it. `update --sync` never makes this edit.
 *
 * Seam for phase 3 of the ignored-payload plan: the shapes below are fixed, the bodies are
 * the implementing slice's.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The command the `prepare` script runs. */
export const PREPARE_COMMAND = 'houserules update --sync';

/** The joiner used when appending {@link PREPARE_COMMAND} to an existing `prepare` script. */
const PREPARE_JOINER = ' && ';

/**
 * What planning found in the root `package.json`, and what applying would do.
 *
 * - `absent`: no root `package.json`. Nothing to do, nothing to report.
 * - `unparseable`: the file does not parse as JSON. Reported, never rewritten.
 * - `no-dependency`: `@houserules/cli` is in neither `dependencies` nor `devDependencies`, so
 *   no script is written (the command would fail every teammate's install without a global
 *   binary). `init`/`update` say so in one plan line, `doctor` stays quiet.
 * - `wired`: the `prepare` script already contains {@link PREPARE_COMMAND}. Left alone.
 * - `add`: no `prepare` script. `after` is {@link PREPARE_COMMAND}.
 * - `append`: a `prepare` script without the command. `after` is
 *   `before + PREPARE_JOINER + PREPARE_COMMAND`.
 *
 * For `add` and `append`, `text` is the whole new file: only the `scripts.prepare` key changes
 * (a missing `scripts` object is created), indentation and the trailing newline are kept.
 */
export type PrepareScriptPlan =
  | { kind: 'absent' }
  | { kind: 'unparseable'; message: string }
  | { kind: 'no-dependency' }
  | { kind: 'wired'; current: string }
  | { kind: 'add'; after: string; text: string }
  | { kind: 'append'; before: string; after: string; text: string };

/** The repo-relative path the plan reads and writes. */
export const PACKAGE_JSON = 'package.json';

const CLI_PACKAGE = '@houserules/cli';
const DEFAULT_INDENT = 2;

function hasCliDependency(manifest: Record<string, unknown>): boolean {
  return [manifest.dependencies, manifest.devDependencies].some(
    (group) =>
      typeof group === 'object' &&
      group !== null &&
      CLI_PACKAGE in (group as Record<string, unknown>),
  );
}

function detectIndent(raw: string): string | number {
  const match = /^([ \t]+)\S/m.exec(raw);
  if (!match) return DEFAULT_INDENT;
  return match[1]!.startsWith('\t') ? '\t' : match[1]!.length;
}

function withPrepare(
  raw: string,
  manifest: Record<string, unknown>,
  prepare: string,
): string {
  const scripts =
    typeof manifest.scripts === 'object' && manifest.scripts !== null
      ? (manifest.scripts as Record<string, unknown>)
      : {};
  scripts.prepare = prepare;
  manifest.scripts = scripts;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const body = JSON.stringify(manifest, null, detectIndent(raw)).replace(
    /\n/g,
    eol,
  );
  return /\n$/.test(raw) ? body + eol : body;
}

/** Reads `<root>/package.json` and decides what the `prepare` edit would be. Never writes. */
export function planPrepareScript(root: string): PrepareScriptPlan {
  const path = join(root, PACKAGE_JSON);
  if (!existsSync(path)) return { kind: 'absent' };

  const raw = readFileSync(path, 'utf8');
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return {
      kind: 'unparseable',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (typeof manifest !== 'object' || manifest === null)
    return { kind: 'unparseable', message: 'package.json is not an object' };
  if (!hasCliDependency(manifest)) return { kind: 'no-dependency' };

  const scripts = manifest.scripts as Record<string, unknown> | undefined;
  const before = scripts?.prepare;
  if (typeof before !== 'string' || before === '') {
    return {
      kind: 'add',
      after: PREPARE_COMMAND,
      text: withPrepare(raw, manifest, PREPARE_COMMAND),
    };
  }
  if (before.includes(PREPARE_COMMAND))
    return { kind: 'wired', current: before };

  const after = before + PREPARE_JOINER + PREPARE_COMMAND;
  return {
    kind: 'append',
    before,
    after,
    text: withPrepare(raw, manifest, after),
  };
}

/**
 * Writes `plan.text` to `<root>/package.json` for an `add` or `append` plan, and does nothing
 * for every other kind. Returns true when it wrote.
 */
export function applyPrepareScript(
  root: string,
  plan: PrepareScriptPlan,
): boolean {
  if (plan.kind !== 'add' && plan.kind !== 'append') return false;
  writeFileSync(join(root, PACKAGE_JSON), plan.text);
  return true;
}
