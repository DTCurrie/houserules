import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useRepo } from '#test/repo';
import { checkWorkerToolCoverage } from '../worker-tool-coverage.js';

function stage(root: string, files: { rule?: string; worker?: string }): void {
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  if (files.rule !== undefined)
    writeFileSync(join(root, '.claude', 'rules', 'svelte.md'), files.rule);
  if (files.worker !== undefined)
    writeFileSync(
      join(root, '.claude', 'agents', 'task-worker.md'),
      files.worker,
    );
}

const RULE_NAMING_TOOL = 'Run `mcp__x__y` over every file.\n';

function workerWithTools(toolsLine: string | null): string {
  const tools = toolsLine === null ? [] : [`tools: ${toolsLine}`];
  return ['---', 'name: task-worker', ...tools, '---', '', 'body', ''].join(
    '\n',
  );
}

function messages(root: string): string[] {
  return checkWorkerToolCoverage(root).findings.map((finding) => finding.msg);
}

describe('checkWorkerToolCoverage', () => {
  it('warns when a rule names an MCP tool the worker does not grant', () => {
    const root = useRepo('pnpm-monorepo');
    stage(root, {
      rule: RULE_NAMING_TOOL,
      worker: workerWithTools('Read, Edit, Bash'),
    });

    expect(messages(root)).toEqual([
      '.claude/rules/svelte.md names mcp__x__y, but .claude/agents/task-worker.md does not grant it. Add mcp__x__y or mcp__x to orchestrate.workerTools in .claude/houserules.config.json, then run houserules update.',
    ]);
  });

  it('reports the finding at WARN level', () => {
    const root = useRepo('pnpm-monorepo');
    stage(root, {
      rule: RULE_NAMING_TOOL,
      worker: workerWithTools('Read, Edit, Bash'),
    });

    expect(checkWorkerToolCoverage(root).findings.map((f) => f.level)).toEqual([
      'WARN',
    ]);
  });

  it('accepts the exact tool name on the tools line', () => {
    const root = useRepo('pnpm-monorepo');
    stage(root, {
      rule: RULE_NAMING_TOOL,
      worker: workerWithTools('Read, mcp__x__y'),
    });

    expect(messages(root)).toEqual([]);
  });

  it('accepts the server pattern mcp__x', () => {
    const root = useRepo('pnpm-monorepo');
    stage(root, {
      rule: RULE_NAMING_TOOL,
      worker: workerWithTools('Read, mcp__x'),
    });

    expect(messages(root)).toEqual([]);
  });

  it('accepts the wildcard pattern mcp__x__*', () => {
    const root = useRepo('pnpm-monorepo');
    stage(root, {
      rule: RULE_NAMING_TOOL,
      worker: workerWithTools('Read, mcp__x__*'),
    });

    expect(messages(root)).toEqual([]);
  });

  it('does not accept a pattern for a different server', () => {
    const root = useRepo('pnpm-monorepo');
    stage(root, {
      rule: RULE_NAMING_TOOL,
      worker: workerWithTools('Read, mcp__xy'),
    });

    expect(messages(root)).toHaveLength(1);
  });

  it('treats a worker with no tools line as covered', () => {
    const root = useRepo('pnpm-monorepo');
    stage(root, { rule: RULE_NAMING_TOOL, worker: workerWithTools(null) });

    expect(messages(root)).toEqual([]);
  });

  it('finds nothing when no rule names an MCP tool', () => {
    const root = useRepo('pnpm-monorepo');
    stage(root, {
      rule: 'Keep functions short.\n',
      worker: workerWithTools('Read, Edit, Bash'),
    });

    expect(checkWorkerToolCoverage(root)).toEqual({
      findings: [],
      readouts: [],
    });
  });

  it('finds nothing when no task-worker is installed', () => {
    const root = useRepo('pnpm-monorepo');
    stage(root, { rule: RULE_NAMING_TOOL });

    expect(messages(root)).toEqual([]);
  });
});
