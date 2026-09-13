import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type TranscriptRecord,
  gitDenyRules,
  guardRefusalFor,
  isSidechainTurn,
  writeGateRefusalFor,
} from '../guard-bash.mjs';
import { GUARD_DEFAULTS } from '@houserules/payload/config';
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

function sidechainTurn(): TranscriptRecord {
  return { type: 'assistant', isSidechain: true };
}

function mainTurn(): TranscriptRecord {
  return { type: 'assistant', isSidechain: false };
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

describe('gitDenyRules', () => {
  it('emits no rules when every default flag is off and there are no custom rules', () => {
    const rules = gitDenyRules({
      gitCommit: false,
      gitPush: false,
      gitStash: false,
      gitDiscard: false,
      prCreate: false,
    });
    expect(rules).toEqual([]);
  });

  it('emits exactly the five default rules when the defaults are all on', () => {
    const rules = gitDenyRules(GUARD_DEFAULTS);
    expect(rules).toHaveLength(5);
  });

  it('skips a custom rule with an invalid regex pattern instead of throwing', () => {
    const rules = gitDenyRules({
      gitCommit: false,
      gitPush: false,
      gitStash: false,
      gitDiscard: false,
      prCreate: false,
      custom: [{ pattern: '(unclosed' }],
    });
    expect(rules).toEqual([]);
  });

  it('falls back to a generated message for a custom rule with no message', () => {
    const rules = gitDenyRules({
      gitCommit: false,
      gitPush: false,
      gitStash: false,
      gitDiscard: false,
      prCreate: false,
      custom: [{ pattern: 'docker system prune' }],
    });
    expect(rules[0]?.msg).toBe(
      'Blocked by houserules.config.json guard rule: docker system prune',
    );
  });
});

describe('guardRefusalFor', () => {
  it.each([
    'git commit -m x',
    'git push origin main',
    'git -C /x push',
    'git stash',
    'gh pr create --fill',
    'git -C /repo commit -m x',
    'git -c user.name=x commit -m y',
    'git --no-pager commit',
    'git -C /repo stash',
    'git add -A && git commit -m x',
    'make build; git commit -m done',
  ])('refuses "%s" by default', (cmd) => {
    expect(guardRefusalFor(cmd)).toMatch(/Blocked by houserules guard/);
  });

  it.each([
    'git checkout -- src/isaac_module/models/world.py',
    'git checkout HEAD -- src/world.py',
    'git checkout .',
    'git checkout main',
    'git checkout -b feature',
    'git -C /repo checkout -- src/world.py',
    'git restore src/world.py',
    'git restore --staged --worktree src/world.py',
    'git restore --source=HEAD~1 src/world.py',
    'git reset --hard',
    'git reset --hard HEAD~1',
    'git reset --merge',
    'git clean -fd',
    'git clean -n',
    'git switch -f main',
    'git switch --force main',
    'git switch --discard-changes main',
    'pnpm test; git checkout -- src/world.py',
  ])('refuses "%s", since it discards uncommitted work', (cmd) => {
    expect(guardRefusalFor(cmd)).toMatch(
      /discard uncommitted work.*inverse with Edit/,
    );
  });

  it.each([
    'ls -la',
    'git status',
    'git log --oneline',
    'pnpm run build',
    'grep -rn "git commit" .',
    'echo "remember to git commit when done"',
    'node -e \'console.log("git stash")\'',
    'rg "git push" src/',
    'git log --grep "git commit"',
    'git switch main',
    'git switch -c feature-flag',
    'git switch feature-flag',
    'git switch --force-create feature',
    'git reset --soft HEAD~1',
    'git reset src/world.py',
    'git reset HEAD~1',
    'git diff -- src/world.py',
    'git show HEAD:src/world.py',
    'grep -rn "git checkout --" docs/',
    'echo "never git restore a dirty tree"',
  ])(
    'returns null for "%s", since flags and quoted arguments must not be mistaken for the guarded subcommand',
    (cmd) => {
      expect(guardRefusalFor(cmd)).toBeNull();
    },
  );
});

describe('writeGateRefusalFor', () => {
  it.each([
    'node .claude/scripts/backlog-log.mjs add API area "title"',
    'node .claude/scripts/backlog-log.mjs remove abc123 API "dup"',
    'node .claude/scripts/backlog-log.mjs update abc123 API "new title"',
    'node .claude/scripts/backlog-log.mjs move abc123 CLI',
    'node .claude/scripts/backlog-log.mjs render',
    'node .claude/scripts/decision-log.mjs decide "use zod"',
    'node .claude/scripts/decision-log.mjs supersede abc123 "why"',
    'node .claude/scripts/decision-log.mjs amend abc123 "why"',
    'node .claude/scripts/decision-log.mjs move abc123 CLI',
    'node .claude/scripts/decision-log.mjs rescope abc123 CLI',
    'node .claude/scripts/decision-log.mjs render',
    'node .claude/scripts/changeset-write.mjs --pkg foo --summary "x"',
    'node .claude/scripts/changeset-write.mjs --empty --summary "x"',
    'tee .claude/ledgers/BACKLOG.md < /dev/null',
    'tee .claude/ledgers/DECISIONS.md < /dev/null',
    "sed -i '' 's/x/y/' .claude/ledgers/BACKLOG.md",
    'echo "manual edit" >> .claude/ledgers/BACKLOG.md',
    'echo "fake" > .claude/ledgers/backlog.jsonl',
    'echo "fake" > .claude/ledgers/decisions.jsonl',
    'cat notes.txt | tee .claude/ledgers/BACKLOG.md',
    'echo "1.0.0" > .changeset/my-change.md',
    'rm .changeset/config.json && echo "{}" > .changeset/config.json',
  ])('returns a refusal for "%s"', (cmd) => {
    expect(writeGateRefusalFor(cmd)).toMatch(
      /Blocked by houserules subagent write gate/,
    );
  });

  it.each([
    'node .claude/scripts/backlog-log.mjs list',
    'node .claude/scripts/backlog-log.mjs show abc123',
    'node .claude/scripts/decision-log.mjs list',
    'node .claude/scripts/decision-log.mjs show abc123',
    'node .claude/scripts/decision-log.mjs ancestry abc123',
    'node .claude/scripts/decision-log.mjs current CLI',
    'cat .claude/ledgers/BACKLOG.md',
    'grep -rn "duplicate" .claude/ledgers/backlog.jsonl',
    'git status',
    'git diff --stat -- .claude/ledgers/',
    'ls -la .claude/ledgers/',
    'grep -n "tee" .claude/ledgers/BACKLOG.md',
    'grep -n "sed -i" .claude/ledgers/DECISIONS.md',
    'echo "remember: never run backlog-log.mjs add"',
    'node -e \'console.log("would run changeset-write.mjs")\'',
    'node .claude/scripts/backlog-log.mjs --help',
    'cat .changeset/config.json',
    'pnpm test',
  ])('returns null for "%s", since it does not write', (cmd) => {
    expect(writeGateRefusalFor(cmd)).toBeNull();
  });
});

describe('isSidechainTurn', () => {
  it('returns true when the trailing assistant turn is a sidechain', () => {
    expect(
      isSidechainTurn([mainTurn(), sidechainTurn()]),
      'trailing sidechain turn detected',
    ).toBe(true);
  });

  it('returns false when the trailing assistant turn is the main thread', () => {
    expect(
      isSidechainTurn([sidechainTurn(), mainTurn()]),
      'trailing main-thread turn is not a sidechain',
    ).toBe(false);
  });

  it('returns false when there is no assistant turn at all', () => {
    expect(
      isSidechainTurn([{ type: 'user' }]),
      'no assistant turn is not a sidechain',
    ).toBe(false);
  });

  it('returns false for an empty transcript', () => {
    expect(isSidechainTurn([]), 'empty transcript is not a sidechain').toBe(
      false,
    );
  });
});

describe('guard-bash.mjs', () => {
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
    const root = useInstalledRepo('pnpm-monorepo');
    withConfig(root, { gitStash: false });
    expect(
      runScript(root, SCRIPT, { input: payload('git stash') }).status,
    ).toBe(0);
    expect(
      runScript(root, SCRIPT, { input: payload('git commit -m x') }).status,
    ).toBe(2);
  });

  it('allows a discard when config turns gitDiscard off, while the stash rule stays on', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    withConfig(root, { gitDiscard: false });
    expect(
      runScript(root, SCRIPT, { input: payload('git checkout -- src/x.ts') })
        .status,
    ).toBe(0);
    expect(
      runScript(root, SCRIPT, { input: payload('git stash') }).status,
    ).toBe(2);
  });

  it('blocks a command matching a custom rule and reports its message', () => {
    const root = useInstalledRepo('pnpm-monorepo');
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

  it('allows Bash to proceed on stdin that is not valid JSON', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    expect(runScript(root, SCRIPT, { input: 'not json at all' }).status).toBe(
      0,
    );
  });

  it('allows Bash to proceed when tool_input has no command', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    expect(runScript(root, SCRIPT, { input: JSON.stringify({}) }).status).toBe(
      0,
    );
  });

  it('refuses a ledger write from a subagent turn, reading the sidechain flag from the transcript path', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const transcript = writeTranscript([sidechainTurn()]);

    const r = runScript(root, SCRIPT, {
      input: writeGatePayload(
        'node .claude/scripts/backlog-log.mjs add API area "title"',
        transcript,
      ),
    });

    expect(r.status).toBe(2);
  });

  it('allows a ledger write outside any subagent turn, since the main thread is not gated', () => {
    const root = useInstalledRepo('pnpm-monorepo');
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
    const root = useInstalledRepo('pnpm-monorepo');
    const r = runScript(root, SCRIPT, {
      input: writeGatePayload(
        'node .claude/scripts/changeset-write.mjs --empty --summary "x"',
      ),
    });

    expect(r.status, r.stderr).toBe(0);
  });

  it('allows Bash to proceed when transcript_path does not exist', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const r = runScript(root, SCRIPT, {
      input: writeGatePayload(
        'node .claude/scripts/backlog-log.mjs add API area "title"',
        '/nonexistent/transcript.jsonl',
      ),
    });

    expect(r.status, r.stderr).toBe(0);
  });

  it('allows Bash to proceed when the transcript file is not valid JSONL', () => {
    const root = useInstalledRepo('pnpm-monorepo');
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

  it('exits 0 and reports a sidechain when the trailing assistant turn is one, for --diagnose', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const transcript = writeTranscript([sidechainTurn()]);

    const r = runScript(root, SCRIPT, { args: ['--diagnose', transcript] });

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ sidechainDetected: true });
  });

  it('exits 1 and reports no sidechain for --diagnose, distinguishing a silent no-op from an enforced allow', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const transcript = writeTranscript([mainTurn()]);

    const r = runScript(root, SCRIPT, { args: ['--diagnose', transcript] });

    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ sidechainDetected: false });
  });

  it('exits 1 with an error when --diagnose is given no transcript path', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const r = runScript(root, SCRIPT, { args: ['--diagnose'] });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--diagnose requires a transcript path/);
  });
});
