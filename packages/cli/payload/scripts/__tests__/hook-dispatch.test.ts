import { describe, expect, it, onTestFinished } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type HookResult,
  type WiringEntry,
  awaitChild,
  matcherSelects,
  mergeStdout,
  selectEntries,
  timeoutSecondsFor,
  verdictFor,
} from '../hook-dispatch.mjs';
import { hookCommandsFor, settingsOf } from '#test/installed-tree';
import { useInstalledRepo } from '#test/repo';
import { runIn } from '#test/run';

const SCRIPT = fileURLToPath(
  new URL('../../../payload-dist/scripts/hook-dispatch.mjs', import.meta.url),
);
const WIRING = '.claude/scripts/hook-wiring.json';

function useStagedRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-dispatch-')));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.claude/scripts'), { recursive: true });
  return root;
}

function writeWiring(
  root: string,
  events: Record<string, WiringEntry[]>,
  version = 1,
): void {
  writeFileSync(join(root, WIRING), JSON.stringify({ version, events }));
}

function writeHook(root: string, script: string, body: string): void {
  writeFileSync(join(root, '.claude/scripts', script), body);
}

function exitingHook(
  code: number,
  { stdout = '', stderr = '' }: { stdout?: string; stderr?: string } = {},
): string {
  return [
    `process.stdout.write(${JSON.stringify(stdout)});`,
    `process.stderr.write(${JSON.stringify(stderr)});`,
    `process.exitCode = ${code};`,
  ].join('\n');
}

function dispatch(
  cwd: string,
  input: string,
  {
    projectDir,
    extraEnv = {},
  }: { projectDir?: string; extraEnv?: Record<string, string> } = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.NODE_PATH;
  delete env.CLAUDE_PROJECT_DIR;
  if (projectDir !== undefined) env.CLAUDE_PROJECT_DIR = projectDir;
  return spawnSync(process.execPath, [SCRIPT], {
    cwd,
    input,
    encoding: 'utf8',
    env,
  });
}

function result(
  script: string,
  outcome: HookResult['outcome'],
  {
    stdout = '',
    stderr = '',
    onFailure,
  }: { stdout?: string; stderr?: string; onFailure?: 'block' } = {},
): HookResult {
  const entry: WiringEntry = onFailure ? { script, onFailure } : { script };
  return { entry, outcome, stdout, stderr, durationMilliseconds: 0 };
}

const ok = { kind: 'exited', code: 0 } as const;

describe('matcherSelects', () => {
  it.each([undefined, '', '*'])(
    'matches every value for matcher %j',
    (matcher) => {
      expect(matcherSelects(matcher, 'Bash')).toBe(true);
    },
  );

  it('treats a letters-digits-underscore-pipe matcher as an exact list', () => {
    expect(matcherSelects('Bash|Read', 'Read')).toBe(true);
    expect(matcherSelects('Bash|Read', 'ReadFile')).toBe(false);
    expect(matcherSelects('Bash|Read', 'Rea')).toBe(false);
  });

  it('tests any other matcher as a regex against the whole value', () => {
    expect(matcherSelects('mcp__.*', 'mcp__github__search')).toBe(true);
    expect(matcherSelects('Edit|Wri.e', 'MultiEdit')).toBe(false);
    expect(matcherSelects('Edit|Wri.e', 'Write')).toBe(true);
  });

  it('matches nothing, without throwing, for an invalid regex', () => {
    expect(matcherSelects('(Bash', 'Bash')).toBe(false);
  });
});

