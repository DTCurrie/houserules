import { beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo, useRepo } from '#test/repo';
import { runScript } from '#test/run';

const SCRIPT = '.claude/scripts/guard-bash.mjs';
const KIT_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const payload = (command: string): string =>
  JSON.stringify({ tool_input: { command } });

function withConfig(root: string, guard: Record<string, unknown>): void {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude/houserules.config.json'),
    JSON.stringify({ version: 2, guard, targets: [] }),
  );
}

function sidechainTurn() {
  return {
    type: 'assistant',
    isSidechain: true,
    message: { role: 'assistant', content: [] },
  };
}

function mainTurn() {
  return {
    type: 'assistant',
    isSidechain: false,
    message: { role: 'assistant', content: [] },
  };
}

function writeTranscript(records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'subagent-write-gate-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

function writeGatePayload(command: string, transcriptPath?: string): string {
  return JSON.stringify({
    tool_input: { command },
    transcript_path: transcriptPath,
  });
}

describe('guard-bash', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it.each([
    { cmd: 'git commit -m x' },
    { cmd: 'git push origin main' },
    { cmd: 'git -C /x push' },
    { cmd: 'git stash' },
    { cmd: 'gh pr create --fill' },
    { cmd: 'git -C /repo commit -m x' },
    { cmd: 'git -c user.name=x commit -m y' },
    { cmd: 'git --no-pager commit' },
    { cmd: 'git -C /repo stash' },
    { cmd: 'git add -A && git commit -m x' },
    { cmd: 'make build; git commit -m done' },
  ])('blocks "$cmd" by default', ({ cmd }) => {
    const r = runScript(root, SCRIPT, { input: payload(cmd) });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Blocked by houserules guard/);
  });

  it.each([
    { cmd: 'ls -la' },
    { cmd: 'git status' },
    { cmd: 'git log --oneline' },
    { cmd: 'pnpm run build' },
    { cmd: 'grep -rn "git commit" .' },
    { cmd: 'echo "remember to git commit when done"' },
    { cmd: 'node -e \'console.log("git stash")\'' },
    { cmd: 'rg "git push" src/' },
    { cmd: 'git log --grep "git commit"' },
  ])(
    'allows "$cmd" by default, since flags and quoted arguments must not be mistaken for the guarded subcommand',
    ({ cmd }) => {
      const r = runScript(root, SCRIPT, { input: payload(cmd) });
      expect(r.status, r.stderr).toBe(0);
    },
  );

  it('blocks by default even without a houserules.config.json, since the payload script falls back to hardcoded defaults', () => {
    const bare = useRepo('non-js');
    const r = spawnSync(
      process.execPath,
      [join(KIT_ROOT, 'payload-dist/scripts/guard-bash.mjs')],
      {
        cwd: bare,
        input: payload('git commit -m x'),
        encoding: 'utf8',
      },
    );
    expect(r.status).toBe(2);
  });

  it('allows a rule that config disables, while leaving the other defaults on', () => {
    withConfig(root, { gitStash: false });
    expect(
      runScript(root, SCRIPT, { input: payload('git stash') }).status,
    ).toBe(0);
    expect(
      runScript(root, SCRIPT, { input: payload('git commit -m x') }).status,
    ).toBe(2);
  });

  it('blocks a command matching a custom rule and reports its message', () => {
    withConfig(root, {
      custom: [
        { pattern: '\\bdocker\\s+system\\s+prune\\b', message: 'ask first' },
      ],
    });
    const r = runScript(root, SCRIPT, {
      input: payload('docker system prune -f'),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ask first/);
  });

  it('allows Bash to proceed when a custom rule has an invalid regex', () => {
    withConfig(root, { custom: [{ pattern: '(unclosed' }] });
    expect(runScript(root, SCRIPT, { input: payload('ls') }).status).toBe(0);
  });

  it('allows Bash to proceed on stdin that is not valid JSON', () => {
    expect(runScript(root, SCRIPT, { input: 'not json at all' }).status).toBe(
      0,
    );
  });
});

