import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { grantedTools } from './agent-tool-scope.js';
import type { CheckResult, Finding } from '@houserules/api';

const MCP_TOOL = /\bmcp__[A-Za-z0-9_-]+?__[A-Za-z0-9_-]+/g;

function listMarkdown(dir: string): string[] {
  try {
    return readdirSync(dir).filter((file) => file.endsWith('.md'));
  } catch {
    return [];
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function serverOf(tool: string): string {
  return tool.slice(0, tool.indexOf('__', 'mcp__'.length));
}

function isCovered(granted: string[], tool: string): boolean {
  const server = serverOf(tool);
  return [tool, server, `${server}__*`].some((entry) =>
    granted.includes(entry),
  );
}

/**
 * Warns when a rule names an `mcp__<server>__<tool>` that an installed `task-worker*.md`
 * does not grant, by exact name or by an `mcp__<server>` or `mcp__<server>__*` pattern.
 * A worker with no `tools:` line inherits every tool and is always covered.
 */
export function checkWorkerToolCoverage(root: string): CheckResult {
  const rulesDir = join(root, '.claude', 'rules');
  const agentsDir = join(root, '.claude', 'agents');
  const ruleTools = listMarkdown(rulesDir).flatMap((rule) => {
    const text = readText(join(rulesDir, rule));
    const tools = text === null ? [] : (text.match(MCP_TOOL) ?? []);
    return [...new Set(tools)].map((tool) => ({ rule, tool }));
  });
  const findings: Finding[] = [];
  if (ruleTools.length === 0) return { findings, readouts: [] };

  const workers = listMarkdown(agentsDir).filter((file) =>
    file.startsWith('task-worker'),
  );
  for (const worker of workers) {
    const text = readText(join(agentsDir, worker));
    const granted = text === null ? null : grantedTools(text);
    if (granted === null) continue;
    for (const { rule, tool } of ruleTools) {
      if (isCovered(granted, tool)) continue;
      findings.push({
        level: 'WARN',
        msg: `.claude/rules/${rule} names ${tool}, but .claude/agents/${worker} does not grant it. Add ${tool} or ${serverOf(tool)} to orchestrate.workerTools in .claude/houserules.config.json, then run houserules update.`,
      });
    }
  }
  return { findings, readouts: [] };
}
