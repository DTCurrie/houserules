import { spawnSync } from 'node:child_process';

import type { Ctx } from '../../detect.js';
import type { CheckResult, Finding } from '@houserules/api';

const MIN_NODE_MAJOR = 20;

const SERVER_LEVEL_TOOL = /^mcp__[^_]+(__\*)?$/;

interface ClaudeGate {
  version: string;
  reason: string;
  applies(ctx: Ctx): boolean;
}

const GATES: readonly ClaudeGate[] = [
  {
    version: '2.1.288',
    reason:
      'path-scoped rules and nested CLAUDE.md files load on Write and Edit, not only Read',
    applies: () => true,
  },
  {
    version: '2.1.292',
    reason: 'the orchestrate skill passes the Agent tool effort parameter',
    applies: (ctx) =>
      ctx.claude.manifest?.modules.includes('orchestrate') ?? false,
  },
  {
    version: '2.1.295',
    reason: 'the guard hooks use onFailure: "block"',
    applies: () => true,
  },
  {
    version: '2.1.299',
    reason: 'orchestrate.workerTools holds a server-level tool pattern',
    applies: (ctx) =>
      (ctx.claude.houseConfig?.orchestrate?.workerTools ?? []).some((tool) =>
        SERVER_LEVEL_TOOL.test(tool),
      ),
  },
];

function parseVersion(version: string): number[] {
  return version.split('.').map(Number);
}

/** Numeric per-segment comparison, since "2.1.9" sorts above "2.1.288" as a string. */
function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let i = 0; i < leftParts.length; i++) {
    const difference = (leftParts[i] ?? 0) - (rightParts[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function claudeVersion(): string | null {
  const result = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return /\d+\.\d+\.\d+/.exec(result.stdout)?.[0] ?? null;
}

function checkClaudeVersion(
  ctx: Ctx,
  running: string | null,
): { findings: Finding[]; readouts: string[] } {
  const applicable = GATES.filter((gate) => gate.applies(ctx));
  const highest = applicable.reduce((top, gate) =>
    compareVersions(gate.version, top.version) > 0 ? gate : top,
  );
  if (running === null)
    return {
      findings: [],
      readouts: [
        `INFO claude binary not found on PATH (floor ${highest.version})`,
      ],
    };
  if (compareVersions(running, highest.version) < 0)
    return {
      findings: [
        {
          level: 'WARN',
          msg: `claude ${running} < ${highest.version}: ${highest.reason}. Update Claude Code`,
        },
      ],
      readouts: [],
    };
  return {
    findings: [],
    readouts: [`claude ${running} (floor ${highest.version})`],
  };
}

/**
 * The host preconditions houserules cannot run without.
 *
 * @param options.claudeVersion Injects the running Claude Code version, where
 *   `null` means no binary. Omit the key to probe `claude --version`.
 */
export function checkEnvironment(
  ctx: Ctx,
  options?: { claudeVersion?: string | null },
): CheckResult {
  const findings: Finding[] = [];
  const major = process.versions.node.split('.').map(Number)[0];
  if (major === undefined || major < MIN_NODE_MAJOR)
    findings.push({
      level: 'ERROR',
      msg: `node ${process.versions.node} < ${MIN_NODE_MAJOR}`,
    });
  if (!ctx.git.isRepo)
    findings.push({ level: 'ERROR', msg: 'not a git work tree' });
  const running =
    options && 'claudeVersion' in options
      ? (options.claudeVersion ?? null)
      : claudeVersion();
  const claude = checkClaudeVersion(ctx, running);
  return {
    findings: [...findings, ...claude.findings],
    readouts: claude.readouts,
  };
}
