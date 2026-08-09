import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

import { satisfies, validRange } from 'semver';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { Answers, ModuleDef } from './module-def.js';
import {
  createPayloadBuilders,
  deriveLibActions,
} from './modules/copy-actions.js';
import { KIT_ROOT } from './paths.js';
import { readPayloadImports, type PayloadImports } from './payload-imports.js';
import type { Ctx } from './detect.js';
import type { Plugin, PluginApi } from './plugin.js';
import {
  namespacedId,
  PluginResolutionError,
  type BuildRegistry,
  type PluginSource,
  type RegisteredModule,
} from './plugin-registry.js';

interface PluginPackageJson {
  version?: string;
  peerDependencies?: Record<string, string>;
}

function fail(pluginName: string, message: string, cause?: unknown): never {
  const error = new PluginResolutionError(pluginName, message);
  if (cause !== undefined) error.cause = cause;
  throw error;
}

function isPathSpecifier(root: string, name: string): boolean {
  if (name.startsWith('./') || name.startsWith('../') || isAbsolute(name))
    return true;
  const candidate = join(root, name);
  return existsSync(candidate) && statSync(candidate).isDirectory();
}

/** Resolves a config `name` to the plugin's package directory, local or npm. */
function resolvePluginDir(root: string, name: string): string {
  if (isPathSpecifier(root, name)) {
    const dir = resolve(root, name);
    if (!existsSync(dir)) {
      fail(name, `path "${name}" does not exist under ${root}.`);
    }
    if (!statSync(dir).isDirectory()) {
      fail(
        name,
        `path "${name}" resolves to a file, not a directory holding a package.json.`,
      );
    }
    if (!existsSync(join(dir, 'package.json'))) {
      fail(name, `"${name}" resolves to ${dir}, which has no package.json.`);
    }
    return dir;
  }

  const requireFromRoot = createRequire(join(root, 'package.json'));
  try {
    return dirname(requireFromRoot.resolve(join(name, 'package.json')));
  } catch (error) {
    fail(
      name,
      `could not resolve npm package "${name}" from ${root}. Install it in the target repo, e.g. \`npm install ${name}\`.`,
      error,
    );
  }
}

function readPluginPackageJson(
  dir: string,
  pluginName: string,
): PluginPackageJson {
  const path = join(dir, 'package.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    fail(pluginName, `could not read package.json at ${path}.`, error);
  }
  try {
    return JSON.parse(raw) as PluginPackageJson;
  } catch (error) {
    fail(pluginName, `package.json at ${path} is not valid JSON.`, error);
  }
}

function loadEntryPoint(dir: string, pluginName: string): unknown {
  const requireFromPkg = createRequire(join(dir, 'package.json'));
  let entryPath: string;
  try {
    entryPath = requireFromPkg.resolve(dir);
  } catch (error) {
    fail(
      pluginName,
      `package.json in ${dir} has no loadable entry point (checked "main" and "exports"). Add one, e.g. "main": "index.js".`,
      error,
    );
  }
  try {
    return requireFromPkg(entryPath);
  } catch (error) {
    // Loading is synchronous because buildPlan is, so an ESM entry needs require(esm),
    // which node gained in 22.12. The package floor is >=22, so this is reachable on a
    // supported runtime and the raw ERR_REQUIRE_ESM would not say why.
    if ((error as NodeJS.ErrnoException).code === 'ERR_REQUIRE_ESM') {
      fail(
        pluginName,
        `entry point ${entryPath} is ESM and this node (${process.version}) cannot require it. Upgrade to node 22.12 or later, or have the plugin ship a CommonJS entry.`,
        error,
      );
    }
    fail(
      pluginName,
      `failed while loading entry point ${entryPath}: ${(error as Error).message}`,
      error,
    );
  }
}

function extractPluginFn(mod: unknown, pluginName: string): Plugin {
  const candidate =
    typeof mod === 'function'
      ? mod
      : mod !== null && typeof mod === 'object' && 'default' in mod
        ? (mod as { default: unknown }).default
        : undefined;
  if (typeof candidate !== 'function') {
    fail(
      pluginName,
      'entry point has no default export function. Use `export default definePlugin(...)` or `module.exports = definePlugin(...)`.',
    );
  }
  return candidate as Plugin;
}

function invokePlugin(
  plugin: Plugin,
  api: PluginApi,
  pluginName: string,
): ModuleDef[] {
  try {
    return plugin(api);
  } catch (error) {
    fail(
      pluginName,
      `factory threw while building its modules: ${(error as Error).message}`,
      error,
    );
  }
}

