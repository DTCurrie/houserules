#!/usr/bin/env node
/**
 * Dev-only tool, never published. Proves every findings-contract checker returns
 * byte-identical stdout+stderr across repeated runs on the same input, which is the property
 * Phase 6 shipped but never tested. Phase 7 deletes prose clauses those checkers now cover,
 * and a checker that is not deterministic must not have its clause deleted.
 *
 * A checker is discovered by walking `packages/*\/payload-dist/scripts/*.mjs` and selecting
 * every script whose source imports `./lib/findings.mjs`, the relative form the build
 * rewrites `@houserules/payload/findings` into. That covers both a plugin's rewritten import
 * and the CLI's own scripts, which sit beside their libs already and need no rewrite.
 *
 * Each checker is staged into a temp `scripts/` + `scripts/lib/` layout, the same flattened
 * shape install produces, since a checker resolves its libs relative to itself and does not
 * run from `payload-dist` directly. The libs it needs are found by following its own relative
 * imports, first inside its own package's `payload-dist/scripts/lib/`, then in
 * `@houserules/payload`'s, and recursively through any lib-to-lib import.
 *
 * A checker with a small fixture is run twice as a fresh `node` subprocess, on the same
 * input, and the combined stdout+stderr must be byte-identical. Where a checker takes a list
 * of file paths, a third run repeats the fixture with that list reversed, since the likeliest
 * real failure is enumeration order rather than process-level state.
 *
 * Usage: `node scripts/verify-checker-determinism.mjs`
 *
 * Requires a prior build (`pnpm build` at the workspace root). Exits 1 if any checker is
 * non-deterministic, or if a checker's libs cannot be resolved.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const packagesDir = join(repoRoot, 'packages');
const sharedLibDir = join(
  repoRoot,
  'packages/payload/payload-dist/scripts/lib',
);

const FINDINGS_IMPORT = /from\s+['"]\.\/lib\/findings\.mjs['"]/;
const LIB_IMPORT = /from\s+['"]\.\/lib\/([\w.-]+\.mjs)['"]/g;
const SIBLING_LIB_IMPORT = /from\s+['"]\.\/([\w.-]+\.mjs)['"]/g;

/** Every top-level `.mjs` under a package's `payload-dist/scripts/`, skipping `lib/`. */
function scriptFilesOf(packageDir) {
  const scriptsDir = join(packageDir, 'payload-dist', 'scripts');
  if (!existsSync(scriptsDir)) return [];
  return readdirSync(scriptsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => join(scriptsDir, entry.name))
    .sort();
}

function discoverCheckers() {
  const checkers = [];
  for (const name of readdirSync(packagesDir).sort()) {
    const packageDir = join(packagesDir, name);
    for (const scriptPath of scriptFilesOf(packageDir)) {
      const source = readFileSync(scriptPath, 'utf8');
      if (!FINDINGS_IMPORT.test(source)) continue;
      checkers.push({ packageName: name, packageDir, scriptPath, source });
    }
  }
  return checkers;
}

/** Where a lib named `libName` actually lives: the checker's own package first, then shared. */
function resolveLibSource(packageDir, libName) {
  const local = join(packageDir, 'payload-dist', 'scripts', 'lib', libName);
  if (existsSync(local)) return local;
  const shared = join(sharedLibDir, libName);
  if (existsSync(shared)) return shared;
  return null;
}

/**
 * Every lib a checker needs, transitively, by name. Throws when a lib the source imports
 * cannot be found anywhere, since that is a real build defect this gate should not hide.
 */
function collectLibs(checker) {
  const libs = new Map();
  const queue = [...checker.source.matchAll(LIB_IMPORT)].map((m) => m[1]);
  const visited = new Set(queue);
  while (queue.length > 0) {
    const libName = queue.shift();
    const src = resolveLibSource(checker.packageDir, libName);
    if (!src) {
      throw new Error(
        `${checker.scriptPath} imports ./lib/${libName}, which resolves nowhere`,
      );
    }
    const content = readFileSync(src, 'utf8');
    libs.set(libName, content);
    for (const match of content.matchAll(SIBLING_LIB_IMPORT)) {
      const sibling = match[1];
      if (visited.has(sibling)) continue;
      visited.add(sibling);
      queue.push(sibling);
    }
  }
  return libs;
}

/** Stages a checker plus its libs into a fresh `scripts/` tree. Returns the script's path. */
function stageChecker(checker, stagingRoot) {
  const scriptsDir = join(stagingRoot, 'scripts');
  const libDir = join(scriptsDir, 'lib');
  mkdirSync(libDir, { recursive: true });
  const basename = checker.scriptPath.split('/').pop();
  const stagedScript = join(scriptsDir, basename);
  writeFileSync(stagedScript, checker.source);
  for (const [libName, content] of collectLibs(checker)) {
    writeFileSync(join(libDir, libName), content);
  }
  return stagedScript;
}

