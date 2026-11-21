import { installedModuleIds } from '../../installed-modules.js';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Ctx } from '../../detect.js';
import type { CheckResult, Finding } from '@houserules/api';
import { compareSemver, parseSemver } from './semver.js';

export const MIN_NODE_MAJOR = 22;

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
      installedModuleIds(ctx.claude.houseConfig, ctx.claude.manifest)?.includes(
        'orchestrate',
      ) ?? false,
  },
  {
    version: '2.1.295',
    reason: 'the guard hooks use onFailure: "block"',
    applies: () => true,
  },
  {
    version: '2.1.299',
    reason:
      'orchestrate.workerTools or orchestratorTools holds a server-level tool pattern',
    applies: (ctx) => {
      const orchestrate = ctx.claude.houseConfig?.orchestrate;
      return [
        ...(orchestrate?.workerTools ?? []),
        ...(orchestrate?.orchestratorTools ?? []),
      ].some((tool) => SERVER_LEVEL_TOOL.test(tool));
    },
  },
  {
    version: '2.1.314',
    reason: 'guard-bash sees commands the Monitor tool starts',
    applies: () => true,
  },
  {
    version: '2.1.321',
    reason:
      'an agent pins model: fable, which means Fable 5.2 only from this version',
    applies: (ctx) => anyAgentPinsFable(ctx.root),
  },
];

const FABLE_PIN = /^model:\s*['"]?fable['"]?\s*$/m;

/** True when any `.claude/agents/*.md` frontmatter sets `model: fable`. */
function anyAgentPinsFable(root: string): boolean {
  const agentsDir = join(root, '.claude', 'agents');
  if (!existsSync(agentsDir)) return false;
  return readdirSync(agentsDir)
    .filter((name) => name.endsWith('.md'))
    .some((name) => {
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(
        readFileSync(join(agentsDir, name), 'utf8'),
      );
      return frontmatter !== null && FABLE_PIN.test(frontmatter[1] ?? '');
    });
}

function claudeVersion(): string | null {
  const result = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return (
    /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/.exec(
      result.stdout,
    )?.[0] ?? null
  );
}

function checkClaudeVersion(
  ctx: Ctx,
  running: string | null,
): { findings: Finding[]; readouts: string[] } {
  const parsedGates = GATES.map((gate) => {
    const parsed = parseSemver(gate.version);
    if (!parsed)
      throw new Error(
        `Claude Code gate version "${gate.version}" is not semver`,
      );
    return { gate, parsed };
  });
  const applicable = parsedGates.filter(({ gate }) => gate.applies(ctx));
  const { gate: highest, parsed: floor } = applicable.reduce((top, entry) =>
    compareSemver(entry.parsed, top.parsed) > 0 ? entry : top,
  );
  if (running === null)
    return {
      findings: [],
      readouts: [
        `INFO claude binary not found on PATH (floor ${highest.version})`,
      ],
    };
  const runningParsed = parseSemver(running);
  if (runningParsed === null)
    return {
      findings: [],
      readouts: [
        `INFO claude version "${running}" is not semver, so the floor was not checked`,
      ],
    };
  if (compareSemver(runningParsed, floor) < 0)
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