describe('selectEntries', () => {
  const entries: WiringEntry[] = [
    { script: 'a.mjs', matcher: 'Bash' },
    { script: 'b.mjs', matcher: 'Read' },
    { script: 'c.mjs' },
  ];

  it.each([
    ['PreToolUse', { tool_name: 'Bash' }],
    ['PostToolUse', { tool_name: 'Bash' }],
    ['PostToolUseFailure', { tool_name: 'Bash' }],
    ['PermissionRequest', { tool_name: 'Bash' }],
    ['SessionStart', { source: 'Bash' }],
    ['SessionEnd', { reason: 'Bash' }],
    ['PreCompact', { trigger: 'Bash' }],
    ['Notification', { notification_type: 'Bash' }],
  ])('matches %s against its own input field', (event, input) => {
    expect(selectEntries(entries, event, input).map((e) => e.script)).toEqual([
      'a.mjs',
      'c.mjs',
    ]);
  });

  it('does not match a tool event against another event field', () => {
    expect(
      selectEntries(entries, 'PreToolUse', { source: 'Bash' }).map(
        (e) => e.script,
      ),
    ).toEqual(['c.mjs']);
  });

  it('ignores the matcher for any other event', () => {
    expect(
      selectEntries(entries, 'Stop', { tool_name: 'Edit' }).map(
        (e) => e.script,
      ),
    ).toEqual(['a.mjs', 'b.mjs', 'c.mjs']);
  });
});

describe('timeoutSecondsFor', () => {
  it.each([
    [{ script: 'a.mjs' }, 'Stop', 598],
    [{ script: 'a.mjs', timeout: 0 }, 'Stop', 598],
    [{ script: 'a.mjs', timeout: 5 }, 'Stop', 5],
    [{ script: 'a.mjs' }, 'UserPromptSubmit', 28],
    [{ script: 'a.mjs' }, 'PreModelSwitch', 28],
    [{ script: 'a.mjs' }, 'PostModelSwitch', 28],
    [{ script: 'a.mjs' }, 'MessageDisplay', 8],
    [{ script: 'a.mjs', timeout: 60 }, 'UserPromptSubmit', 60],
  ])('gives %j on %s a timeout of %i seconds', (entry, event, seconds) => {
    expect(timeoutSecondsFor(entry, event)).toBe(seconds);
  });
});

