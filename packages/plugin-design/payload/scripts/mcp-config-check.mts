#!/usr/bin/env node
/**
 * Checks that a wired-in Chrome DevTools MCP config obeys `chrome-devtools-mode/SKILL.md`'s
 * three edit-discipline clauses: the pinned server version and its non-`--slim` flags stay
 * exactly as houserules shipped them, and every wired-in client agrees with every other one.
 *
 * This reads whichever MCP config files a caller passes on the command line. It never reads
 * `.claude/mcp/*.json` itself, since that reference copy is not a client config and comparing
 * a reference file against itself would always pass.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  emptyReport,
  exitCodeFor,
  renderReport,
  type Report,
} from '@houserules/payload/findings';

const SERVER_NAME = 'chrome-devtools';
const PINNED_PACKAGE_PATTERN = /^chrome-devtools-mcp@\d+\.\d+\.\d+$/;
const REQUIRED_FLAGS = ['--headless', '--isolated', '--no-usage-statistics'];
const SLIM_FLAG = '--slim';

const DECLINED = [
  'whether a wired-in entry was edited by hand rather than pasted from .claude/mcp/, since ' +
    'only the current args are observable, not the edit history',
  "the project-scoped entry inside ~/.claude.json's `projects` map for one specific repo " +
    "path, since matching it needs the repo's own path. Only a top-level mcpServers entry " +
    'in that file is read',
  'whether the user was told to restart the server after a change, which is a communication ' +
    'step this checker has no way to observe',
];

export interface McpConfigFileInput {
  path: string;
  text: string;
}

interface ChromeDevtoolsEntry {
  path: string;
  args: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serversNode(parsed: unknown): Record<string, unknown> | undefined {
  if (!isRecord(parsed)) return undefined;
  if (isRecord(parsed.mcpServers)) return parsed.mcpServers;
  if (isRecord(parsed.servers)) return parsed.servers;
  return undefined;
}

function extractEntry(
  file: McpConfigFileInput,
): ChromeDevtoolsEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return undefined;
  }
  const servers = serversNode(parsed);
  const server = servers?.[SERVER_NAME];
  if (!isRecord(server) || !Array.isArray(server.args)) return undefined;
  const args = server.args.filter(
    (arg): arg is string => typeof arg === 'string',
  );
  return { path: file.path, args };
}

function pinnedPackageArg(args: string[]): string | undefined {
  return args.find((arg) => arg.startsWith('chrome-devtools-mcp@'));
}

/** Args with `--slim` removed, so two clients in different modes still compare as equal. */
function argsIgnoringSlim(args: string[]): string[] {
  return args.filter((arg) => arg !== SLIM_FLAG);
}

function checkPinnedVersion(entries: ChromeDevtoolsEntry[]): Report {
  const report = emptyReport();
  for (const entry of entries) {
    const pinned = pinnedPackageArg(entry.args);
    if (pinned === undefined) {
      report.findings.push({
        rule: 'design/mcp-config-pinned-version',
        level: 'error',
        file: entry.path,
        line: null,
        msg: `The chrome-devtools server has no chrome-devtools-mcp@<version> arg. It must stay pinned to the version houserules shipped.`,
      });
      continue;
    }
    if (!PINNED_PACKAGE_PATTERN.test(pinned)) {
      report.findings.push({
        rule: 'design/mcp-config-pinned-version',
        level: 'error',
        file: entry.path,
        line: null,
        msg: `${pinned} is not pinned to an exact version. Leave the pinned chrome-devtools-mcp@<version> exactly as shipped.`,
      });
    }
  }
  return report;
}

function checkRequiredFlags(entries: ChromeDevtoolsEntry[]): Report {
  const report = emptyReport();
  for (const entry of entries) {
    const missing = REQUIRED_FLAGS.filter((flag) => !entry.args.includes(flag));
    if (missing.length === 0) continue;
    report.findings.push({
      rule: 'design/mcp-config-required-flags',
      level: 'error',
      file: entry.path,
      line: null,
      msg: `Missing ${missing.join(', ')} on the chrome-devtools server. Only --slim may be added or removed; the rest stay as shipped.`,
    });
  }
  return report;
}

/**
 * Every wired-in client must agree on the chrome-devtools args, `--slim` aside.
 *
 * Entries are sorted by path before a baseline is chosen. Taking the caller's first argument
 * as the baseline made the finding depend on argv order rather than on file content, so the
 * same two disagreeing files blamed a different one depending on the order they were passed.
 * `verify:checker-determinism` catches exactly that, by running each checker again with its
 * inputs reversed.
 */
function checkClientsAgree(entries: ChromeDevtoolsEntry[]): Report {
  const report = emptyReport();
  if (entries.length < 2) return report;
  const ordered = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const [first, ...rest] = ordered;
  const baseline = argsIgnoringSlim(first!.args);
  for (const entry of rest) {
    const args = argsIgnoringSlim(entry.args);
    const agrees =
      args.length === baseline.length &&
      args.every((arg, index) => arg === baseline[index]);
    if (!agrees) {
      report.findings.push({
        rule: 'design/mcp-config-clients-agree',
        level: 'error',
        file: entry.path,
        line: null,
        msg: `${entry.path} disagrees with ${first!.path} on the chrome-devtools server args, outside of --slim. Edit every wired-in client so they do not disagree.`,
      });
    }
  }
  return report;
}

export function checkMcpConfigs(files: McpConfigFileInput[]): Report {
  const report = emptyReport();
  report.declined.push(...DECLINED);
  const entries = files
    .map(extractEntry)
    .filter((entry): entry is ChromeDevtoolsEntry => entry !== undefined);
  report.findings.push(...checkPinnedVersion(entries).findings);
  report.findings.push(...checkRequiredFlags(entries).findings);
  report.findings.push(...checkClientsAgree(entries).findings);
  return report;
}

function readInputs(paths: string[]): McpConfigFileInput[] {
  return paths.flatMap((path) => {
    try {
      return [{ path, text: readFileSync(path, 'utf8') }];
    } catch {
      return [];
    }
  });
}

function main(): void {
  const files = readInputs(process.argv.slice(2));
  const report = checkMcpConfigs(files);
  process.stdout.write(`${renderReport(report)}\n`);
  process.exit(exitCodeFor(report));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