/**
 * Whether the plugin's declared peer range admits the running CLI.
 *
 * Delegated to `semver` rather than compared by hand. Range semantics are not the intuitive
 * ones: for a `0.x` package `^0.1.0` means `>=0.1.0 <0.2.0`, so the MINOR is the breaking
 * axis, and a major-only comparison silently accepts a plugin built against an incompatible
 * CLI. That is the whole class of bug this function exists to catch.
 *
 * An unparseable range is a malformed manifest, not a pass. It fails with the range quoted.
 */
function checkPeerRange(
  pluginName: string,
  range: string,
  cliVersion: string,
): void {
  // pnpm rewrites a `workspace:` range to a real version at publish time, so one can only be
  // seen in a source tree where the plugin and the CLI are the same checkout. There is nothing
  // to verify against: they are the same build.
  if (range.startsWith('workspace:')) return;
  if (!validRange(range)) {
    fail(
      pluginName,
      `declares an unparseable peerDependencies["@agent-kit/cli"] range "${range}". Use a valid semver range, such as "^${cliVersion}".`,
    );
  }
  // Prereleases satisfy a range only when it names one, so a CLI on 1.0.0-rc.1 would fail a
  // plain ^1.0.0. A plugin author cannot do anything about the CLI's own prerelease, so the
  // range is judged against the release line instead.
  if (!satisfies(cliVersion, range, { includePrerelease: true })) {
    fail(
      pluginName,
      `requires @agent-kit/cli "${range}" but the running CLI is ${cliVersion}. Update the plugin, or pin a compatible @agent-kit/cli version.`,
    );
  }
}

/**
 * Wraps `def.plan` so every planned copy of one of its payload files also plans a copy of the
 * CLI libs that file imports, resolved from the CLI's own payload rather than the plugin's.
 * A plugin declares nothing extra for this and cannot forget it.
 *
 * A no-op when `sidecar` is empty, which is the compatibility path for a plugin published
 * before this mechanism existed.
 */
function withDerivedLibActions(
  def: ModuleDef,
  sidecar: PayloadImports,
): ModuleDef {
  if (Object.keys(sidecar.libs).length === 0) return def;
  return {
    ...def,
    plan(ctx: Ctx, answers: Answers) {
      const actions = def.plan(ctx, answers);
      return [...actions, ...deriveLibActions(actions, sidecar)];
    },
  };
}

function readCliVersion(): string {
  const raw = readFileSync(join(KIT_ROOT, 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

/** {@inheritDoc BuildRegistry} */
export const buildRegistry: BuildRegistry = (root, config, builtIns) => {
  const modules: RegisteredModule[] = builtIns.map((def) => ({
    id: def.id,
    def,
    source: null,
  }));
  const ids = new Set(modules.map((registered) => registered.id));
  const plugins: PluginSource[] = [];
  const seenAliases = new Set<string>();
  const cliVersion = readCliVersion();

  for (const entry of config?.plugins ?? []) {
    if (seenAliases.has(entry.alias)) {
      fail(
        entry.name,
        `alias "${entry.alias}" is already used by another plugin. Give each plugin a unique alias in .claude/kit.config.json.`,
      );
    }
    seenAliases.add(entry.alias);

    const dir = resolvePluginDir(root, entry.name);
    const pkg = readPluginPackageJson(dir, entry.name);

    const peerRange = pkg.peerDependencies?.['@agent-kit/cli'];
    if (peerRange !== undefined)
      checkPeerRange(entry.name, peerRange, cliVersion);

    const source: PluginSource = {
      name: entry.name,
      alias: entry.alias,
      version: pkg.version ?? 'unknown',
      dir,
    };
    plugins.push(source);

    const pluginPayloadRoot = join(dir, 'payload-dist');
    const mod = loadEntryPoint(dir, entry.name);
    const plugin = extractPluginFn(mod, entry.name);
    const api: PluginApi = {
      payload: createPayloadBuilders(pluginPayloadRoot),
      packageName: entry.name,
      alias: entry.alias,
      config: entry.config,
    };
    const defs = invokePlugin(plugin, api, entry.name);
    const sidecar = readPayloadImports(pluginPayloadRoot);

    for (const def of defs) {
      const id = namespacedId(entry.alias, def.id);
      if (ids.has(id)) {
        fail(
          entry.name,
          `contributes module id "${id}", which is already used by a built-in module or another plugin.`,
        );
      }
      ids.add(id);
      modules.push({ id, def: withDerivedLibActions(def, sidecar), source });
    }
  }

  return {
    modules,
    plugins,
    get(id: string) {
      return modules.find((registered) => registered.id === id);
    },
  };
};
