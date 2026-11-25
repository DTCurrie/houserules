import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { useInstalledRepo, useRepo } from '#test/repo';
import { runCli, runIn } from '#test/run';
import {
  editHouseConfig,
  givePathTakingFixScripts,
  type HouseManifestShape,
  manifestOf,
  readJson,
  sha256,
  writeManifest,
} from '#test/installed-tree';
import { runDoctorJson } from '#test/doctor-report';
import { blockingDrift, doctorExitCode } from '../doctor.js';
import type { Finding } from '@houserules/api';
import { EXIT } from '../../cli-contract.js';
import type { FileDrift } from '../../core/drift.js';
import { PRETTIERIGNORE_REGION } from '../../modules/prettier-guard.js';

function drift(overrides: Partial<FileDrift> = {}): FileDrift {
  return { path: 'some/file', status: 'stale', ...overrides };
}

function growClaudeMdPastBudget(root: string): void {
  appendFileSync(join(root, 'CLAUDE.md'), '# big\n'.repeat(250));
}

function frontmatterOf(text: string): string {
  const match = /^---\n[\s\S]*?\n---\n/.exec(text);
  return match ? match[0] : '';
}

function reconcileOrphanedGitignoreLeftByFlippingScriptsCommit(
  root: string,
): void {
  expect(runCli(['update', root]).status).toBe(0);
}

describe('doctorExitCode', () => {
  it('returns badConfig when config problems are present even with no findings', () => {
    const code = doctorExitCode({
      configProblems: ['bad shape'],
      findings: [],
      drifted: [],
    });
    expect(code).toBe(EXIT.badConfig);
  });

  it('returns badConfig even when an ERROR finding is also present, since config outranks it', () => {
    const findings: Finding[] = [{ level: 'ERROR', msg: 'broken' }];
    const code = doctorExitCode({
      configProblems: ['bad shape'],
      findings,
      drifted: [],
    });
    expect(code).toBe(EXIT.badConfig);
  });

  it('returns error when an ERROR finding is present alone', () => {
    const findings: Finding[] = [{ level: 'ERROR', msg: 'broken' }];
    const code = doctorExitCode({
      configProblems: [],
      findings,
      drifted: [],
    });
    expect(code).toBe(EXIT.error);
  });

  it('returns ok when only a WARN finding is present', () => {
    const findings: Finding[] = [{ level: 'WARN', msg: 'heads up' }];
    const code = doctorExitCode({
      configProblems: [],
      findings,
      drifted: [],
    });
    expect(code).toBe(EXIT.ok);
  });

  it('returns error when blocking drift is present alone', () => {
    const code = doctorExitCode({
      configProblems: [],
      findings: [],
      drifted: [drift({ status: 'missing' })],
    });
    expect(code).toBe(EXIT.error);
  });

  it('returns ok when the only drift is "yours", since a deliberate edit must not hold the exit red', () => {
    const code = doctorExitCode({
      configProblems: [],
      findings: [],
      drifted: [drift({ status: 'yours' })],
    });
    expect(code).toBe(EXIT.ok);
  });

  it('returns ok when everything is empty', () => {
    const code = doctorExitCode({
      configProblems: [],
      findings: [],
      drifted: [],
    });
    expect(code).toBe(EXIT.ok);
  });
});

describe('blockingDrift', () => {
  it.each(['yours', 'conflict'] as const)(
    'excludes an entry with status "%s"',
    (status) => {
      expect(blockingDrift([drift({ status })])).toEqual([]);
    },
  );

  it('excludes an entry with yours: true even when its status is not "yours"', () => {
    const result = blockingDrift([drift({ status: 'orphaned', yours: true })]);
    expect(result).toEqual([]);
  });

  it.each(['missing', 'stale', 'no-marker', 'orphaned'] as const)(
    'keeps a "%s" entry that is not yours',
    (status) => {
      const entry = drift({ status });
      expect(blockingDrift([entry])).toEqual([entry]);
    },
  );
});