function initGitFixture(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], {
    cwd: dir,
  });
  execFileSync('git', ['config', 'user.name', 'fixture'], { cwd: dir });
}

function writeFile(dir, relPath, content) {
  const full = join(dir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

/**
 * Fixture builders, keyed by the checker's own basename. Each returns the argv, an optional
 * stdin string, and the cwd the process should run with. A checker not listed here is run
 * with no argv and an empty stdin, which most report "No findings." on, and that gap is
 * reported explicitly rather than silently skipped.
 */
const FIXTURES = {
  'plan-lint.mjs'(dir) {
    initGitFixture(dir);
    writeFile(
      dir,
      '.claude/plans/testslice/phase-1.md',
      [
        '## Slices',
        '',
        '| ID | status |',
        '| --- | --- |',
        '| 7a | INVALID-STATUS |',
        '',
      ].join('\n'),
    );
    return { args: [], cwd: dir };
  },

  'catch-all-filename.mjs'(dir) {
    writeFile(dir, 'utils.ts', 'export const x = 1;\n');
    writeFile(dir, 'currency-format.ts', 'export const y = 1;\n');
    return { args: [join(dir, 'utils.ts'), join(dir, 'currency-format.ts')] };
  },

  'a11y-markup.mjs'(dir) {
    writeFile(dir, 'Bad.tsx', '<div tabindex="5">hi</div>\n');
    writeFile(dir, 'Good.tsx', '<div>hi</div>\n');
    return { args: [join(dir, 'Bad.tsx'), join(dir, 'Good.tsx')] };
  },

  'changeset-gate.mjs'(dir) {
    initGitFixture(dir);
    writeFile(
      dir,
      'package.json',
      JSON.stringify({
        name: 'root',
        private: true,
        workspaces: ['packages/*'],
      }),
    );
    writeFile(
      dir,
      'packages/foo/package.json',
      JSON.stringify({ name: 'foo', version: '0.0.0' }),
    );
    writeFile(dir, 'packages/foo/index.js', 'module.exports = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: dir });
    writeFile(dir, 'packages/foo/index.js', 'module.exports = 2;\n');
    writeFile(
      dir,
      '.changeset/test-cs.md',
      ['---', '"other-pkg": patch', '---', '', 'Something changed.', ''].join(
        '\n',
      ),
    );
    return { args: [], cwd: dir, stdin: '{}' };
  },

  'decision-lint.mjs'(dir) {
    writeFile(
      dir,
      'DECISIONS.md',
      [
        '## [ADOPT-a1b2c3] Some decision',
        '',
        'This decision record leaves out both required closing fields on purpose.',
        '',
        '---',
        '',
      ].join('\n'),
    );
    return { args: [join(dir, 'DECISIONS.md')] };
  },

  'mcp-config-check.mjs'(dir) {
    const server = (pkg) =>
      JSON.stringify({
        mcpServers: {
          'chrome-devtools': {
            args: [pkg, '--headless'],
          },
        },
      });
    writeFile(dir, 'client-a.json', server('chrome-devtools-mcp@0.1.0'));
    writeFile(dir, 'client-b.json', server('not-pinned'));
    return { args: [join(dir, 'client-a.json'), join(dir, 'client-b.json')] };
  },

  'adopt-lint.mjs'(dir) {
    initGitFixture(dir);
    writeFile(
      dir,
      '.claude/houserules.config.json',
      JSON.stringify({
        targets: [
          { name: 'a', label: 'web', pathPrefix: 'apps/a' },
          { name: 'b', label: 'web', pathPrefix: 'apps/b' },
        ],
      }),
    );
    return { args: [], cwd: dir };
  },

  'prose-lint.mjs'(dir) {
    writeFile(
      dir,
      'doc.md',
      [
        'This sentence has one; semicolon in it.',
        '',
        'This paragraph has an em dash — and another — right here.',
        '',
      ].join('\n'),
    );
    return { args: [join(dir, 'doc.md')] };
  },

  'pr-description-lint.mjs'() {
    return { args: [], stdin: '## Summary\nDid some stuff.\n' };
  },

  'svelte-lint.mjs'(dir) {
    writeFile(dir, 'Widget.svelte', '<div>\n  <slot />\n</div>\n');
    return { args: [join(dir, 'Widget.svelte')] };
  },

  'test-layout.mjs'(dir) {
    writeFile(dir, 'src/foo.test.ts', 'export {};\n');
    writeFile(dir, 'src/__test__/bar.test.ts', 'export {};\n');
    writeFile(dir, 'dist/leaked/__test__/baz.test.ts', 'export {};\n');
    return {
      args: [
        join(dir, 'src/foo.test.ts'),
        join(dir, 'src/__test__/bar.test.ts'),
        join(dir, 'dist'),
      ],
    };
  },

  'test-config.mjs'(dir) {
    writeFile(
      dir,
      'vitest.config.ts',
      "export default { test: { include: ['**/*.test.ts'] } };\n",
    );
    return { args: [join(dir, 'vitest.config.ts')] };
  },
};

function runChecker(scriptPath, { args, cwd, stdin }) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: cwd ?? process.cwd(),
    input: stdin ?? '',
    encoding: 'utf8',
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function hasFindings(output) {
  return !output.includes('No findings.');
}

/**
 * Rebuilds the fixture at the SAME absolute path every time, rather than a fresh temp dir
 * per run. A finding's `file` field embeds the fixture's absolute path, so two runs staged
 * under different temp dirs would never compare equal even for a genuinely deterministic
 * checker. The path must be held constant and only the fixture's CONTENTS are rebuilt.
 */
function rebuildFixture(fixtureRoot, buildFixture) {
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(fixtureRoot, { recursive: true });
  return buildFixture
    ? buildFixture(fixtureRoot)
    : { args: [], cwd: fixtureRoot };
}

function problemsFor(checker) {
  const basename = checker.scriptPath.split('/').pop();
  const buildFixture = FIXTURES[basename];
  const stagingRoot = mkdtempSync(
    join(tmpdir(), 'checker-determinism-staging-'),
  );
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'checker-determinism-fx-'));

  try {
    const stagedScript = stageChecker(checker, stagingRoot);

    const fixtureA = rebuildFixture(fixtureRoot, buildFixture);
    const outputFirst = runChecker(stagedScript, fixtureA);

    // Rebuilt at the same path, so a checker that writes anything (adopt-lint's ledger
    // migration, for instance) starts the repeat from the same fixture state, not from its
    // own first run's side effect.
    const fixtureB = rebuildFixture(fixtureRoot, buildFixture);
    const outputSecond = runChecker(stagedScript, fixtureB);

    const problems = [];
    const foundReal = hasFindings(outputFirst) || hasFindings(outputSecond);

    if (outputFirst !== outputSecond) {
      problems.push(
        'two fresh-process runs on the same input produced different output',
        firstDifference(outputFirst, outputSecond),
      );
    }

    if (!buildFixture) {
      problems.push(
        'no fixture is defined for this checker in this script, so it ran with empty input only',
      );
    }

    if (Array.isArray(fixtureA.args) && fixtureA.args.length >= 2) {
      const fixtureC = rebuildFixture(fixtureRoot, buildFixture);
      fixtureC.args = [...fixtureC.args].reverse();
      const outputReversed = runChecker(stagedScript, fixtureC);
      if (outputReversed !== outputFirst) {
        problems.push(
          'reversing the input file order changed the output, which points at ' +
            'enumeration- or insertion-order dependence',
          firstDifference(outputFirst, outputReversed),
        );
      }
    }

    return { problems, foundReal };
  } catch (err) {
    return {
      problems: [`could not run this checker: ${err.message}`],
      foundReal: false,
    };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function firstDifference(a, b) {
  const linesA = a.split('\n');
  const linesB = b.split('\n');
  const max = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < max; i++) {
    if (linesA[i] !== linesB[i]) {
      return `  first differing line ${i + 1}:\n    run A: ${linesA[i] ?? '<missing>'}\n    run B: ${linesB[i] ?? '<missing>'}`;
    }
  }
  return '  outputs differ but no line-by-line difference was found';
}

function main() {
  const checkers = discoverCheckers();
  let failedCount = 0;
  let zeroFindingsCount = 0;
  const zeroFindingsNames = [];

  for (const checker of checkers) {
    const label = `${checker.packageName}/${checker.scriptPath.split('/').pop()}`;
    const { problems, foundReal } = problemsFor(checker);

    if (!foundReal) {
      zeroFindingsCount += 1;
      zeroFindingsNames.push(label);
    }

    if (problems.length === 0) {
      console.log(`  ok   ${label}`);
      continue;
    }
    failedCount += 1;
    console.log(`  FAIL ${label}`);
    for (const problem of problems) console.log(`         ${problem}`);
  }

  console.log('');
  console.log(
    `${checkers.length - failedCount}/${checkers.length} checkers are deterministic`,
  );
  console.log(
    `${checkers.length - zeroFindingsCount}/${checkers.length} checkers produced real findings on at least one run`,
  );
  if (zeroFindingsNames.length > 0) {
    console.log(
      `Exercised with zero findings only: ${zeroFindingsNames.join(', ')}`,
    );
  }

  if (failedCount > 0) {
    process.exit(1);
  }
}

main();