describe('awaitChild', () => {
  it('settles shortly after a hook exits while its own child holds the pipes open', async () => {
    const holdPipesOpen = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
        stdio: 'inherit',
        detached: true,
      }).unref();
      process.stdout.write('{"ok":true}');
      process.exit(0);
    `;
    const child = spawn(process.execPath, ['-e', holdPipesOpen], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const startedAt = performance.now();

    const settled = await awaitChild(child, { script: 'a.mjs' }, 60, 200);

    expect(settled.outcome).toEqual({ kind: 'exited', code: 0 });
    expect(settled.stdout).toBe('{"ok":true}');
    expect(performance.now() - startedAt).toBeLessThan(4000);
  });
});

describe('mergeStdout', () => {
  it('passes one non-empty output through byte for byte', () => {
    expect(mergeStdout(['', '{"a": 1}  \n', '  \n'], 'Stop')).toBe(
      '{"a": 1}  \n',
    );
  });

  it('returns nothing when every output is empty', () => {
    expect(mergeStdout(['', '\n'], 'Stop')).toBe('');
  });

  it('shallow-merges JSON objects in wiring order and lets continue false win', () => {
    const merged = JSON.parse(
      mergeStdout(
        [
          '{"continue":false,"stopReason":"first","systemMessage":"one"}',
          '{"continue":true,"systemMessage":"two","suppressOutput":true}',
        ],
        'Stop',
      ),
    );
    expect(merged).toEqual({
      continue: false,
      stopReason: 'first',
      systemMessage: 'two',
      suppressOutput: true,
    });
  });

  it('merges hookSpecificOutput field-wise and joins additionalContext with a newline', () => {
    const merged = JSON.parse(
      mergeStdout(
        [
          '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"alpha"}}',
          '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"beta","extra":1}}',
        ],
        'SessionStart',
      ),
    );
    expect(merged.hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext: 'alpha\nbeta',
      extra: 1,
    });
  });

  it.each([
    [['allow', 'ask', 'deny'], 'deny'],
    [['deny', 'ask', 'allow'], 'deny'],
    [['allow', 'ask'], 'ask'],
    [['ask', 'allow'], 'ask'],
    [['allow', 'allow'], 'allow'],
    [['defer', 'allow'], 'defer'],
    [['ask', 'defer'], 'defer'],
    [['defer', 'deny'], 'deny'],
  ])(
    'picks the most restrictive permissionDecision of %j',
    (decisions, winner) => {
      const outputs = decisions.map((decision) =>
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            permissionDecisionReason: `because ${decision}`,
          },
        }),
      );
      const merged = JSON.parse(mergeStdout(outputs, 'PreToolUse'));
      expect(merged.hookSpecificOutput.permissionDecision).toBe(winner);
      expect(merged.hookSpecificOutput.permissionDecisionReason).toBe(
        `because ${winner}`,
      );
    },
  );

  it.each([
    [
      [
        { decision: 'block', reason: 'first' },
        { decision: 'approve', reason: 'second' },
      ],
      'first',
    ],
    [
      [
        { decision: 'approve', reason: 'first' },
        { decision: 'block', reason: 'second' },
      ],
      'second',
    ],
    [
      [
        { decision: 'block', reason: 'first' },
        { reason: 'stray', systemMessage: 'x' },
      ],
      'first',
    ],
  ])(
    'lets a top-level block decision win, carrying its own reason, in %j',
    (outputs, reason) => {
      const merged = JSON.parse(
        mergeStdout(
          outputs.map((o) => JSON.stringify(o)),
          'Stop',
        ),
      );
      expect(merged.decision).toBe('block');
      expect(merged.reason).toBe(reason);
    },
  );

  const DENY = { behavior: 'deny', message: 'refused here' };
  const ALLOW = { behavior: 'allow', updatedInput: { command: 'ls' } };

  it.each([[[DENY, ALLOW]], [[ALLOW, DENY]]])(
    'keeps the whole deny PermissionRequest decision object from %j',
    (decisions) => {
      const outputs = decisions.map((decision) =>
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
        }),
      );
      const merged = JSON.parse(mergeStdout(outputs, 'PermissionRequest'));
      expect(merged.hookSpecificOutput.decision).toEqual(DENY);
    },
  );

  it('joins several text outputs with a newline', () => {
    expect(mergeStdout(['first\n', 'second'], 'SessionStart')).toBe(
      'first\nsecond\n',
    );
  });

  it('appends text to the merged JSON additionalContext and sets hookEventName', () => {
    const merged = JSON.parse(
      mergeStdout(
        [
          'plain line\n',
          '{"systemMessage":"note","hookSpecificOutput":{"additionalContext":"from json"}}',
        ],
        'SessionStart',
      ),
    );
    expect(merged).toEqual({
      systemMessage: 'note',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'from json\nplain line',
      },
    });
  });

  it('creates hookSpecificOutput for a mix whose JSON carries none', () => {
    const merged = JSON.parse(
      mergeStdout(['{"suppressOutput":true}', 'text'], 'UserPromptSubmit'),
    );
    expect(merged.hookSpecificOutput).toEqual({
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'text',
    });
  });

  it('treats a JSON array as text, not as an object to merge', () => {
    expect(mergeStdout(['[1]', 'two'], 'Stop')).toBe('[1]\ntwo\n');
  });
});

describe('verdictFor', () => {
  it('keeps the JSON a hook wrote on a non-0, non-2 exit', () => {
    const verdict = verdictFor(
      [
        result(
          'a.mjs',
          { kind: 'exited', code: 1 },
          { stdout: '{"decision":"block","reason":"no"}\n', stderr: 'noise' },
        ),
      ],
      'Stop',
      false,
    );
    expect(verdict).toEqual({
      code: 0,
      stdout: '{"decision":"block","reason":"no"}\n',
      stderr: '',
    });
  });

  it('counts a blocking hook as failed on a non-0 exit even when it wrote JSON', () => {
    const verdict = verdictFor(
      [
        result(
          'a.mjs',
          { kind: 'exited', code: 1 },
          {
            stdout: '{"continue":true}\n',
            stderr: 'broke',
            onFailure: 'block',
          },
        ),
      ],
      'PreToolUse',
      true,
    );
    expect(verdict.code).toBe(1);
    expect(verdict.stdout).toBe('');
  });

  it('counts a non-0 exit with plain text on stdout as failed', () => {
    const verdict = verdictFor(
      [result('a.mjs', { kind: 'exited', code: 1 }, { stdout: 'hello\n' })],
      'Stop',
      false,
    );
    expect(verdict.code).toBe(1);
  });

  it('exits 2 when any hook exited 2, writing only those hooks stderr in wiring order', () => {
    const verdict = verdictFor(
      [
        result('a.mjs', { kind: 'exited', code: 2 }, { stderr: 'a says no' }),
        result(
          'b.mjs',
          { kind: 'exited', code: 1 },
          { stderr: 'b broke', onFailure: 'block' },
        ),
        result('c.mjs', { kind: 'exited', code: 2 }, { stderr: 'c says no\n' }),
      ],
      'PreToolUse',
      true,
    );
    expect(verdict).toEqual({
      code: 2,
      stdout: '',
      stderr: 'a says no\nc says no\n',
    });
  });

  it('exits 1 with the attribution line, then the failed blocking hook stderr', () => {
    const verdict = verdictFor(
      [
        result('a.mjs', ok, { stdout: 'context' }),
        result(
          'guard.mjs',
          { kind: 'exited', code: 3 },
          { stderr: 'guard crashed\n', onFailure: 'block' },
        ),
      ],
      'PreToolUse',
      true,
    );
    expect(verdict).toEqual({
      code: 1,
      stdout: '',
      stderr: '[houserules] hook-dispatch: guard.mjs exited 3\nguard crashed\n',
    });
  });

  it.each([
    [
      { kind: 'missing' } as const,
      '[houserules] hook-dispatch: guard.mjs is missing\n',
    ],
    [
      { kind: 'timeout', seconds: 5 } as const,
      '[houserules] hook-dispatch: guard.mjs timed out after 5s\n',
    ],
    [
      { kind: 'spawn-error', message: 'spawn EACCES' } as const,
      '[houserules] hook-dispatch: guard.mjs failed to start\nspawn EACCES\n',
    ],
    [
      { kind: 'exited', code: 7 } as const,
      '[houserules] hook-dispatch: guard.mjs exited 7\n',
    ],
    [
      { kind: 'signal', signal: 'SIGTERM' } as const,
      '[houserules] hook-dispatch: guard.mjs was killed by SIGTERM\n',
    ],
  ])(
    'exits 1 with the attribution line for a blocking hook failure %j',
    (outcome, stderr) => {
      const verdict = verdictFor(
        [result('guard.mjs', outcome, { onFailure: 'block' })],
        'PreToolUse',
        true,
      );
      expect(verdict).toEqual({ code: 1, stdout: '', stderr });
    },
  );

  it('exits 1 for a non-blocking failure when no entry of the event blocks and no hook wrote stdout', () => {
    const verdict = verdictFor(
      [
        result('a.mjs', ok),
        result('b.mjs', { kind: 'exited', code: 1 }, { stderr: 'b broke' }),
      ],
      'PostToolUse',
      false,
    );
    expect(verdict).toEqual({
      code: 1,
      stdout: '',
      stderr: '[houserules] hook-dispatch: b.mjs exited 1\nb broke\n',
    });
  });

  it('exits 0 with the sibling stdout for a non-blocking failure when no entry of the event blocks', () => {
    const verdict = verdictFor(
      [
        result('a.mjs', ok, { stdout: 'ctx' }),
        result('b.mjs', { kind: 'exited', code: 1 }, { stderr: 'b broke' }),
      ],
      'PostToolUse',
      false,
    );
    expect(verdict).toEqual({
      code: 0,
      stdout: 'ctx',
      stderr: '[houserules] hook-dispatch: b.mjs exited 1\nb broke\n',
    });
  });

  it('exits 0 with the stderr written for a non-blocking failure when an entry of the event blocks', () => {
    const verdict = verdictFor(
      [
        result('a.mjs', ok, { stdout: 'ctx\n' }),
        result('b.mjs', { kind: 'timeout', seconds: 2 }),
      ],
      'PreToolUse',
      true,
    );
    expect(verdict).toEqual({
      code: 0,
      stdout: 'ctx\n',
      stderr: '[houserules] hook-dispatch: b.mjs timed out after 2s\n',
    });
  });

  it('skips an absent non-blocking script silently', () => {
    const verdict = verdictFor(
      [
        result('a.mjs', ok, { stdout: 'ctx\n' }),
        result('gone.mjs', { kind: 'missing' }),
      ],
      'SessionStart',
      false,
    );
    expect(verdict).toEqual({ code: 0, stdout: 'ctx\n', stderr: '' });
  });
});

describe('hook-dispatch.mjs (built script, real execution)', () => {
  it('hands every selected hook the same stdin bytes, the inherited env, and the dispatcher cwd', () => {
    const root = useStagedRepo();
    const cwd = join(root, 'sub');
    mkdirSync(cwd);
    const report = (tag: string): string =>
      [
        "import { readFileSync } from 'node:fs';",
        'const stdin = readFileSync(0, "utf8");',
        `process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: ${JSON.stringify(tag)} + "|" + process.cwd() + "|" + process.env.DISPATCH_PROBE + "|" + stdin } }));`,
      ].join('\n');
    writeHook(root, 'one.mjs', report('one'));
    writeHook(root, 'two.mjs', report('two'));
    writeHook(root, 'skipped.mjs', exitingHook(0, { stdout: 'never' }));
    writeWiring(root, {
      PreToolUse: [
        { script: 'one.mjs', matcher: 'Bash' },
        { script: 'skipped.mjs', matcher: 'Read' },
        { script: 'two.mjs' },
      ],
    });
    const input = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      x: 'é',
    });
    const r = dispatch(cwd, input, {
      projectDir: root,
      extraEnv: { DISPATCH_PROBE: 'inherited' },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe(
      `one|${cwd}|inherited|${input}\ntwo|${cwd}|inherited|${input}`,
    );
  });

  it('runs the selected hooks in parallel', () => {
    const root = useStagedRepo();
    writeHook(
      root,
      'waiter.mjs',
      [
        "import { existsSync } from 'node:fs';",
        `const flag = ${JSON.stringify(join(root, 'second-ran'))};`,
        'const started = Date.now();',
        'const poll = () => {',
        '  if (existsSync(flag)) { process.stdout.write("saw second"); return; }',
        '  if (Date.now() - started > 8000) { process.exitCode = 1; return; }',
        '  setTimeout(poll, 25);',
        '};',
        'poll();',
      ].join('\n'),
    );
    writeHook(
      root,
      'second.mjs',
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(root, 'second-ran'))}, '');`,
    );
    writeWiring(root, {
      Stop: [
        { script: 'waiter.mjs', timeout: 10, onFailure: 'block' },
        { script: 'second.mjs' },
      ],
    });
    const r = dispatch(root, JSON.stringify({ hook_event_name: 'Stop' }), {
      projectDir: root,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('saw second');
  });

  it('kills a hook past its timeout and counts it as a failure', () => {
    const root = useStagedRepo();
    writeHook(root, 'hang.mjs', 'setTimeout(() => {}, 60000);');
    writeWiring(root, {
      PreToolUse: [{ script: 'hang.mjs', timeout: 1, onFailure: 'block' }],
    });
    const started = Date.now();
    const r = dispatch(
      root,
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      {
        projectDir: root,
      },
    );
    expect(Date.now() - started).toBeLessThan(15000);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      '[houserules] hook-dispatch: hang.mjs timed out after 1s\n',
    );
  });

  it('exits 2 with the refusing hook stderr', () => {
    const root = useStagedRepo();
    writeHook(root, 'allow.mjs', exitingHook(0, { stdout: 'fine' }));
    writeHook(root, 'deny.mjs', exitingHook(2, { stderr: 'refused\n' }));
    writeWiring(root, {
      PreToolUse: [
        { script: 'allow.mjs' },
        { script: 'deny.mjs', onFailure: 'block' },
      ],
    });
    const r = dispatch(
      root,
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      {
        projectDir: root,
      },
    );
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('refused\n');
  });

  it('exits 1 with a notice when a blocking hook script is absent', () => {
    const root = useStagedRepo();
    writeWiring(root, {
      PreToolUse: [{ script: 'guard-gone.mjs', onFailure: 'block' }],
    });
    const r = dispatch(
      root,
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      {
        projectDir: root,
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      '[houserules] hook-dispatch: guard-gone.mjs is missing\n',
    );
  });

  it('reads the wiring from the repo root when CLAUDE_PROJECT_DIR is unset', () => {
    const root = useStagedRepo();
    runIn(root, 'git', ['init', '-q']);
    const cwd = join(root, 'deep');
    mkdirSync(cwd);
    writeHook(
      root,
      'hello.mjs',
      exitingHook(0, { stdout: 'from root wiring' }),
    );
    writeWiring(root, {
      SessionStart: [{ script: 'hello.mjs', matcher: 'startup' }],
    });
    const r = dispatch(
      cwd,
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('from root wiring');
  });

  it('exits 0 silently for an event absent from the wiring', () => {
    const root = useStagedRepo();
    writeWiring(root, { PreToolUse: [{ script: 'x.mjs' }] });
    const r = dispatch(root, JSON.stringify({ hook_event_name: 'Stop' }), {
      projectDir: root,
    });
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });

  it.each([
    ['missing', (_root: string) => {}],
    [
      'unparsable',
      (root: string) => writeFileSync(join(root, WIRING), '{ not json'),
    ],
    ['version 2', (root: string) => writeWiring(root, { Stop: [] }, 2)],
  ])(
    'exits 1 with the update notice when the wiring is %s',
    (_label, stage) => {
      const root = useStagedRepo();
      stage(root);
      const r = dispatch(root, JSON.stringify({ hook_event_name: 'Stop' }), {
        projectDir: root,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toBe(
        `[houserules] hook-dispatch: ${join(root, WIRING)} is missing or unreadable. Run houserules update.\n`,
      );
    },
  );

  it('does not crash on stdin that is not JSON', () => {
    const root = useStagedRepo();
    writeWiring(root, { Stop: [{ script: 'x.mjs' }] });
    const r = dispatch(root, 'not json at all', { projectDir: root });
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });
});

describe('hook-dispatch.mjs run log', () => {
  const LOG = '.claude/state/hook-runs.jsonl';
  const ROTATED = '.claude/state/hook-runs.1.jsonl';
  const STOP = JSON.stringify({ hook_event_name: 'Stop' });

  function logLines(root: string, path = LOG): Record<string, unknown>[] {
    return readFileSync(join(root, path), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
  }

  it('writes one record per dispatched script', () => {
    const root = useStagedRepo();
    writeHook(root, 'a.mjs', exitingHook(0));
    writeHook(root, 'b.mjs', exitingHook(0));
    writeWiring(root, { Stop: [{ script: 'a.mjs' }, { script: 'b.mjs' }] });

    dispatch(root, STOP, { projectDir: root });

    const lines = logLines(root);
    expect(lines.map((line) => line['script'])).toEqual(['a.mjs', 'b.mjs']);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual([
        'at',
        'durationMilliseconds',
        'event',
        'exitCode',
        'hasOutput',
        'script',
      ]);
      expect(line['event']).toBe('Stop');
      expect(new Date(line['at'] as string).toISOString()).toBe(line['at']);
      expect(line['durationMilliseconds']).toBeGreaterThanOrEqual(0);
    }
  });

  it('records exit 2 with output for a script that prints and refuses', () => {
    const root = useStagedRepo();
    writeHook(root, 'deny.mjs', exitingHook(2, { stderr: 'no\n' }));
    writeWiring(root, { Stop: [{ script: 'deny.mjs' }] });

    dispatch(root, STOP, { projectDir: root });

    expect(logLines(root)[0]).toMatchObject({
      exitCode: 2,
      hasOutput: true,
    });
  });

  it('records no output for a silent exit 0', () => {
    const root = useStagedRepo();
    writeHook(root, 'quiet.mjs', exitingHook(0));
    writeWiring(root, { Stop: [{ script: 'quiet.mjs' }] });

    dispatch(root, STOP, { projectDir: root });

    expect(logLines(root)[0]).toMatchObject({ exitCode: 0, hasOutput: false });
  });

  it('records a null exit code for a missing script', () => {
    const root = useStagedRepo();
    writeWiring(root, { Stop: [{ script: 'gone.mjs' }] });

    dispatch(root, STOP, { projectDir: root });

    expect(logLines(root)[0]).toMatchObject({
      script: 'gone.mjs',
      exitCode: null,
      hasOutput: false,
    });
  });

  it('writes no line for an event with no selected entries', () => {
    const root = useStagedRepo();
    writeHook(root, 'a.mjs', exitingHook(0));
    writeWiring(root, { PreToolUse: [{ script: 'a.mjs', matcher: 'Read' }] });

    dispatch(
      root,
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      { projectDir: root },
    );

    expect(existsSync(join(root, LOG))).toBe(false);
  });

  it('rotates a log past 1 MiB, replacing the older rotated one', () => {
    const root = useStagedRepo();
    writeHook(root, 'a.mjs', exitingHook(0));
    writeWiring(root, { Stop: [{ script: 'a.mjs' }] });
    mkdirSync(join(root, '.claude/state'), { recursive: true });
    writeFileSync(join(root, LOG), `${'x'.repeat(1024 * 1024 + 1)}\n`);
    writeFileSync(join(root, ROTATED), 'older\n');

    dispatch(root, STOP, { projectDir: root });

    expect(readFileSync(join(root, ROTATED), 'utf8').startsWith('xxx')).toBe(
      true,
    );
    expect(logLines(root).map((line) => line['script'])).toEqual(['a.mjs']);
  });

  it('keeps verdict, stdout and stderr identical when the log cannot be written', () => {
    const writable = useStagedRepo();
    const blocked = useStagedRepo();
    writeFileSync(join(blocked, '.claude/state'), 'a file, not a directory');
    for (const root of [writable, blocked]) {
      writeHook(root, 'ok.mjs', exitingHook(0, { stdout: 'ctx' }));
      writeHook(root, 'deny.mjs', exitingHook(2, { stderr: 'refused\n' }));
      writeWiring(root, {
        Stop: [{ script: 'ok.mjs' }, { script: 'deny.mjs' }],
      });
    }

    const expected = dispatch(writable, STOP, { projectDir: writable });
    const actual = dispatch(blocked, STOP, { projectDir: blocked });

    expect(existsSync(join(writable, LOG))).toBe(true);
    expect(actual.status).toBe(2);
    expect({
      status: actual.status,
      stdout: actual.stdout,
      stderr: actual.stderr,
    }).toEqual({
      status: expected.status,
      stdout: expected.stdout,
      stderr: expected.stderr,
    });
  });
});

describe('the installed PreToolUse settings command', () => {
  function runPreToolUseBash(root: string, command: string) {
    const settingsCommand = hookCommandsFor(
      settingsOf(root),
      'PreToolUse',
    ).find((c) => c.includes('hook-dispatch.mjs'));
    if (!settingsCommand) {
      throw new Error('no PreToolUse hook command runs hook-dispatch.mjs');
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_PATH;
    env.CLAUDE_PROJECT_DIR = root;
    return spawnSync('sh', ['-c', settingsCommand], {
      cwd: root,
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      }),
      encoding: 'utf8',
      env,
    });
  }

  it('exits 2 through guard-bash for a git commit', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const r = runPreToolUseBash(root, 'git commit -m "x"');

    expect(r.status, r.stderr).toBe(2);
  });

  it('exits 0 for a Bash ls', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const r = runPreToolUseBash(root, 'ls');

    expect(r.status, r.stderr).toBe(0);
  });
});