const EDITED_SKILL = '.claude/skills/ready/SKILL.md';

describe('doctor on a freshly initialized pnpm monorepo', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', { modules: 'ready' });
    givePathTakingFixScripts(root);
  });

  it('exits 0 and reports healthy', () => {
    const r = runCli(['doctor', root]);
    expect(r.status, `expected healthy, got:\n${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/healthy/);
  });

  it('exits 0 and names a locally edited houserules file in a readout, since nothing can acknowledge the edit', () => {
    appendFileSync(join(root, EDITED_SKILL), '<!-- tweak -->\n');

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(
      /your edits on 1 houserules file\(s\), kept as-is: \.claude\/skills\/ready\/SKILL\.md/,
    );
  });

  it('prints no warning and no diff for a locally edited houserules file houserules has not changed since', () => {
    appendFileSync(join(root, EDITED_SKILL), '<!-- tweak -->\n');

    const r = runCli(['doctor', root]);
    expect(r.stdout).not.toMatch(/WARN/);
    expect(r.stdout).not.toMatch(/-<!-- tweak -->/);
  });

  it('does not offer --fix when the only drift is a local edit that --fix would not touch', () => {
    appendFileSync(join(root, EDITED_SKILL), '<!-- tweak -->\n');

    expect(runCli(['doctor', root]).stdout).not.toMatch(/to reconcile/);
  });

  it('offers --fix when a kit-owned file is missing', () => {
    rmSync(join(root, '.claude/scripts/guard-bash.mjs'));

    expect(runCli(['doctor', root]).stdout).toMatch(/to reconcile/);
  });

  it('exits 1 when a kit-owned file is missing', () => {
    const guard = join(root, '.claude/scripts/guard-bash.mjs');
    rmSync(guard);

    const r = runCli(['doctor', root]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\.claude\/scripts\/guard-bash\.mjs: missing/);
  });

  it('exits 0 with a warning when a hook is unwired in settings.json', () => {
    const settingsPath = join(root, '.claude/settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    settings.hooks.SessionStart = [];
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const r = runCli(['doctor', root]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /hook-wiring\.json wires SessionStart hooks but \.claude\/settings\.json has no hook-dispatch\.mjs entry for SessionStart/,
    );
  });

  it('exits 0 with a warning when a package fix script drifts from houserules.config.json', () => {
    const pkgPath = join(root, 'games/cityville/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      scripts: Record<string, unknown>;
    };
    delete pkg.scripts.fix;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    const r = runCli(['doctor', root]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /fix script "fix" not in games\/cityville\/package\.json/,
    );
  });
});

describe('doctor resident-context limits', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('reports per-file lines when the seeded root CLAUDE.md is under the limit', () => {
    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(
      /resident context \(.*\): ~\d+ tokens \/ \d+ lines/,
    );
    expect(r.stdout).toMatch(
      /CLAUDE\.md: \d+ lines \(documented limit 200 per file\)/,
    );
    expect(r.stdout).not.toMatch(/vs budget|exceeds budget|headroom/);
  });

  it('lists a huge nested package CLAUDE.md separately and never sums it into the resident total, since nested CLAUDE.md is the on-demand tier', () => {
    writeFileSync(join(root, 'games/cityville/CLAUDE.md'), 'x\n'.repeat(400));

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/resident context \(.*\): ~\d+ tokens/);
    expect(r.stdout).toMatch(/nested.*games\/cityville\/CLAUDE\.md/);
    expect(r.stdout).not.toMatch(/over the 200-line per-file limit/);
  });

  it('warns naming CLAUDE.md once it grows past 200 lines', () => {
    growClaudeMdPastBudget(root);

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(
      /CLAUDE\.md is \d+ lines, over the 200-line per-file limit/,
    );
    expect(r.stdout).not.toMatch(/vs budget|exceeds budget|OVER/);
  });
});

describe('doctor resident-context — rules and .claude/CLAUDE.md', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', { modules: 'code-cleanliness' });
  });

  it('excludes a path-scoped rule from the resident readout', () => {
    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/resident context.*code-cleanliness/);
    expect(r.stdout).not.toMatch(/loaded on EVERY turn/);
  });

  it('lists a rule with no "paths:" frontmatter as resident and warns about it', () => {
    writeFileSync(
      join(root, '.claude/rules/always.md'),
      '---\ndescription: "no globs"\n---\n\n# Always\n',
    );

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(
      /resident context \(CLAUDE\.md \+ \.claude\/rules\/always\.md \+ 1 @-import\(s\)\)/,
    );
    expect(r.stdout).toMatch(/loaded on EVERY turn.*always\.md/);
  });

  it('reads .claude/CLAUDE.md as its own file and warns once it grows past 200 lines', () => {
    writeFileSync(join(root, '.claude/CLAUDE.md'), '# big\n'.repeat(250));

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(
      /resident context \(CLAUDE\.md \+ \.claude\/CLAUDE\.md/,
    );
    expect(r.stdout).toMatch(
      /\.claude\/CLAUDE\.md is \d+ lines, over the 200-line per-file limit/,
    );
    expect(r.stdout).not.toMatch(/vs budget|exceeds budget|OVER/);
  });
});

describe('doctor resident skill/agent description budget', () => {
  const lineRe =
    /resident skill\/agent descriptions \((\d+) skill\(s\) \+ (\d+) agent\(s\)\): ~(\d+) tokens/;

  it('reports a line with a positive skill and agent count and a positive token estimate when skills/agents are installed', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'reviewers' });

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    const match = lineRe.exec(r.stdout);
    expect(match, r.stdout).not.toBeNull();
    const skillCount = Number(match![1]);
    const agentCount = Number(match![2]);
    const tokens = Number(match![3]);
    expect(skillCount).toBe(1);
    expect(agentCount).toBe(3);
    expect(tokens).toBeGreaterThanOrEqual(100);
  });

  it('omits the resident skill/agent descriptions line entirely, rather than folding it into resident context, when none are installed', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/resident skill\/agent descriptions/);
    expect(r.stdout).toMatch(
      /resident context \(CLAUDE\.md \+ 1 @-import\(s\)\)/,
    );
  });

  it('reports a combined resident total that is strictly larger with skills/agents installed than without', () => {
    const withSkills = useInstalledRepo('pnpm-monorepo', {
      modules: 'reviewers',
    });
    const withoutSkills = useInstalledRepo('pnpm-monorepo');

    const withR = runCli(['doctor', withSkills]);
    const withoutR = runCli(['doctor', withoutSkills]);
    const withTokens = Number(lineRe.exec(withR.stdout)![3]);
    const claudeMdOnly = Number(
      /resident context \(CLAUDE\.md \+ 1 @-import\(s\)\): ~(\d+) tokens/.exec(
        withoutR.stdout,
      )![1],
    );
    const claudeMdWithSkills = Number(
      /resident context \(CLAUDE\.md \+ 1 @-import\(s\)\): ~(\d+) tokens/.exec(
        withR.stdout,
      )![1],
    );
    expect(claudeMdWithSkills + withTokens).toBeGreaterThan(claudeMdOnly);
  });

  it('excludes a skill or agent body from the count, since bodies load only on invocation', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'code-cleanliness',
    });
    const before = Number(lineRe.exec(runCli(['doctor', root]).stdout)![3]);

    appendFileSync(
      join(root, '.claude/skills/tidy/SKILL.md'),
      `\n${'x '.repeat(3000)}`,
    );

    const after = Number(lineRe.exec(runCli(['doctor', root]).stdout)![3]);
    expect(after).toBe(before);
  });
});

describe('doctor workspace coverage', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('exits 0 with no "no houserules target" warning when init gave every workspace member a target', () => {
    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/has no houserules target/);
  });

  it('warns pointing at houserules.config.json when a workspace package is added after init', () => {
    mkdirSync(join(root, 'apps/newgame'), { recursive: true });
    writeFileSync(
      join(root, 'apps/newgame/package.json'),
      JSON.stringify({ name: '@fix/newgame', private: true }, null, 2),
    );

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(
      /workspace package "@fix\/newgame" \(apps\/newgame\) has no houserules target/,
    );
    expect(r.stdout).toMatch(/houserules\.config\.json/);
  });
});

describe('doctor on a houserules.config.json the schema rejects', () => {
  let root: string;

  function breakConfig(
    mutate: (config: Record<string, unknown>) => void,
  ): void {
    const path = join(root, '.claude/houserules.config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    mutate(config);
    writeFileSync(path, JSON.stringify(config, null, 2));
  }

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('exits 2 rather than crashing when targets is not an array', () => {
    breakConfig((c) => {
      c.targets = 'nope';
    });

    expect(runCli(['doctor', root]).status).toBe(EXIT.badConfig);
  });

  it('names the offending field instead of printing a stack trace', () => {
    breakConfig((c) => {
      c.targets = 'nope';
    });

    const r = runCli(['doctor', root]);

    expect(r.stdout).toMatch(/houserules\.config\.json: targets/);
    expect(r.stdout).not.toMatch(/TypeError/);
  });

  it('tells the user to fix the config and run again', () => {
    breakConfig((c) => {
      c.packageManager = '';
    });

    expect(runCli(['doctor', root]).stdout).toMatch(
      /Fix the problems above, then run doctor again\./,
    );
  });

  it('reports that every other check was skipped', () => {
    breakConfig((c) => {
      c.packageManager = '';
    });

    expect(runDoctorJson(root).configBlocked, 'config blocked').toBe(true);
  });

  it('skips the drift computation instead of reporting an empty drift list as clean', () => {
    rmSync(join(root, '.claude/scripts/guard-bash.mjs'));
    breakConfig((c) => {
      c.packageManager = '';
    });

    const report = runDoctorJson(root);

    expect(report.drift).toEqual([]);
    expect(report.configBlocked, 'config blocked').toBe(true);
  });

  it('skips the resident-context readout, since that check reads the config too', () => {
    breakConfig((c) => {
      c.packageManager = '';
    });

    expect(runDoctorJson(root).readouts).toEqual([]);
  });

  it('refuses to write under --fix, since the plan would be built from a config it rejected', () => {
    rmSync(join(root, '.claude/scripts/guard-bash.mjs'));
    breakConfig((c) => {
      c.packageManager = '';
    });

    const status = runCli(['doctor', root, '--fix']).status;

    expect(status).toBe(EXIT.badConfig);
    expect(
      existsSync(join(root, '.claude/scripts/guard-bash.mjs')),
      'no write under a rejected config',
    ).toBe(false);
  });
});

describe('doctor committed rendered ledger detection', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('says nothing on a fresh install, where the rendered ledgers are gitignored', () => {
    const r = runCli(['doctor', root]);

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/rendered ledger file\(s\)/);
  });

  it('warns with the untrack command when a rendered ledger is committed', () => {
    seedLedger(root);
    writeFileSync(join(root, 'BACKLOG.md'), '# Backlog\n\n## [X-aaaaaa] t\n');
    runIn(root, 'git', ['add', '-f', 'BACKLOG.md']);

    const r = runCli(['doctor', root]);

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/rendered ledger file\(s\)/);
    expect(r.stdout).toMatch(/git rm --cached/);
  });

  it('stays silent for a repo with its own BACKLOG.md and no ledger behind it', () => {
    writeFileSync(join(root, 'BACKLOG.md'), '# My own backlog\n');
    runIn(root, 'git', ['add', '-f', 'BACKLOG.md']);

    const r = runCli(['doctor', root]);

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/rendered ledger file\(s\)/);
  });
});

describe('doctor committed ledger log detection', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('says nothing on a fresh install, where the ledger log is gitignored', () => {
    const r = runCli(['doctor', root]);

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/ledger log\(s\)/);
  });

  it('warns with the untrack command when a ledger log is committed', () => {
    seedLedger(root);
    runIn(root, 'git', ['add', '-f', '.claude/ledgers/backlog.jsonl']);

    const r = runCli(['doctor', root]);

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/ledger log\(s\) are committed/);
    expect(r.stdout).toMatch(/git rm --cached/);
  });
});

function seedLedger(root: string): void {
  const dir = join(root, '.claude/ledgers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'backlog.jsonl'),
    '{"ts":"2026-01-01T00:00:00.000Z","id":"X-aaaaaa","action":"add","file":"BACKLOG.md","title":"t","chat":null}\n',
  );
}

describe('doctor committed .claude/scripts detection', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('exits 0 with no committed-scripts warning on a fresh install, since scripts are gitignored', () => {
    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/script\(s\).*are committed/);
  });

  it('exits 0 with a git rm --cached warning when .claude/scripts get committed', () => {
    runIn(root, 'git', ['add', '-f', '.claude/scripts']);
    runIn(root, 'git', ['commit', '-qm', 'committed scripts']);

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/script\(s\).*are committed/);
    expect(r.stdout).toMatch(/git rm --cached/);
  });

  it('suppresses the committed-scripts finding when houserules.config.json sets scripts.commit: true', () => {
    const configPath = join(root, '.claude/houserules.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.scripts = { commit: true };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'opt-in commit + config change']);
    reconcileOrphanedGitignoreLeftByFlippingScriptsCommit(root);

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/script\(s\).*are committed/);
  });
});

describe('doctor on an uninstalled repo', () => {
  it('exits 1 reporting houserules is not installed', () => {
    const root = useRepo('non-js');

    const r = runCli(['doctor', root]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/houserules not installed/);
  });
});

describe('doctor committed reference template detection', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('exits 0 with no reference-template warning on a fresh install, since templates are gitignored', () => {
    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/reference template/);
  });

  it('exits 0 with a git rm --cached warning when reference templates get committed', () => {
    runIn(root, 'git', ['add', '-f', '.claude/templates']);
    runIn(root, 'git', ['commit', '-qm', 'committed templates']);

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/reference template\(s\).*are committed/);
    expect(r.stdout).toMatch(/git rm --cached/);
  });
});

describe('doctor on a manifest listing a module houserules no longer defines', () => {
  it('warns by name and still exits 0', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const manifestPath = join(root, '.claude/houserules.manifest.json');
    const manifest = readJson<HouseManifestShape>(manifestPath);
    manifest.modules = [...manifest.modules, 'ghost-module'];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    // init may record modules in the config too, and the config is read first.
    const configPath = join(root, '.claude/houserules.config.json');
    const config = readJson<{ modules?: string[] }>(configPath);
    if (config.modules) {
      config.modules = [...config.modules, 'ghost-module'];
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(
      /module "ghost-module" which houserules no longer defines/,
    );
  });
});

describe('doctor --fix', () => {
  let root: string;
  let skill: string;

  beforeEach(() => {
    root = useInstalledRepo('npm-single', { modules: 'ready' });
    skill = join(root, EDITED_SKILL);
  });

  it('restores a stale file but leaves a `yours` edit alone', () => {
    const canonical = readFileSync(skill, 'utf8');
    appendFileSync(skill, '// my tweak\n');

    expect(runCli(['doctor', root, '--fix']).status).toBe(0);

    expect(readFileSync(skill, 'utf8')).toMatch(/my tweak/);
    expect(readFileSync(skill, 'utf8')).not.toBe(canonical);
  });

  it('reconciles a `yours` file back to canonical with --force', () => {
    const canonical = readFileSync(skill, 'utf8');
    appendFileSync(skill, '// my tweak\n');

    expect(runCli(['doctor', root, '--fix', '--force']).status).toBe(0);

    expect(readFileSync(skill, 'utf8')).toBe(canonical);
    expect(runDoctorJson(root).counts.drifted).toBe(0);
  });

  it('recreates a missing file', () => {
    rmSync(skill);
    expect(runDoctorJson(root).exitCode).toBe(1);

    expect(runCli(['doctor', root, '--fix']).status).toBe(0);
    expect(existsSync(skill), 'missing file recreated').toBe(true);
  });
});

describe('doctor and a body-owned rule frontmatter', () => {
  let root: string;
  let rulePath: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', { modules: 'code-cleanliness' });
    rulePath = join(root, '.claude/rules/code-cleanliness.md');
  });

  it('reports nothing anywhere for a customized frontmatter whose shipped default has not moved', () => {
    const original = readFileSync(rulePath, 'utf8');
    const body = original.slice(frontmatterOf(original).length);
    const customized = '---\npaths:\n  - "custom/**"\n---\n';
    writeFileSync(rulePath, customized + body);

    const r = runCli(['doctor', root]);

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/code-cleanliness\.md/);
  });

  it('warns once when a customized frontmatter differs from a default houserules has since moved on from, while still exiting 0', () => {
    const original = readFileSync(rulePath, 'utf8');
    const body = original.slice(frontmatterOf(original).length);
    const customized = '---\npaths:\n  - "custom/**"\n---\n';
    writeFileSync(rulePath, customized + body);
    const manifest = manifestOf(root) as {
      files: Record<string, unknown>;
      [key: string]: unknown;
    };
    manifest.files['.claude/rules/code-cleanliness.md'] = {
      body: sha256(body),
      frontmatter: sha256('---\npaths:\n  - "an-older-default/**"\n---\n'),
    };
    writeManifest(
      root,
      manifest as unknown as Parameters<typeof writeManifest>[1],
    );

    const r = runCli(['doctor', root]);

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(
      /code-cleanliness\.md: houserules shipped a new default `paths:`/,
    );
  });
});

describe('doctor, the suspected-formatter-mangle hint', () => {
  let root: string;

  const KIT_SKILLS = [
    '.claude/skills/orchestrate/SKILL.md',
    '.claude/skills/plan-project/SKILL.md',
    '.claude/skills/sweep/SKILL.md',
  ];

  function editThreeKitFiles(): void {
    for (const rel of KIT_SKILLS) {
      appendFileSync(join(root, rel), '<!-- tweak -->\n');
    }
  }

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', { modules: 'orchestrate' });
  });

  it('warns with the recovery command when several houserules files read as edited and no .prettierignore block exists', () => {
    editThreeKitFiles();

    const r = runCli(['doctor', root]);

    expect(r.stdout).toMatch(/likely cause/);
    expect(r.stdout).toMatch(/npx houserules doctor --fix --force/);
  });

  it('does not move the exit code, since a WARN finding alone never does', () => {
    editThreeKitFiles();

    expect(runCli(['doctor', root]).status).toBe(0);
  });

  it('stays silent once a .prettierignore block is present', () => {
    editThreeKitFiles();
    writeFileSync(
      join(root, '.prettierignore'),
      `${PRETTIERIGNORE_REGION.start}\n.claude/scripts/\n${PRETTIERIGNORE_REGION.end}\n`,
    );

    const r = runCli(['doctor', root]);

    expect(r.stdout).not.toMatch(/likely cause/);
  });

  it('stays silent when only a couple of houserules files read as edited', () => {
    appendFileSync(join(root, KIT_SKILLS[0]!), '<!-- tweak -->\n');
    appendFileSync(join(root, KIT_SKILLS[1]!), '<!-- tweak -->\n');

    const r = runCli(['doctor', root]);

    expect(r.stdout).not.toMatch(/likely cause/);
  });
});

describe('doctor flag validation', () => {
  it('rejects --prune without --fix', () => {
    const result = runCli(['doctor', '--prune']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--prune requires --fix/);
  });

  it('rejects --force without --fix', () => {
    expect(runCli(['doctor', '--force']).stderr).toMatch(
      /--force requires --fix/,
    );
  });
});

describe('doctor instructions-file silencing', () => {
  it('warns only once a CLAUDE.md appears beside the AGENTS.md carrying the block', () => {
    const root = useRepo('pnpm-single');
    writeFileSync(join(root, 'AGENTS.md'), '# Repo\n');
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    // An empty HOME keeps the developer's real user settings out of the result.
    const env = {
      ...process.env,
      HOME: mkdtempSync(join(tmpdir(), 'kit-home-')),
    };

    const before = runCli(['doctor', root], { env });
    expect(before.status, before.stdout).toBe(0);
    expect(before.stdout).not.toMatch(/silences AGENTS\.md/);

    writeFileSync(join(root, 'CLAUDE.md'), '# mine\n');
    const after = runCli(['doctor', root], { env });
    expect(after.stdout).toMatch(/CLAUDE\.md silences AGENTS\.md/);
  });
});

describe('doctor on an edited houserules file, by who owns it', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', { modules: 'ready' });
    givePathTakingFixScripts(root);
  });

  it('offers eject to keep an edited ignored file and a delete-then-update to discard it', () => {
    appendFileSync(join(root, EDITED_SKILL), '<!-- tweak -->\n');

    const report = runDoctorJson(root);
    const readouts = report.readouts ?? [];
    const findings = report.findings ?? [];

    expect(readouts).toContain(
      `${EDITED_SKILL}: to keep your edit, run \`npx houserules eject ${EDITED_SKILL}\``,
    );
    const discard = readouts.find((line) => line.includes('to discard'));
    expect(discard).toBe(
      `${EDITED_SKILL}: to discard your edit, delete the file and run \`npx houserules update\`, which recreates it`,
    );
    expect(discard).not.toContain('--force');
    expect(findings).toEqual([]);
  });

  it('offers neither line for an edited ejected file', () => {
    editHouseConfig(root, (config) => {
      config.ejected = [EDITED_SKILL];
    });
    appendFileSync(join(root, EDITED_SKILL), '<!-- tweak -->\n');

    const readouts = runDoctorJson(root).readouts ?? [];

    expect(readouts.join('\n')).not.toContain('houserules eject');
    expect(readouts.join('\n')).not.toContain('to discard');
  });

  it('offers neither line for an edited file under payload.commit: true', () => {
    editHouseConfig(root, (config) => {
      config.payload = { commit: true };
    });
    runCli(['update', root]);
    appendFileSync(join(root, EDITED_SKILL), '<!-- tweak -->\n');

    const readouts = runDoctorJson(root).readouts ?? [];

    expect(readouts.join('\n')).toContain('your edits on 1 houserules file');
    expect(readouts.join('\n')).not.toContain('houserules eject');
  });

  it('drops the --fix --force clause from the conflict finding of an edited ejected file', () => {
    editHouseConfig(root, (config) => {
      config.ejected = [EDITED_SKILL];
    });
    appendFileSync(join(root, EDITED_SKILL), '<!-- tweak -->\n');
    const manifest = manifestOf(root);
    manifest.files[EDITED_SKILL] = sha256('an older shipped version');
    writeManifest(root, manifest);

    const findings = runDoctorJson(root).findings ?? [];

    const conflict = findings.find((f) => f.msg.startsWith(EDITED_SKILL));
    expect(conflict?.msg).toContain('you edited it and houserules shipped');
    expect(conflict?.msg).not.toContain('--fix --force');
  });

  it('keeps the --fix --force clause on the conflict finding of an un-ejected file', () => {
    appendFileSync(join(root, EDITED_SKILL), '<!-- tweak -->\n');
    const manifest = manifestOf(root);
    manifest.files[EDITED_SKILL] = sha256('an older shipped version');
    writeManifest(root, manifest);

    const findings = runDoctorJson(root).findings ?? [];

    expect(findings.find((f) => f.msg.startsWith(EDITED_SKILL))?.msg).toContain(
      '--fix --force',
    );
  });
});
