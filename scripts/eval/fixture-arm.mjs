import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { git, sha256 } from './assemble.mjs';
import { NO_VALIDITY_AGENT, judgeValidity } from './orchestrate-report.mjs';
import { sessionDirName } from './layout.mjs';

const EVAL_JSON = 'eval.json';
const REPO_DIR = 'repo';
const CLAUDE_DIR = '.claude';
const CONFIG_FILE = join(CLAUDE_DIR, 'houserules.config.json');
const MANIFEST_FILE = join(CLAUDE_DIR, 'houserules.manifest.json');
/** The directory under a session's artifacts that `collect` paths are copied into. */
const TREE = 'tree';
const ARM_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** Names a session directory directly under `--out` already takes, so no arm may use them. */
const RESERVED_ARM_NAME = /^(sample-\d+|probe-[ab]|no-slug)$/;
/**
 * The module `init` seeds a config with before plugins are added. Every install has it, so the
 * seeding pass adds nothing the fixture's own module list would not.
 */
const SEED_MODULE = 'core';
/** The built `cli.js` sits in `packages/cli/dist/`, three directories below its repo root. */
const CLI_DIR_DEPTH = 3;

/**
 * One fixture arm, read from `<fixture>/eval.json`, with every path resolved and the prompt read.
 *
 * @typedef {object} ArmFixture
 * @property {string} dir The fixture directory, absolute.
 * @property {string} arm
 * @property {string} modules The `init --yes --modules` list, plugin modules as `<alias>/<id>`.
 * @property {Array<{ path: string, alias: string }>} plugins `path` relative to the built root.
 * @property {string} model The child's `--model`: the arm's `model` when set, else the fixture's.
 * @property {string | null} validityAgent The subagent type a valid sample's `by_type` must count,
 *   or null to skip that test.
 * @property {'auto' | 'default'} permissionMode The child's `--permission-mode`, from `eval.json`.
 * @property {Record<string, unknown> | undefined} settings The arm's settings object, with
 *   `{{fixtureDir}}` replaced, merged into the child's `--settings`.
 * @property {string[]} collect Paths relative to the sample root, copied into `tree/` on exit.
 * @property {string} prompt The arm's prompt file, verbatim, which becomes the `-p` text.
 * @property {string} overlayDir The arm's overlay directory, absolute.
 * @property {boolean} isNetworkAllowed Whether the child's tools may reach the network, from `eval.json`.
 */

/**
 * @param {string} path
 * @returns {unknown}
 */
function readJsonFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`--fixture has no ${path}`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON`, { cause: error });
  }
}

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} spec
 * @param {string} field
 * @param {string} where
 * @returns {string}
 */
function requireString(spec, field, where) {
  const value = spec[field];
  if (typeof value === 'string' && value !== '') return value;
  throw new Error(`${where} needs a non-empty string "${field}"`);
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isInsideRelative(path) {
  return (
    !isAbsolute(path) && !path.split(/[\\/]+/).some((part) => part === '..')
  );
}

/** Where a fixture the Actions workflow runs must live, relative to the repo root. */
const COMMITTED_FIXTURES = join('scripts', 'eval', 'fixtures');

/**
 * Refuses a fixture directory outside `scripts/eval/fixtures` under `repoRoot`, since a runner
 * sees only committed files.
 *
 * @param {string} fixtureDir
 * @param {string} repoRoot
 * @throws {Error} Naming the path, when it resolves outside the committed fixtures.
 */
export function requireCommittedFixture(fixtureDir, repoRoot) {
  const fixtures = resolve(repoRoot, COMMITTED_FIXTURES);
  const fromFixtures = relative(fixtures, resolve(repoRoot, fixtureDir));
  if (fromFixtures === '' || !isInsideRelative(fromFixtures)) {
    throw new Error(
      `fixture ${fixtureDir} is not a directory under ${COMMITTED_FIXTURES}`,
    );
  }
}

/**
 * @param {unknown} plugins
 * @param {string} where
 * @returns {Array<{ path: string, alias: string }>}
 */
function readPlugins(plugins, where) {
  if (!Array.isArray(plugins))
    throw new Error(`${where} needs a "plugins" array`);
  return plugins.map((entry, index) => {
    if (!isRecord(entry))
      throw new Error(`${where} plugins[${index}] is not an object`);
    return {
      path: requireString(entry, 'path', `${where} plugins[${index}]`),
      alias: requireString(entry, 'alias', `${where} plugins[${index}]`),
    };
  });
}

/**
 * @param {unknown} collect
 * @param {string} where
 * @returns {string[]}
 */
function readCollect(collect, where) {
  if (!Array.isArray(collect))
    throw new Error(`${where} needs a "collect" array`);
  return collect.map((path, index) => {
    if (typeof path !== 'string' || path === '' || !isInsideRelative(path)) {
      throw new Error(
        `${where} collect[${index}] must be a path relative to the sample root, got ${JSON.stringify(path)}`,
      );
    }
    return path;
  });
}

/**
 * @param {string} path
 * @param {'file' | 'directory'} kind
 */
function requireEntry(path, kind) {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    throw new Error(`--fixture is missing ${path}`, { cause: error });
  }
  const isKind = kind === 'file' ? stat.isFile() : stat.isDirectory();
  if (!isKind) throw new Error(`--fixture ${path} is not a ${kind}`);
}

const FIXTURE_DIR_TOKEN = '{{fixtureDir}}';
const PERMISSION_MODES = ['auto', 'default'];

/**
 * @param {unknown} value
 * @param {string} dir
 * @returns {unknown} `value` with the token replaced in every string, however deep.
 */
function substituteFixtureDir(value, dir) {
  if (typeof value === 'string')
    return value.replaceAll(FIXTURE_DIR_TOKEN, dir);
  if (Array.isArray(value))
    return value.map((item) => substituteFixtureDir(item, dir));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        substituteFixtureDir(item, dir),
      ]),
    );
  }
  return value;
}

/**
 * @param {string} dir
 * @param {Record<string, unknown>} arm
 * @param {string} armWhere
 * @param {boolean} isNetworkAllowed
 * @returns {Record<string, unknown> | undefined}
 */
function readArmSettings(dir, arm, armWhere, isNetworkAllowed) {
  if (arm.settings === undefined) return undefined;
  const relativePath = requireString(arm, 'settings', armWhere);
  if (!isInsideRelative(relativePath)) {
    throw new Error(
      `${armWhere} settings must be a path inside the fixture, got ${JSON.stringify(relativePath)}`,
    );
  }
  const parsed = readJsonFile(join(dir, relativePath));
  if (!isRecord(parsed)) {
    throw new Error(
      `${armWhere} settings ${relativePath} is not a JSON object`,
    );
  }
  if (!isNetworkAllowed && 'sandbox' in parsed) {
    throw new Error(
      `${armWhere} settings ${relativePath} sets "sandbox", which a network-false fixture owns`,
    );
  }
  return substituteFixtureDir(parsed, dir);
}

/**
 * The fixture's `permissionMode`, `auto` when absent. Throws on any other value.
 *
 * @param {Record<string, unknown>} spec
 * @param {string} where
 * @returns {string}
 */
function readPermissionMode(spec, where) {
  if (spec.permissionMode === undefined) return 'auto';
  if (!PERMISSION_MODES.includes(spec.permissionMode)) {
    throw new Error(`${where} "permissionMode" must be "auto" or "default"`);
  }
  return spec.permissionMode;
}

/**
 * Reads `<fixtureDir>/eval.json` and picks `arms.<armName>`. Throws, naming the field or path,
 * on a missing file, a malformed field, an unknown arm, or a prompt or overlay that is absent.
 *
 * @param {string} fixtureDir
 * @param {string} armName
 * @returns {ArmFixture}
 */
export function loadArmFixture(fixtureDir, armName) {
  const dir = resolve(fixtureDir);
  const where = join(dir, EVAL_JSON);
  const spec = readJsonFile(where);
  if (!isRecord(spec)) throw new Error(`${where} is not a JSON object`);
  if (!isRecord(spec.arms)) throw new Error(`${where} needs an "arms" object`);
  const arm = spec.arms[armName];
  if (!isRecord(arm)) {
    throw new Error(
      `--arm "${armName}" is not in ${where}, whose arms are ${Object.keys(spec.arms).join(', ')}`,
    );
  }
  if (!ARM_NAME.test(armName) || RESERVED_ARM_NAME.test(armName)) {
    throw new Error(
      `--arm "${armName}" must be lowercase letters, digits, and dashes, and not a session directory name`,
    );
  }
  const armWhere = `${where} arms.${armName}`;
  const promptPath = join(dir, requireString(arm, 'prompt', armWhere));
  const overlayDir = join(dir, requireString(arm, 'overlay', armWhere));
  if (arm.model !== undefined) requireString(arm, 'model', armWhere);
  if (spec.network !== undefined && typeof spec.network !== 'boolean') {
    throw new Error(`${where} "network" must be a boolean`);
  }
  const permissionMode = readPermissionMode(spec, where);
  const isNetworkAllowed = spec.network === true;
  const settings = readArmSettings(dir, arm, armWhere, isNetworkAllowed);
  requireEntry(join(dir, REPO_DIR), 'directory');
  requireEntry(promptPath, 'file');
  requireEntry(overlayDir, 'directory');
  return {
    dir,
    arm: armName,
    modules: requireString(spec, 'modules', where),
    plugins: readPlugins(spec.plugins, where),
    model: arm.model ?? requireString(spec, 'model', where),
    validityAgent:
      spec.validityAgent === null
        ? null
        : requireString(spec, 'validityAgent', where),
    permissionMode,
    settings,
    collect: readCollect(spec.collect, where),
    prompt: readFileSync(promptPath, 'utf8'),
    overlayDir,
    isNetworkAllowed,
  };
}

/**
 * The repo root a built `cli.js` sits in, which a fixture's `plugins` paths are relative to.
 * That is the `--rev` build's root, or the checkout `HOUSERULES_EVAL_CLI` points into.
 *
 * @param {string} cliPath
 * @returns {string}
 */
function pluginRootOf(cliPath) {
  return resolve(
    dirname(cliPath),
    ...Array.from({ length: CLI_DIR_DEPTH }, () => '..'),
  );
}

/**
 * @param {string} root
 * @param {string} cliPath
 * @param {string} modules
 */
function runInit(root, cliPath, modules) {
  const install = spawnSync(
    process.execPath,
    [cliPath, 'init', '--yes', '--modules', modules],
    { cwd: root, encoding: 'utf8' },
  );
  if (install.status !== 0) {
    throw new Error(
      `init --modules ${modules} exited ${install.status}: ${install.stderr || install.stdout}`,
    );
  }
}

/**
 * Installs the fixture's modules. With plugins, a first `init` seeds the config with the
 * targets it detects, the runner adds the `plugins` entries by absolute path into the built
 * root, and a second `init` installs the full module list, since `init` refuses a plugin module
 * whose plugin no config names.
 *
 * @param {string} root
 * @param {string} cliPath
 * @param {ArmFixture} fixture
 */
function installFixtureModules(root, cliPath, fixture) {
  if (fixture.plugins.length === 0) {
    runInit(root, cliPath, fixture.modules);
    return;
  }
  runInit(root, cliPath, SEED_MODULE);
  const configPath = join(root, CONFIG_FILE);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const pluginRoot = pluginRootOf(cliPath);
  config.plugins = fixture.plugins.map(({ path, alias }) => ({
    name: resolve(pluginRoot, path),
    alias,
  }));
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  runInit(root, cliPath, fixture.modules);
}

/**
 * Every file under `dir`, relative to it with `/` separators, in sorted order.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'),
    )
    .sort();
}

/**
 * Copies the arm's overlay over the sample's `.claude/`. Throws before copying anything when an
 * overlay path names a file the install manifest does not track.
 *
 * @param {string} root
 * @param {string} overlayDir
 * @returns {Array<{ path: string, initSha256: string, overlaySha256: string }>}
 */
function applyOverlay(root, overlayDir) {
  const manifestPath = join(root, MANIFEST_FILE);
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : {};
  const installed = new Set(Object.keys(manifest?.files ?? {}));
  const files = listFiles(overlayDir);
  const refused = files.filter(
    (path) => !installed.has(`${CLAUDE_DIR}/${path}`),
  );
  if (refused.length > 0) {
    throw new Error(
      `overlay ${overlayDir} names ${refused.join(', ')}, which init did not install under .claude/`,
    );
  }
  return files.map((path) => {
    const source = join(overlayDir, path);
    const dest = join(root, CLAUDE_DIR, path);
    const initSha256 = sha256(dest);
    cpSync(source, dest);
    return { path, initSha256, overlaySha256: sha256(source) };
  });
}

/**
 * Assembles one arm sample at `<work>/<stamp>/<arm>/sample-<k>/`: copies `repo/`, commits it,
 * installs the fixture's modules, copies the arm's overlay over `.claude/`, then commits the
 * install.
 *
 * @param {{ fixture: ArmFixture, cliPath: string, work: string, stamp: string, sample: number }} options
 * @returns {{ root: string, overlays: Array<{ path: string, initSha256: string, overlaySha256: string }> }}
 */
export function assembleArmSample(options) {
  const { fixture, cliPath, work, stamp, sample } = options;
  const root = join(work, stamp, fixture.arm, sessionDirName({ sample }));
  mkdirSync(root, { recursive: true });
  cpSync(join(fixture.dir, REPO_DIR), root, { recursive: true });

  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);

  installFixtureModules(root, cliPath, fixture);
  const overlays = applyOverlay(root, fixture.overlayDir);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', 'install houserules']);
  return { root, overlays };
}

/**
 * Adds each overlaid file's sha256 at session exit, or null when the session deleted it.
 *
 * @param {string} root
 * @param {Array<{ path: string, initSha256: string, overlaySha256: string }>} overlays
 * @returns {import('./layout.mjs').OverlayRecord[]}
 */
export function exitOverlayHashes(root, overlays) {
  return overlays.map((overlay) => {
    const path = join(root, CLAUDE_DIR, overlay.path);
    return { ...overlay, exitSha256: existsSync(path) ? sha256(path) : null };
  });
}

/**
 * Copies each `collect` path that exists in the sample root into `<outDir>/tree/<path>`.
 *
 * @param {string} root
 * @param {string[]} collect
 * @param {string} outDir
 * @returns {string[]} The paths copied.
 */
export function copyCollect(root, collect, outDir) {
  const copied = collect.filter((path) => existsSync(join(root, path)));
  for (const path of copied) {
    const dest = join(outDir, TREE, path);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(root, path), dest, { recursive: true });
  }
  return copied;
}

/**
 * An arm sample is valid when the dispatcher's result is a success that spawned the fixture's
 * `validityAgent`, and every overlaid file still holds the overlay's bytes at exit.
 *
 * @param {import('./orchestrate-report.mjs').SampleArtifacts} sample
 * @param {string | null} validityAgent Null skips the agent test.
 * @returns {{ valid: boolean, line: string }}
 */
export function judgeArmValidity(sample, validityAgent) {
  const judged = judgeValidity(sample, validityAgent ?? NO_VALIDITY_AGENT);
  if (!judged.valid) return judged;
  const overlays = sample.run?.overlays;
  if (!Array.isArray(overlays)) {
    return { valid: false, line: `${sample.label}: void, no overlays record` };
  }
  const rewritten = overlays
    .filter((overlay) => overlay.exitSha256 !== overlay.overlaySha256)
    .map((overlay) => overlay.path);
  if (rewritten.length > 0) {
    return {
      valid: false,
      line: `${sample.label}: void, overlay rewritten: ${rewritten.join(', ')}`,
    };
  }
  return judged;
}
