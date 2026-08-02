import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo, useRepo } from '#test/repo';
import { runCli, runIn } from '#test/run';
import { readJson } from '#test/installed-tree';
import { runDoctorJson } from '#test/doctor-report';
import {
  allHookCommands,
  blockingDrift,
  doctorExitCode,
  frontmatterDescription,
  parseImports,
  ruleGlobs,
  type Finding,
} from '../doctor.js';
import { EXIT } from '../../types.js';
import type { FileDrift } from '../../core/drift.js';

function drift(overrides: Partial<FileDrift> = {}): FileDrift {
  return { path: 'some/file', status: 'stale', ...overrides };
}

function growClaudeMdPastBudget(root: string): void {
  appendFileSync(join(root, 'CLAUDE.md'), '# big\n'.repeat(250));
}

function enableModuleForReal(root: string, moduleId: string): void {
  expect(runCli(['modules', root, '--yes', '--modules', moduleId]).status).toBe(
    0,
  );
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
  it('excludes an entry with status "yours"', () => {
    const result = blockingDrift([drift({ status: 'yours' })]);
    expect(result).toEqual([]);
  });

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

describe('parseImports', () => {
  it('matches an @specifier at the start of the line', () => {
    expect(parseImports('@lib/thing.md')).toEqual(['lib/thing.md']);
  });

  it('matches an @specifier that follows whitespace', () => {
    expect(parseImports('see @lib/thing.md for more')).toEqual([
      'lib/thing.md',
    ]);
  });

  it('matches several @specifiers in one text', () => {
    expect(parseImports('@a.md and @b.md')).toEqual(['a.md', 'b.md']);
  });

  it('does not match an email address, since @ must be preceded by whitespace or line start', () => {
    expect(parseImports('contact foo@bar.com for help')).toEqual([]);
  });

  it('returns an empty list for empty text', () => {
    expect(parseImports('')).toEqual([]);
  });
});

describe('ruleGlobs', () => {
  it('parses the inline array form', () => {
    expect(ruleGlobs('---\npaths: [a/**, b/**]\n---\n\nbody')).toEqual([
      'a',
      'b',
    ]);
  });

  it('parses the dashed list form', () => {
    expect(ruleGlobs('---\npaths:\n  - a/**\n  - b/**\n---\n\nbody')).toEqual([
      'a',
      'b',
    ]);
  });

  it('strips single and double quotes around each entry', () => {
    expect(
      ruleGlobs('---\npaths:\n  - \'a/**\'\n  - "b/**"\n---\n\nbody'),
    ).toEqual(['a', 'b']);
  });

  it('strips a trailing /** from an entry', () => {
    expect(ruleGlobs('---\npaths:\n  - src/**\n---\n\nbody')).toEqual(['src']);
  });

  it('drops a bare ** entry', () => {
    expect(ruleGlobs('---\npaths:\n  - "**"\n---\n\nbody')).toEqual([]);
  });

  it('returns an empty list when there is no frontmatter at all', () => {
    expect(ruleGlobs('# just a heading\n')).toEqual([]);
  });

  it('returns an empty list when frontmatter has no paths: key', () => {
    expect(ruleGlobs('---\ndescription: "no globs"\n---\n\nbody')).toEqual([]);
  });

  it('stops the dashed list at the next frontmatter key', () => {
    expect(
      ruleGlobs(
        '---\npaths:\n  - a/**\n  - b/**\ndescription: "next key"\n---\n\nbody',
      ),
    ).toEqual(['a', 'b']);
  });
});

describe('frontmatterDescription', () => {
  it('reads an unquoted description', () => {
    expect(
      frontmatterDescription('---\ndescription: plain text\n---\n\nbody'),
    ).toBe('plain text');
  });

  it('reads a single-quoted description, stripping the quotes', () => {
    expect(
      frontmatterDescription("---\ndescription: 'quoted text'\n---\n\nbody"),
    ).toBe('quoted text');
  });

  it('reads a double-quoted description, stripping the quotes', () => {
    expect(
      frontmatterDescription('---\ndescription: "quoted text"\n---\n\nbody'),
    ).toBe('quoted text');
  });

  it('returns null when frontmatter has no description: key', () => {
    expect(frontmatterDescription('---\npaths: [a]\n---\n\nbody')).toBeNull();
  });

  it('returns null when there is no frontmatter at all', () => {
    expect(frontmatterDescription('# just a heading\n')).toBeNull();
  });
});

describe('allHookCommands', () => {
  it('returns an empty list for null settings', () => {
    expect(allHookCommands(null)).toEqual([]);
  });

  it('returns an empty list for undefined settings', () => {
    expect(allHookCommands(undefined)).toEqual([]);
  });

  it('returns an empty list when settings has no hooks', () => {
    expect(allHookCommands({})).toEqual([]);
  });

  it('flattens a single hook command', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command' as const, command: 'a.mjs' }] },
        ],
      },
    };
    expect(allHookCommands(settings)).toEqual(['a.mjs']);
  });

  it('flattens several hook commands across several events', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command' as const, command: 'a.mjs' }] },
        ],
        PostToolUse: [
          {
            hooks: [
              { type: 'command' as const, command: 'b.mjs' },
              { type: 'command' as const, command: 'c.mjs' },
            ],
          },
        ],
      },
    };
    expect(allHookCommands(settings)).toEqual(['a.mjs', 'b.mjs', 'c.mjs']);
  });
});