describe('subagent-write-gate', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it.each([
    { cmd: 'node .claude/scripts/backlog-log.mjs add API area "title"' },
    { cmd: 'node .claude/scripts/backlog-log.mjs remove abc123 API "dup"' },
    {
      cmd: 'node .claude/scripts/backlog-log.mjs update abc123 API "new title"',
    },
    { cmd: 'node .claude/scripts/backlog-log.mjs move abc123 CLI' },
    { cmd: 'node .claude/scripts/backlog-log.mjs render' },
    { cmd: 'node .claude/scripts/decision-log.mjs decide "use zod"' },
    { cmd: 'node .claude/scripts/decision-log.mjs supersede abc123 "why"' },
    { cmd: 'node .claude/scripts/decision-log.mjs amend abc123 "why"' },
    { cmd: 'node .claude/scripts/decision-log.mjs move abc123 CLI' },
    { cmd: 'node .claude/scripts/decision-log.mjs rescope abc123 CLI' },
    { cmd: 'node .claude/scripts/decision-log.mjs render' },
    {
      cmd: 'node .claude/scripts/changeset-write.mjs --pkg foo --summary "x"',
    },
    { cmd: 'node .claude/scripts/changeset-write.mjs --empty --summary "x"' },
    { cmd: 'tee .claude/ledgers/BACKLOG.md < /dev/null' },
    { cmd: 'tee .claude/ledgers/DECISIONS.md < /dev/null' },
    { cmd: "sed -i '' 's/x/y/' .claude/ledgers/BACKLOG.md" },
    { cmd: 'echo "manual edit" >> .claude/ledgers/BACKLOG.md' },
    { cmd: 'echo "fake" > .claude/ledgers/backlog.jsonl' },
    { cmd: 'echo "fake" > .claude/ledgers/decisions.jsonl' },
    { cmd: 'cat notes.txt | tee .claude/ledgers/BACKLOG.md' },
    { cmd: 'echo "1.0.0" > .changeset/my-change.md' },
    { cmd: 'rm .changeset/config.json && echo "{}" > .changeset/config.json' },
  ])('refuses "$cmd" from a subagent turn', ({ cmd }) => {
    const transcript = writeTranscript([sidechainTurn()]);

    const r = runScript(root, SCRIPT, {
      input: writeGatePayload(cmd, transcript),
    });

    expect(r.status).toBe(2);
  });

  it.each([
    { cmd: 'node .claude/scripts/backlog-log.mjs list' },
    { cmd: 'node .claude/scripts/backlog-log.mjs show abc123' },
    { cmd: 'node .claude/scripts/decision-log.mjs list' },
    { cmd: 'node .claude/scripts/decision-log.mjs show abc123' },
    { cmd: 'node .claude/scripts/decision-log.mjs ancestry abc123' },
    { cmd: 'node .claude/scripts/decision-log.mjs current CLI' },
    { cmd: 'cat .claude/ledgers/BACKLOG.md' },
    { cmd: 'grep -rn "duplicate" .claude/ledgers/backlog.jsonl' },
    { cmd: 'git status' },
    { cmd: 'git diff --stat -- .claude/ledgers/' },
    { cmd: 'ls -la .claude/ledgers/' },
    { cmd: 'grep -n "tee" .claude/ledgers/BACKLOG.md' },
    { cmd: 'grep -n "sed -i" .claude/ledgers/DECISIONS.md' },
    { cmd: 'echo "remember: never run backlog-log.mjs add"' },
    { cmd: 'node -e \'console.log("would run changeset-write.mjs")\'' },
    { cmd: 'node .claude/scripts/backlog-log.mjs --help' },
    { cmd: 'cat .changeset/config.json' },
    { cmd: 'pnpm test' },
  ])(
    'allows "$cmd" from a subagent turn, since it does not write',
    ({ cmd }) => {
      const transcript = writeTranscript([sidechainTurn()]);

      const r = runScript(root, SCRIPT, {
        input: writeGatePayload(cmd, transcript),
      });

      expect(r.status, r.stderr).toBe(0);
    },
  );

  it('allows a ledger write outside any subagent turn, since the main thread is not gated', () => {
    const transcript = writeTranscript([mainTurn()]);

    const r = runScript(root, SCRIPT, {
      input: writeGatePayload(
        'node .claude/scripts/backlog-log.mjs add API area "title"',
        transcript,
      ),
    });

    expect(r.status, r.stderr).toBe(0);
  });

  it('allows a ledger write when there is no transcript at all', () => {
    const r = runScript(root, SCRIPT, {
      input: writeGatePayload(
        'node .claude/scripts/changeset-write.mjs --empty --summary "x"',
      ),
    });

    expect(r.status, r.stderr).toBe(0);
  });

  it('allows Bash to proceed when tool_input has no command', () => {
    expect(runScript(root, SCRIPT, { input: JSON.stringify({}) }).status).toBe(
      0,
    );
  });

  it('allows Bash to proceed on stdin that is not valid JSON', () => {
    expect(runScript(root, SCRIPT, { input: 'not json at all' }).status).toBe(
      0,
    );
  });

  it('allows Bash to proceed when transcript_path does not exist', () => {
    const r = runScript(root, SCRIPT, {
      input: writeGatePayload(
        'node .claude/scripts/backlog-log.mjs add API area "title"',
        '/nonexistent/transcript.jsonl',
      ),
    });

    expect(r.status, r.stderr).toBe(0);
  });

  it('allows Bash to proceed when the transcript file is not valid JSONL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-write-gate-'));
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, 'not json\nnot json either\n');

    const r = runScript(root, SCRIPT, {
      input: writeGatePayload(
        'node .claude/scripts/backlog-log.mjs add API area "title"',
        path,
      ),
    });

    expect(r.status, r.stderr).toBe(0);
  });
});

describe('subagent-write-gate --diagnose', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('exits 0 and reports a sidechain when the trailing assistant turn is one', () => {
    const transcript = writeTranscript([sidechainTurn()]);

    const r = runScript(root, SCRIPT, { args: ['--diagnose', transcript] });

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ sidechainDetected: true });
  });

  it('exits 1 and reports no sidechain, distinguishing a silent no-op from an enforced allow', () => {
    const transcript = writeTranscript([mainTurn()]);

    const r = runScript(root, SCRIPT, { args: ['--diagnose', transcript] });

    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ sidechainDetected: false });
  });

  it('exits 1 with an error when no transcript path is given', () => {
    const r = runScript(root, SCRIPT, { args: ['--diagnose'] });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--diagnose requires a transcript path/);
  });
});
