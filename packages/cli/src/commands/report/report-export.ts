import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { HouseError } from '../../house-error.js';
import type { ReportDocument } from './report-document.js';

const SUBCOMMAND_TOOLS = new Set(['git', 'gh']);
const MODULE_SIGNATURE = /^Cannot find module '([^']+)'$/;
const SCRIPT_SIGNATURE = /^missing script: (.+)$/;
const REDACTED_SIGNATURE = 'stderr line (redacted)';
// A leading `NAME=value` pair, whose value is often a path.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
const ASSIGNMENT_ONLY = '(assignment)';
const EMPTY_COMMAND = '(empty)';

// Shell punctuation that can precede the executable: subshell and group openers, quotes.
function bareToken(token: string): string {
  return token.replace(/^[({'"`]+/, '').replace(/['"`]+$/, '');
}

// A token with a slash is a path, which may name a machine, a user, or a repo. Keep what it
// ran, which is the basename, never where it lived.
function nameOf(token: string): string {
  const bare = bareToken(token);
  return bare.includes('/') ? basename(bare) : bare;
}

// A leading assignment, or bare punctuation such as a lone `(` or `{`, precedes the executable.
function isPrefixToken(token: string): boolean {
  return ENV_ASSIGNMENT.test(token) || bareToken(token) === '';
}

function commandFamily(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return EMPTY_COMMAND;
  let index = 0;
  while (index < tokens.length && isPrefixToken(tokens[index] ?? ''))
    index += 1;
  const first = tokens[index];
  if (first === undefined) return ASSIGNMENT_ONLY;
  const name = nameOf(first);
  const second = tokens[index + 1];
  if (second !== undefined && SUBCOMMAND_TOOLS.has(name))
    return `${name} ${nameOf(second)}`;
  return name;
}

function redactSignature(signature: string): string {
  const module = MODULE_SIGNATURE.exec(signature);
  if (module) return `Cannot find module '${basename(module[1] ?? '')}'`;
  const script = SCRIPT_SIGNATURE.exec(signature);
  if (script) return `missing script: ${basename(script[1] ?? '')}`;
  return REDACTED_SIGNATURE;
}

function redactSignatures(
  signatures: { signature: string; count: number }[],
): { signature: string; count: number }[] {
  const merged = new Map<string, number>();
  for (const { signature, count } of signatures) {
    const redacted = redactSignature(signature);
    merged.set(redacted, (merged.get(redacted) ?? 0) + count);
  }
  return [...merged].map(([signature, count]) => ({ signature, count }));
}

/**
 * Returns a copy with every command reduced to its family and every crash signature reduced
 * to a module basename or a fixed placeholder. The input is not mutated.
 */
export function redactDocument(document: ReportDocument): ReportDocument {
  return {
    ...document,
    hooks: {
      ...document.hooks,
      crashSignatures: redactSignatures(document.hooks.crashSignatures),
    },
    guard: document.guard.map((block) => ({
      ...block,
      blockedCommand: commandFamily(block.blockedCommand),
    })),
    friction: {
      ...document.friction,
      denials: document.friction.denials.map((denial) => ({
        ...denial,
        command: commandFamily(denial.command),
      })),
      retryRuns: document.friction.retryRuns.map((run) => ({
        ...run,
        command: commandFamily(run.command),
      })),
    },
  };
}

/** Writes the document as pretty JSON, creating parent directories. */
export function writeExportFile(path: string, document: ReportDocument): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
}

function isReportDocument(value: unknown): value is ReportDocument {
  if (typeof value !== 'object' || value === null) return false;
  const { meta, tokens } = value as { meta?: unknown; tokens?: unknown };
  if (typeof meta !== 'object' || meta === null) return false;
  const { label, generatedAt } = meta as Record<string, unknown>;
  if (typeof label !== 'string' || typeof generatedAt !== 'string')
    return false;
  if (typeof tokens !== 'object' || tokens === null) return false;
  const { totals } = tokens as { totals?: unknown };
  return typeof totals === 'object' && totals !== null;
}

function readImportFile(path: string): ReportDocument {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new HouseError(
      `Cannot read ${path}: the file is missing or unreadable.`,
      { cause },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new HouseError(`Cannot import ${path}: the file is not valid JSON.`, {
      cause,
    });
  }
  if (!isReportDocument(parsed))
    throw new HouseError(
      `Cannot import ${path}: the file is not a houserules report export.`,
    );
  return parsed;
}

/** Reads and validates each file in order. Throws `HouseError` naming the first bad path. */
export function readImportFiles(paths: string[]): ReportDocument[] {
  return paths.map(readImportFile);
}
