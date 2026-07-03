// Read-only repo profiling (claude-kit CLI). Produces the `ctx` every module's
// defaultEnabled()/plan() decides from. NOTHING in this file may write.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  listWorkspacePackages,
  readJson,
} from '../payload/scripts/lib/workspaces.mjs';

// Fix-script detection priority. A unified `fix` script wins (repos like wireit
// monorepos wire lint:fix+format:fix underneath it — running the parts as well
// would duplicate work). `format` alone is deliberately NOT considered: in the
// wild it is as often a check as a write.
const FIX_PRIORITY = [
  ['fix'],
  ['lint:fix', 'format:fix'],
  ['lint:fix'],
  ['format:fix'],
];

export function detectFixCommands(scripts = {}) {
  for (const combo of FIX_PRIORITY) {
    if (combo.every((s) => typeof scripts[s] === 'string')) return combo;
  }
  return null;
}

export function suggestPrefix(name) {
  const short = name.includes('/') ? name.split('/').pop() : name;
  const cleaned = short.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefix = cleaned.replace(/^[0-9]+/, '').slice(0, 12);
  return prefix || 'PKG';
}

function titleCase(s) {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function shortName(pkgName, dir) {
  const short = pkgName?.includes('/') ? pkgName.split('/').pop() : pkgName;
  return (short || basename(dir)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function git(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function detectPackageManager(root, rootPkg) {
  const pmField = rootPkg?.packageManager;
  if (typeof pmField === 'string' && pmField.includes('@')) {
    const at = pmField.lastIndexOf('@');
    return {
      name: pmField.slice(0, at),
      version: pmField.slice(at + 1),
      source: 'packageManager',
    };
  }
  if (existsSync(join(root, 'pnpm-lock.yaml')))
    return { name: 'pnpm', source: 'lockfile' };
  if (existsSync(join(root, 'yarn.lock')))
    return { name: 'yarn', source: 'lockfile' };
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb')))
    return { name: 'bun', source: 'lockfile' };
  if (existsSync(join(root, 'package-lock.json')))
    return { name: 'npm', source: 'lockfile' };
  return rootPkg ? { name: 'npm', source: 'default' } : null;
}

function hasDep(pkg, name) {
  return Boolean(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]);
}

function detectChangesets(root, rootPkg) {
  const configPath = join(root, '.changeset', 'config.json');
  const configExists = existsSync(configPath);
  const config = configExists ? readJson(configPath) : null;
  let pendingCount = 0;
  if (existsSync(join(root, '.changeset'))) {
    try {
      pendingCount = readdirSync(join(root, '.changeset')).filter(
        (f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md',
      ).length;
    } catch {
      /* unreadable — treat as none */
    }
  }
  const devDep = hasDep(rootPkg, '@changesets/cli');
  const scriptEntry = Object.entries(rootPkg?.scripts ?? {}).find(([, cmd]) =>
    /(^|[\s/])(changeset|@changesets\/cli)\b/.test(cmd),
  );
  const invocation = devDep
    ? 'devdep'
    : scriptEntry
      ? 'root-script'
      : configExists
        ? 'external-cli'
        : 'absent';
  return {
    configExists,
    config,
    pendingCount,
    devDep,
    rootScript: scriptEntry ? scriptEntry[0] : null,
    invocation,
    baseBranch: config?.baseBranch ?? 'main',
  };
}

function detectTypescript(root, rootPkg, packages) {
  if (hasDep(rootPkg, 'typescript')) return true;
  if (existsSync(join(root, 'tsconfig.json'))) return true;
  return packages.some(
    (p) =>
      hasDep(p.pkg, 'typescript') || existsSync(join(p.dir, 'tsconfig.json')),
  );
}

function buildTargets(root, rootPkg, packages) {
  if (packages.length) {
    return packages.map((p) => {
      const name = shortName(p.name, p.dir);
      return {
        name,
        prefix: suggestPrefix(p.name),
        packageName: p.name,
        pathPrefix: `${p.relDir}/`,
        sourcePath: existsSync(join(p.dir, 'src'))
          ? `${p.relDir}/src`
          : p.relDir,
        label: titleCase(name),
        fixCommands: detectFixCommands(p.pkg.scripts),
      };
    });
  }
  if (rootPkg) {
    const name = shortName(rootPkg.name, root);
    return [
      {
        name,
        prefix: suggestPrefix(rootPkg.name ?? basename(root)),
        packageName: rootPkg.name ?? '.',
        pathPrefix: '',
        sourcePath: existsSync(join(root, 'src')) ? 'src' : '',
        label: titleCase(name),
        fixCommands: detectFixCommands(rootPkg.scripts),
      },
    ];
  }
  return [];
}

function detectClaudeState(root) {
  const dir = join(root, '.claude');
  const settingsPath = join(dir, 'settings.json');
  let settings = null;
  let settingsParseError = null;
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      settingsParseError = e.message;
    }
  }
  const listNames = (sub) => {
    try {
      return readdirSync(join(dir, sub)).filter((f) => !f.startsWith('.'));
    } catch {
      return [];
    }
  };
  return {
    dirExists: existsSync(dir),
    settingsExists: existsSync(settingsPath),
    settings,
    settingsParseError,
    settingsLocalExists: existsSync(join(dir, 'settings.local.json')),
    claudeMdExists: existsSync(join(root, 'CLAUDE.md')),
    manifest: readJson(join(dir, 'kit-manifest.json')),
    kitConfig: readJson(join(dir, 'kit.config.json')),
    agents: listNames('agents'),
    skills: listNames('skills'),
  };
}

function detectPnpmCatalogModeStrict(root) {
  try {
    return /^catalogMode:\s*strict\b/m.test(
      readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'),
    );
  } catch {
    return false;
  }
}

export function detect(root) {
  const gitTop = git(root, ['rev-parse', '--show-toplevel']);
  const rootPkg = readJson(join(root, 'package.json'));
  const packages = listWorkspacePackages(root);
  const changesets = detectChangesets(root, rootPkg);

  return {
    root,
    git: {
      isRepo: Boolean(gitTop),
      top: gitTop,
      hasCommits: git(root, ['rev-parse', '--verify', 'HEAD']) !== null,
      branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    },
    packageManager: detectPackageManager(root, rootPkg),
    rootPkg,
    isMonorepo: packages.length > 0,
    packages,
    targets: buildTargets(root, rootPkg, packages),
    typescript: detectTypescript(root, rootPkg, packages),
    changesets,
    pnpmCatalogModeStrict: detectPnpmCatalogModeStrict(root),
    claude: detectClaudeState(root),
  };
}
