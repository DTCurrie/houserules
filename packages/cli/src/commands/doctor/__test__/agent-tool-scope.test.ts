import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useRepo } from '#test/repo';
import {
  checkAgentToolScope,
  grantedTools,
  grantsBash,
} from '../agent-tool-scope.js';

function writeAgent(root: string, name: string, text: string): void {
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(root, '.claude', 'agents', name), text);
}

function messages(root: string): string[] {
  return checkAgentToolScope(root).findings.map((finding) => finding.msg);
}

const UNBOUNDED_REVIEWER = [
  '---',
  "description: 'Read-only reviewer for a thing.'",
  'name: thing-reviewer',
  'tools: Read, Grep, Glob, Bash',
  '---',
  '',
  'You are the thing reviewer, a read-only check. Report what you find.',
  '',
].join('\n');

describe('grantedTools', () => {
  it('reads a comma-separated inline list', () => {
    const text = ['---', 'tools: Read, Grep, Bash', '---', '', 'body'].join(
      '\n',
    );

    expect(grantedTools(text)).toEqual(['Read', 'Grep', 'Bash']);
  });

  it('reads a YAML sequence on the following lines', () => {
    const text = [
      '---',
      'tools:',
      '  - Read',
      '  - Bash',
      'model: haiku',
      '---',
      '',
      'body',
    ].join('\n');

    expect(grantedTools(text)).toEqual(['Read', 'Bash']);
  });

  it('strips the quotes a YAML author may have used', () => {
    const text = ['---', 'tools: \'Read\', "Bash"', '---', '', 'body'].join(
      '\n',
    );

    expect(grantedTools(text)).toEqual(['Read', 'Bash']);
  });

  it('returns null when the frontmatter names no tools, which is a grant of all of them', () => {
    const text = ['---', 'name: open-agent', '---', '', 'body'].join('\n');

    expect(grantedTools(text)).toBe(null);
  });
});

describe('grantsBash', () => {
  it('treats an absent tools line as granting Bash, since the agent inherits every tool', () => {
    const text = ['---', 'name: open-agent', '---', '', 'body'].join('\n');

    expect(grantsBash(text)).toBe(true);
  });

  it('treats a wildcard as granting Bash', () => {
    const text = ['---', 'tools: *', '---', '', 'body'].join('\n');

    expect(grantsBash(text)).toBe(true);
  });

  it('is false for a tools list that omits Bash', () => {
    const text = ['---', 'tools: Read, Grep, Glob', '---', '', 'body'].join(
      '\n',
    );

    expect(grantsBash(text)).toBe(false);
  });
});

describe('checkAgentToolScope', () => {
  it('warns about a read-only agent that grants Bash and never bounds it', () => {
    const root = useRepo('pnpm-monorepo');
    writeAgent(root, 'thing-reviewer.md', UNBOUNDED_REVIEWER);

    expect(messages(root)).toEqual([
      '.claude/agents/thing-reviewer.md: calls itself read-only and grants Bash, but never says what Bash may not run. Name the commands it may run and close the set with "only", or list the ones it must never run.',
    ]);
  });

  it('accepts a denylist naming the commands it must never run', () => {
    const root = useRepo('pnpm-monorepo');
    writeAgent(
      root,
      'thing-reviewer.md',
      UNBOUNDED_REVIEWER +
        'You are read-only, so never run `add`, `remove`, or `render`.\n',
    );

    expect(messages(root)).toEqual([]);
  });

  it('accepts an allowlist that closes the set with "only"', () => {
    const root = useRepo('pnpm-monorepo');
    writeAgent(
      root,
      'thing-reviewer.md',
      UNBOUNDED_REVIEWER + 'Your `Bash` access is for `thing.mjs list` only.\n',
    );

    expect(messages(root)).toEqual([]);
  });

  it('stays quiet about an agent that grants Bash without claiming to be read-only', () => {
    const root = useRepo('pnpm-monorepo');
    writeAgent(
      root,
      'worker.md',
      [
        '---',
        'name: worker',
        'tools: Read, Edit, Write, Bash',
        '---',
        '',
        'You implement one slice and report back.',
        '',
      ].join('\n'),
    );

    expect(messages(root)).toEqual([]);
  });

  it('stays quiet about a read-only agent that was never granted Bash', () => {
    const root = useRepo('pnpm-monorepo');
    writeAgent(
      root,
      'reader.md',
      [
        '---',
        'name: reader',
        'tools: Read, Grep, Glob',
        '---',
        '',
        'You are read-only. Report what you find.',
        '',
      ].join('\n'),
    );

    expect(messages(root)).toEqual([]);
  });

  it('warns about an agent whose read-only claim is only in its description', () => {
    const root = useRepo('pnpm-monorepo');
    writeAgent(
      root,
      'thing-reviewer.md',
      [
        '---',
        "description: 'Read-only reviewer for a thing.'",
        'name: thing-reviewer',
        'tools: Read, Bash',
        '---',
        '',
        'Report the finding and the location.',
        '',
      ].join('\n'),
    );

    expect(messages(root)).toEqual([
      '.claude/agents/thing-reviewer.md: calls itself read-only and grants Bash, but never says what Bash may not run. Name the commands it may run and close the set with "only", or list the ones it must never run.',
    ]);
  });

  it('does not count a bound in the frontmatter, which is where nobody states a Bash limit', () => {
    const root = useRepo('pnpm-monorepo');
    writeAgent(
      root,
      'thing-reviewer.md',
      [
        '---',
        "description: 'Read-only reviewer. Never run add or remove.'",
        'name: thing-reviewer',
        'tools: Read, Bash',
        '---',
        '',
        'Report the finding and the location.',
        '',
      ].join('\n'),
    );

    expect(messages(root)).toEqual([
      '.claude/agents/thing-reviewer.md: calls itself read-only and grants Bash, but never says what Bash may not run. Name the commands it may run and close the set with "only", or list the ones it must never run.',
    ]);
  });

  it('reports how many agents it inspected so a clean run still says it ran', () => {
    const root = useRepo('pnpm-monorepo');
    writeAgent(root, 'a.md', UNBOUNDED_REVIEWER);
    writeAgent(root, 'b.md', UNBOUNDED_REVIEWER);

    expect(checkAgentToolScope(root).readouts).toEqual([
      'agent tool scope: 2 agent(s) inspected',
    ]);
  });

  it('returns nothing at all for a repo with no agents directory', () => {
    const root = useRepo('pnpm-monorepo');

    expect(checkAgentToolScope(root)).toEqual({ findings: [], readouts: [] });
  });
});
