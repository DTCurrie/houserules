import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type TranscriptRecord,
  gitDenyRules,
  guardRefusalFor,
  isSidechainTurn,
  modWriteRefusalFor,
  writeGateRefusalFor,
} from '../guard-bash.mjs';
import { GUARD_DEFAULTS } from '@houserules/payload/config';
import { useInstalledRepo, useRepo } from '#test/repo';
import { runIn, runScript } from '#test/run';

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

function useThrowawayFixture(): string {
  const fixture = mkdtempSync(join(tmpdir(), 'guard-fixture-'));
  onTestFinished(() => rmSync(fixture, { recursive: true, force: true }));
  runIn(fixture, 'git', ['init', '-q']);
  return fixture;
}

function guardStatusIn(
  root: string,
  cwd: string,
  command: string,
  projectDir: string | undefined,
): number | null {
  const env = { ...process.env };
  delete env.NODE_PATH;
  delete env.CLAUDE_PROJECT_DIR;
  if (projectDir !== undefined) env.CLAUDE_PROJECT_DIR = projectDir;
  return spawnSync(process.execPath, [join(root, SCRIPT)], {
    cwd,
    input: payload(command),
    encoding: 'utf8',
    env,
  }).status;
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

function writeGatePayload(
  command: string,
  opts: { agentId?: string; transcriptPath?: string } = {},
): string {
  return JSON.stringify({
    tool_input: { command },
    transcript_path: opts.transcriptPath,
    agent_id: opts.agentId,
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
      custom: [{ pattern: '(unclosed', message: 'never shown' }],
    });
    expect(rules).toEqual([]);
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
    'git stash list',
    'git stash show -p stash@{1}',
    'git -C /repo stash list',
  ])('allows the read-only stash command "%s"', (cmd) => {
    expect(guardRefusalFor(cmd)).toBeNull();
  });

  it.each([
    'git stash',
    'git stash push -m x',
    'git stash pop',
    'git -C /repo stash drop',
    'git stash -u',
    'git stash && git pull',
  ])('refuses the state-changing stash command "%s"', (cmd) => {
    expect(guardRefusalFor(cmd)).toMatch(
      /Blocked by houserules guard: git stash/,
    );
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

  const SPACED_GLOBAL_OPTIONS = [
    'git -C $(echo x)',
    'git -C `x`',
    'git -C `echo x`',
    'git -c k="a b"',
    "git -c k='a b'",
    'git -C "/a path/with spaces"',
  ];

  it.each(SPACED_GLOBAL_OPTIONS.map((options) => `${options} commit -m x`))(
    'refuses the commit "%s", whose global option value is substituted or holds a space',
    (cmd) => {
      expect(guardRefusalFor(cmd)).toMatch(
        /Blocked by houserules guard: git commit/,
      );
    },
  );

  it.each(
    SPACED_GLOBAL_OPTIONS.flatMap((options) => [
      `${options} checkout -- src/world.py`,
      `${options} restore src/world.py`,
      `${options} reset --hard`,
      `${options} clean -fd`,
      `${options} switch -f main`,
    ]),
  )(
    'refuses the discard "%s", whose global option value is substituted or holds a space',
    (cmd) => {
      expect(guardRefusalFor(cmd)).toMatch(
        /discard uncommitted work.*inverse with Edit/,
      );
    },
  );

  it.each([
    "printf '%s\\n' 'missed form: make; git commit -m x' >> notes.log",
    'printf "%s\\n" "missed form: make; git commit -m x" >> notes.log',
    'echo "make; git commit -m x"',
    "echo 'pnpm test && git checkout -- src/world.py'",
    'echo "a | git stash"',
    'git log --grep "fix; git push"',
    "cat <<'EOF' >> notes.md\nran: make; git commit -m x\ngit checkout -- src/world.py\nEOF",
    'cat <<EOF >> notes.md\nran: make; git commit -m x\nEOF',
    'cat <<-"EOF"\n\tgit commit -m x\n\tEOF\necho done',
    'echo hi # then; git commit',
    "echo $'it\\'s; git commit'",
  ])(
    'returns null for "%s", since a quoted argument, a heredoc body, or a comment only mentions the command',
    (cmd) => {
      expect(guardRefusalFor(cmd)).toBeNull();
    },
  );

  it.each([
    'echo $(git commit -m x)',
    'echo "$(git commit -m x)"',
    'echo `git commit -m x`',
    'echo "`git commit -m x`"',
    'echo $(echo $(git commit -m x))',
    "bash -c 'git commit -m x'",
    'sh -c "make && git commit -m x"',
    "bash -lc 'git -C /repo commit'",
    '/bin/bash -c "git commit"',
    "eval 'git commit -m x'",
    'eval git commit -m x',
    'diff <(git commit -m x) out.txt',
    'cat <<EOF\n$(git commit -m x)\nEOF',
    '(git commit -m x)',
    '{ git commit -m x; }',
    'if true; then git commit -m x; fi',
    'FOO=1 git commit -m x',
    '"git" commit -m x',
    "g'i't commit -m x",
    'git "commit" -m x',
    'g\\it commit -m x',
    'make \\\n  && git commit -m x',
    "cat <<'EOF'\nbody\nEOF\ngit commit -m x",
    'echo "x" | git stash',
    'git -C $(echo x) stash',
    'git -c k="a b" push origin main',
  ])(
    'refuses "%s", since a command substitution, a nested shell, or quoting still runs the command',
    (cmd) => {
      expect(guardRefusalFor(cmd)).toMatch(/Blocked by houserules guard/);
    },
  );

  it.each([
    'git commit -m "unbalanced',
    'git -c k="a b" commit -m x\necho "unbalanced',
    'echo $(git commit -m x',
    'echo `git commit -m x',
    'cat <<EOF\ngit commit -m x',
    'git -c k="a b" commit -m x <<EOF',
  ])(
    'refuses "%s", which the tokenizer cannot parse, by reading every unclosed quote, substitution, and heredoc as running to the end',
    (cmd) => {
      expect(guardRefusalFor(cmd)).toMatch(/Blocked by houserules guard/);
    },
  );

  it.each([
    'env git commit -m x',
    'env FOO=1 git commit -m x',
    'env -u HOME git commit -m x',
    'sudo git commit -m x',
    'sudo -u root git commit -m x',
    'command git commit -m x',
    'exec git commit -m x',
    'nohup git commit -m x',
    'nohup sudo env FOO=1 git commit -m x',
    'xargs git commit -m x',
    'echo a | xargs -I{} git commit -m {}',
    'git $(echo commit) -m x',
    'git $(echo push)',
    'sudo bash -c "git commit -m x"',
    'sudo git push origin main',
    'env git stash',
    'xargs git checkout -- src/world.py',
    'nohup gh pr create --fill',
  ])(
    'refuses the wrapped form "%s", since a wrapper still runs the guarded command',
    (cmd) => {
      expect(guardRefusalFor(cmd)).toMatch(/Blocked by houserules guard/);
    },
  );

  it.each([
    'echo "git commit"',
    "grep 'git commit' file",
    'echo env git commit',
    'sudo echo "git commit"',
    'xargs echo git commit',
    'command -v git commit',
    'env FOO=1 ls',
    'git log $(git rev-parse HEAD)',
    'git -C "$(pwd)" status',
  ])(
    'returns null for "%s", since the guarded words are data or a wrapper runs something else',
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

  it.each([
    'env node .claude/scripts/changeset-write.mjs --pkg foo --summary "x"',
    'env FOO=1 node .claude/scripts/changeset-write.mjs --summary "x"',
    'command node .claude/scripts/changeset-write.mjs --summary "x"',
    'nohup node .claude/scripts/backlog-log.mjs add API area "title"',
    'sudo -u me node .claude/scripts/decision-log.mjs decide "use zod"',
    'bash -c "node .claude/scripts/changeset-write.mjs --summary x"',
    'echo $(node .claude/scripts/backlog-log.mjs remove abc123 API "dup")',
  ])('returns a refusal for the wrapped "%s"', (cmd) => {
    expect(writeGateRefusalFor(cmd)).toMatch(
      /Blocked by houserules subagent write gate/,
    );
  });

  it('returns null for a wrapped read-only ledger command', () => {
    expect(
      writeGateRefusalFor('env node .claude/scripts/backlog-log.mjs list'),
    ).toBeNull();
  });
});

describe('modWriteRefusalFor', () => {
  function useModLocations(): { home: string; modDir: string } {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'guard-bash-mods-')));
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const modDir = join(home, '.claude', 'dev-mods', 'mine');
    mkdirSync(modDir, { recursive: true });
    return { home, modDir };
  }

  const refuses = /houserules mod guard/;

  it.each([
    ['a redirect', (dir: string) => `cat > ${dir}/index.js <<'EOF'\nx\nEOF`],
    ['an append redirect', (dir: string) => `echo x >> ${dir}/index.js`],
    ['a redirect with no space', (dir: string) => `echo x >${dir}/index.js`],
    ['tee', (dir: string) => `echo x | tee -a ${dir}/index.js`],
    ['cp to a file', (dir: string) => `cp ./index.js ${dir}/index.js`],
    ['cp into the directory', (dir: string) => `cp ./index.js ${dir}`],
    ['mv', (dir: string) => `mv /tmp/a.js ${dir}/a.js`],
    ['a wrapped redirect', (dir: string) => `bash -c "echo x > ${dir}/a.js"`],
  ])('refuses %s into a dev-mods directory in auto mode', (_, build) => {
    const { home, modDir } = useModLocations();

    const refusal = modWriteRefusalFor(build(modDir), 'auto', home, {
      configDir: join(home, '.claude'),
      pluginDirs: [],
    });

    expect(refusal).toMatch(refuses);
  });

  const writeForms: Array<{
    form: string;
    isDirectory: boolean;
    build: (path: string) => string;
  }> = [
    {
      form: 'sed -i without a suffix',
      isDirectory: false,
      build: (path) => `sed -i s/a/b/ ${path}`,
    },
    {
      form: 'sed -i with a suffix',
      isDirectory: false,
      build: (path) => `sed -i.bak -e s/a/b/ ${path}`,
    },
    {
      form: 'sed -i with the BSD empty suffix',
      isDirectory: false,
      build: (path) => `sed -i '' s/a/b/ ${path}`,
    },
    {
      form: 'dd of=',
      isDirectory: false,
      build: (path) => `dd if=/dev/zero of=${path} count=1`,
    },
    {
      form: 'cp -t',
      isDirectory: true,
      build: (path) => `cp -t ${path} ./a.js`,
    },
    {
      form: 'cp --target-directory=',
      isDirectory: true,
      build: (path) => `cp --target-directory=${path} ./a.js`,
    },
    {
      form: 'mv -t',
      isDirectory: true,
      build: (path) => `mv -t ${path} ./a.js`,
    },
  ];
  const quotings: Array<[string, (path: string) => string]> = [
    ['bare', (path) => path],
    ['single-quoted', (path) => `'${path}'`],
    ['double-quoted', (path) => `"${path}"`],
  ];
  const depths: Array<[string, string]> = [
    ['directly in the directory', ''],
    ['two levels down', '/x/y'],
  ];
  const writeCases = writeForms.flatMap(({ form, isDirectory, build }) =>
    quotings.flatMap(([quoting, quote]) =>
      depths.map(([depth, suffix]) => ({
        name: `${form}, ${quoting} path ${depth}`,
        build: (root: string) =>
          build(
            quote(isDirectory ? `${root}${suffix}` : `${root}${suffix}/a.js`),
          ),
      })),
    ),
  );

  it.each(writeCases)('refuses $name inside a mod directory', ({ build }) => {
    const { home, modDir } = useModLocations();

    const refusal = modWriteRefusalFor(build(modDir), 'auto', home, {
      configDir: join(home, '.claude'),
      pluginDirs: [],
    });

    expect(refusal).toMatch(refuses);
  });

  it.each(writeCases)('allows $name outside a mod directory', ({ build }) => {
    const { home } = useModLocations();
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(join(elsewhere, 'x', 'y'), { recursive: true });

    const refusal = modWriteRefusalFor(build(elsewhere), 'auto', home, {
      configDir: join(home, '.claude'),
      pluginDirs: [],
    });

    expect(refusal).toBeNull();
  });

  it('refuses a path held in an environment variable of the hook process', () => {
    const { home, modDir } = useModLocations();
    vi.stubEnv('HOUSERULES_TEST_MOD_TARGET', modDir);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    const refusal = modWriteRefusalFor(
      'sed -i s/a/b/ "$HOUSERULES_TEST_MOD_TARGET/a.js"',
      'auto',
      home,
      { configDir: join(home, '.claude'), pluginDirs: [] },
    );

    expect(refusal).toMatch(refuses);
  });

  it('refuses a braced environment variable naming the mod directory', () => {
    const { home, modDir } = useModLocations();
    vi.stubEnv('HOUSERULES_TEST_MOD_TARGET', modDir);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    const refusal = modWriteRefusalFor(
      'echo x > ${HOUSERULES_TEST_MOD_TARGET}/a.js',
      'auto',
      home,
      { configDir: join(home, '.claude'), pluginDirs: [] },
    );

    expect(refusal).toMatch(refuses);
  });

  it('refuses a path held in a variable assigned earlier in the same command', () => {
    const { home, modDir } = useModLocations();

    const refusal = modWriteRefusalFor(
      `D=${modDir}; sed -i s/a/b/ "$D/a.js"`,
      'auto',
      home,
      { configDir: join(home, '.claude'), pluginDirs: [] },
    );

    expect(refusal).toMatch(refuses);
  });

  it('refuses a path held in a prefix assignment', () => {
    const { home, modDir } = useModLocations();

    const refusal = modWriteRefusalFor(
      `D=${modDir} dd of="$D/a.js" if=/dev/zero`,
      'auto',
      home,
      { configDir: join(home, '.claude'), pluginDirs: [] },
    );

    expect(refusal).toMatch(refuses);
  });

  it('allows a path held in a variable nothing defines', () => {
    const { home } = useModLocations();

    const refusal = modWriteRefusalFor(
      'sed -i s/a/b/ "$HOUSERULES_TEST_UNDEFINED/a.js"',
      'auto',
      home,
      { configDir: join(home, '.claude'), pluginDirs: [] },
    );

    expect(refusal).toBeNull();
  });

  it('refuses a chain whose first write is allowed and whose second is inside a mod directory', () => {
    const { home, modDir } = useModLocations();

    const refusal = modWriteRefusalFor(
      `cp ./a.js ${home}/elsewhere.js && sed -i s/a/b/ ${modDir}/a.js`,
      'auto',
      home,
      { configDir: join(home, '.claude'), pluginDirs: [] },
    );

    expect(refusal).toMatch(refuses);
  });

  it('refuses a relative redirect after a cd into the mod directory', () => {
    const { home, modDir } = useModLocations();

    const refusal = modWriteRefusalFor(
      `cd ${modDir} && echo x > index.js`,
      'bypassPermissions',
      home,
      { configDir: join(home, '.claude'), pluginDirs: [] },
    );

    expect(refusal).toMatch(refuses);
  });

  it('refuses a tilde path, resolving it against the home directory', () => {
    const { home } = useModLocations();

    const refusal = modWriteRefusalFor(
      `cat > ~/.claude/dev-mods/mine/index.js < src.js`,
      'auto',
      home,
      { configDir: join(homedir(), '.claude'), pluginDirs: [] },
    );

    expect(refusal).toMatch(refuses);
  });

  it('refuses a write into a directory laid out as a mod', () => {
    const { home } = useModLocations();
    const layoutMod = join(home, 'elsewhere', 'my-mod');
    mkdirSync(join(layoutMod, '.claude-plugin'), { recursive: true });
    mkdirSync(join(layoutMod, 'hooks'), { recursive: true });
    writeFileSync(join(layoutMod, '.claude-plugin', 'plugin.json'), '{}');
    writeFileSync(
      join(layoutMod, 'hooks', 'hooks.json'),
      '{"modules":["./index.js"]}',
    );

    const refusal = modWriteRefusalFor(
      `echo x > ${layoutMod}/index.js`,
      'auto',
      home,
      { configDir: join(home, '.claude'), pluginDirs: [] },
    );

    expect(refusal).toMatch(refuses);
  });

  it.each(['default', 'acceptEdits'])(
    'allows a redirect into a mod directory in %s mode, where the write is put to the user',
    (mode) => {
      const { home, modDir } = useModLocations();

      const refusal = modWriteRefusalFor(
        `echo x > ${modDir}/a.js`,
        mode,
        home,
        {
          configDir: join(home, '.claude'),
          pluginDirs: [],
        },
      );

      expect(refusal).toBeNull();
    },
  );

  it.each([
    ['a read of the mod file', (dir: string) => `cat ${dir}/index.js`],
    ['a copy out of the mod', (dir: string) => `cp ${dir}/index.js ./copy.js`],
    ['a quoted mention', (dir: string) => `echo "> ${dir}/index.js"`],
    ['a redirect elsewhere', () => 'echo x > ./notes.txt'],
  ])('allows %s in auto mode', (_, build) => {
    const { home, modDir } = useModLocations();

    const refusal = modWriteRefusalFor(build(modDir), 'auto', home, {
      configDir: join(home, '.claude'),
      pluginDirs: [],
    });

    expect(refusal).toBeNull();
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

  it('resolves the config root from a subdirectory with CLAUDE_PROJECT_DIR unset or set, and refuses a commit in the project either way', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    withConfig(root, { gitStash: false });
    const subdirectory = join(root, 'packages', 'nested');
    mkdirSync(subdirectory, { recursive: true });

    const statuses = [undefined, root].map((projectDir) => ({
      projectDir: projectDir === undefined ? 'unset' : 'fixture root',
      stash: guardStatusIn(root, subdirectory, 'git stash', projectDir),
      commit: guardStatusIn(root, subdirectory, 'git commit -m x', projectDir),
      commitByC: guardStatusIn(
        root,
        subdirectory,
        `git -C ${root} commit -m x`,
        projectDir,
      ),
    }));

    expect(statuses).toEqual([
      { projectDir: 'unset', stash: 0, commit: 2, commitByC: 2 },
      { projectDir: 'fixture root', stash: 0, commit: 2, commitByC: 2 },
    ]);
  });

  it('allows a throwaway fixture commit when CLAUDE_PROJECT_DIR names another repo, and refuses it when CLAUDE_PROJECT_DIR names the fixture', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const fixture = useThrowawayFixture();
    const command = `git -C ${fixture} -c user.name= -c user.email= commit -m x`;

    const statuses = {
      projectIsAnotherRepo: guardStatusIn(root, root, command, root),
      projectIsTheFixture: guardStatusIn(root, root, command, fixture),
    };

    expect(statuses).toEqual({
      projectIsAnotherRepo: 0,
      projectIsTheFixture: 2,
    });
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

  it('refuses a custom rule that has no message with a default reason naming the missing field', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    withConfig(root, {
      custom: [{ pattern: '\\bdocker\\s+system\\s+prune\\b' }],
    });
    const r = runScript(root, SCRIPT, {
      input: payload('docker system prune -f'),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).not.toMatch(/undefined/);
    expect(r.stderr).toContain(
      'Blocked by houserules guard: the guard.custom rule for pattern `\\bdocker\\s+system\\s+prune\\b` has no `message` field',
    );
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

  const LEDGER_WRITE =
    'node .claude/scripts/backlog-log.mjs add API area "title"';

  it('refuses a ledger write when the payload carries agent_id', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const r = runScript(root, SCRIPT, {
      input: writeGatePayload(LEDGER_WRITE, { agentId: 'agent-abc123' }),
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/subagent/i);
  });

  it('refuses a changeset write when the payload carries agent_id', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const r = runScript(root, SCRIPT, {
      input: writeGatePayload(
        'node .claude/scripts/changeset-write.mjs --empty --summary "x"',
        {
          agentId: 'agent-abc123',
          transcriptPath: writeTranscript([mainTurn()]),
        },
      ),
    });

    expect(r.status).toBe(2);
  });

  it('allows a ledger write when the payload has no agent_id', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const r = runScript(root, SCRIPT, {
      input: writeGatePayload(LEDGER_WRITE),
    });

    expect(r.status, r.stderr).toBe(0);
  });

  it('allows a ledger write when agent_id is an empty string', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const r = runScript(root, SCRIPT, {
      input: writeGatePayload(LEDGER_WRITE, { agentId: '' }),
    });

    expect(r.status, r.stderr).toBe(0);
  });

  it('refuses with agent_id even when transcript_path does not exist', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const r = runScript(root, SCRIPT, {
      input: writeGatePayload(LEDGER_WRITE, {
        agentId: 'agent-abc123',
        transcriptPath: '/nonexistent/transcript.jsonl',
      }),
    });

    expect(r.status).toBe(2);
  });

  it('allows without agent_id even when the transcript trailing turn is a sidechain', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const r = runScript(root, SCRIPT, {
      input: writeGatePayload(LEDGER_WRITE, {
        transcriptPath: writeTranscript([sidechainTurn()]),
      }),
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