describe('doctor on a freshly initialized pnpm monorepo', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('exits 0 and reports healthy', () => {
    const r = runCli(['doctor', root]);
    expect(r.status, `expected healthy, got:\n${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/healthy/);
  });

  it('exits 0 and reports a locally edited kit file as "yours" with a diff, since nothing can acknowledge the edit', () => {
    const guard = join(root, '.claude/scripts/guard-bash.mjs');
    appendFileSync(guard, '// tweak\n');

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/\.claude\/scripts\/guard-bash\.mjs: yours/);
    expect(
      r.stdout,
      'diff is against what the kit would write, so the added line shows as `-`',
    ).toMatch(/-\/\/ tweak/);
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
    expect(r.stdout).toMatch(/session-context\.mjs not wired/);
  });

  it('exits 0 with a warning when a package fix script drifts from kit.config.json', () => {
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

describe('doctor resident-context budget', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('reports headroom when the seeded root CLAUDE.md is under budget', () => {
    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/resident context.*headroom/);
    expect(r.stdout).not.toMatch(/always-loaded context exceeds budget/);
  });

  it('lists a huge nested package CLAUDE.md separately and never sums it into the resident total, since nested CLAUDE.md is the on-demand tier', () => {
    writeFileSync(join(root, 'games/cityville/CLAUDE.md'), 'x\n'.repeat(400));

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/resident context.*headroom/);
    expect(r.stdout).toMatch(/nested.*games\/cityville\/CLAUDE\.md/);
    expect(r.stdout).not.toMatch(/always-loaded context exceeds budget/);
  });

  it('reports OVER budget once the root CLAUDE.md grows past it', () => {
    growClaudeMdPastBudget(root);

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/resident context.*OVER/);
    expect(r.stdout).toMatch(/always-loaded context exceeds budget/);
  });
});

describe('doctor resident-context — rules and .claude/CLAUDE.md', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', { modules: 'code-comments' });
  });

  it('excludes a path-scoped rule from the resident readout', () => {
    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/resident context.*code-comments/);
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
      /resident context \(CLAUDE\.md \+ \.claude\/rules\/always\.md\)/,
    );
    expect(r.stdout).toMatch(/loaded on EVERY turn.*always\.md/);
  });

  it('sums .claude/CLAUDE.md into the resident total and reports OVER once it grows past budget', () => {
    writeFileSync(join(root, '.claude/CLAUDE.md'), '# big\n'.repeat(250));

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(
      /resident context \(CLAUDE\.md \+ \.claude\/CLAUDE\.md/,
    );
    expect(r.stdout).toMatch(/resident context.*OVER/);
    expect(r.stdout).toMatch(/always-loaded context exceeds budget/);
  });
});

describe('doctor resident skill/agent description budget', () => {
  const lineRe =
    /resident skill\/agent descriptions \((\d+) skill\(s\) \+ (\d+) agent\(s\)\): ~(\d+) tokens/;

  it('reports a line with a positive skill and agent count and a positive token estimate when skills/agents are installed', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    const match = lineRe.exec(r.stdout);
    expect(match, r.stdout).not.toBeNull();
    const skillCount = Number(match![1]);
    const agentCount = Number(match![2]);
    const tokens = Number(match![3]);
    expect(skillCount + agentCount).toBeGreaterThan(0);
    expect(tokens).toBeGreaterThan(0);
  });

  it('omits the resident skill/agent descriptions line entirely, rather than folding it into resident context, when none are installed', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: '-backlog,-changesets,-reviewers',
    });

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/resident skill\/agent descriptions/);
    expect(r.stdout).toMatch(/resident context \(CLAUDE\.md\)/);
  });

  it('reports a combined resident total that is strictly larger with skills/agents installed than without', () => {
    const withSkills = useInstalledRepo('pnpm-monorepo');
    const withoutSkills = useInstalledRepo('pnpm-monorepo', {
      modules: '-backlog,-changesets,-reviewers',
    });

    const withR = runCli(['doctor', withSkills]);
    const withoutR = runCli(['doctor', withoutSkills]);
    const withTokens = Number(lineRe.exec(withR.stdout)![3]);
    const claudeMdOnly = Number(
      /resident context \(CLAUDE\.md\): ~(\d+) tokens/.exec(
        withoutR.stdout,
      )![1],
    );
    const claudeMdWithSkills = Number(
      /resident context \(CLAUDE\.md\): ~(\d+) tokens/.exec(withR.stdout)![1],
    );
    expect(claudeMdWithSkills + withTokens).toBeGreaterThan(claudeMdOnly);
  });

  it('excludes a skill or agent body from the count, since bodies load only on invocation', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const before = Number(lineRe.exec(runCli(['doctor', root]).stdout)![3]);

    appendFileSync(
      join(root, '.claude/skills/backlog-add/SKILL.md'),
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

  it('exits 0 with no "no kit target" warning when init gave every workspace member a target', () => {
    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/has no kit target/);
  });

  it('warns pointing at kit.config.json when a workspace package is added after init', () => {
    mkdirSync(join(root, 'apps/newgame'), { recursive: true });
    writeFileSync(
      join(root, 'apps/newgame/package.json'),
      JSON.stringify({ name: '@fix/newgame', private: true }, null, 2),
    );

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(
      /workspace package "@fix\/newgame" \(apps\/newgame\) has no kit target/,
    );
    expect(r.stdout).toMatch(/kit\.config\.json/);
  });
});

describe('doctor terse-style output-style detection', () => {
  let root: string;
  let setStyle: (v: string | undefined) => void;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    enableModuleForReal(root, 'terse-style');

    const localPath = join(root, '.claude/settings.local.json');
    setStyle = (v: string | undefined) => {
      const local = JSON.parse(readFileSync(localPath, 'utf8')) as {
        outputStyle?: string;
      };
      if (v === undefined) delete local.outputStyle;
      else local.outputStyle = v;
      writeFileSync(localPath, JSON.stringify(local, null, 2));
    };
  });

  it('reports INACTIVE when installed but no outputStyle is set', () => {
    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/terse-style: INACTIVE/);
  });

  it('reports ACTIVE when settings.local.json sets the exact frontmatter name', () => {
    setStyle('Kit Terse');

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/terse-style: ACTIVE/);
  });

  it('warns with the exact fix when the filename slug is set instead of the frontmatter name, since it silently falls back to Default', () => {
    setStyle('kit-terse');

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/"kit-terse".*falls back to Default/);
    expect(r.stdout).toMatch(/"Kit Terse"/);
  });

  it('reports INACTIVE naming the active style when a different style is selected', () => {
    setStyle('Explanatory');

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/terse-style: INACTIVE.*Explanatory/);
  });
});

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

  it('suppresses the committed-scripts finding when kit.config.json sets scripts.commit: true', () => {
    const configPath = join(root, '.claude/kit.config.json');
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
  it('exits 1 reporting the kit is not installed', () => {
    const root = useRepo('non-js');

    const r = runCli(['doctor', root]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/kit not installed/);
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
    runIn(root, 'git', ['add', '-f', '.claude/kit-templates']);
    runIn(root, 'git', ['commit', '-qm', 'committed templates']);

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/reference template\(s\).*are committed/);
    expect(r.stdout).toMatch(/git rm --cached/);
  });
});

describe('doctor on a manifest listing a module the kit no longer defines', () => {
  it('warns by name and still exits 0', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const manifestPath = join(root, '.claude/kit-manifest.json');
    const manifest = readJson(manifestPath);
    manifest.modules = [...manifest.modules, 'ghost-module'];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(
      /module "ghost-module" which this kit no longer defines/,
    );
  });
});

describe('doctor --fix', () => {
  let root: string;
  let guard: string;

  beforeEach(() => {
    root = useInstalledRepo('npm-single');
    guard = join(root, '.claude/scripts/guard-bash.mjs');
  });

  it('restores a stale file but leaves a `yours` edit alone', () => {
    const canonical = readFileSync(guard, 'utf8');
    appendFileSync(guard, '// my tweak\n');

    expect(runCli(['doctor', root, '--fix']).status).toBe(0);

    expect(readFileSync(guard, 'utf8')).toMatch(/my tweak/);
    expect(readFileSync(guard, 'utf8')).not.toBe(canonical);
  });

  it('reconciles a `yours` file back to canonical with --force', () => {
    const canonical = readFileSync(guard, 'utf8');
    appendFileSync(guard, '// my tweak\n');

    expect(runCli(['doctor', root, '--fix', '--force']).status).toBe(0);

    expect(readFileSync(guard, 'utf8')).toBe(canonical);
    expect(runDoctorJson(root).counts.drifted).toBe(0);
  });

  it('recreates a missing file', () => {
    rmSync(guard);
    expect(runDoctorJson(root).exitCode).toBe(1);

    expect(runCli(['doctor', root, '--fix']).status).toBe(0);
    expect(existsSync(guard)).toBe(true);
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
