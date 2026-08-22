import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

import type { Ctx } from '../../detect.js';
import type { CheckResult, Finding } from '@houserules/api';

const SCRIPTS_DIR = join('.claude', 'scripts');

const STATIC_FORMS = [
  /^import[\s\S]*?from\s+['"]([^'"]+)['"]/gm,
  /^import\s+['"]([^'"]+)['"]/gm,
  /^export[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm,
];
const DYNAMIC_FORM = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

export interface ScriptImport {
  specifier: string;
  dynamic: boolean;
}

/**
 * Every module specifier a script mentions. A specifier imported both statically and
 * dynamically counts as static, the harder requirement.
 */
export function importSpecifiersIn(text: string): ScriptImport[] {
  const dynamicBySpecifier = new Map<string, boolean>();
  for (const form of STATIC_FORMS)
    for (const match of text.matchAll(form))
      if (match[1] !== undefined) dynamicBySpecifier.set(match[1], false);
  for (const match of text.matchAll(DYNAMIC_FORM))
    if (match[1] !== undefined && !dynamicBySpecifier.has(match[1]))
      dynamicBySpecifier.set(match[1], true);
  return [...dynamicBySpecifier].map(([specifier, dynamic]) => ({
    specifier,
    dynamic,
  }));
}

// Physical resolution first, then the root package.json declaration, because a fresh
// clone before its install has no node_modules and that is not a broken payload.
function bareSpecifierResolves(
  root: string,
  scriptPath: string,
  specifier: string,
): boolean {
  try {
    createRequire(scriptPath).resolve(specifier);
    return true;
  } catch {
    // Not physically present. A declaration still counts, checked below.
  }
  const packageName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : (specifier.split('/')[0] ?? specifier);
  try {
    const pkg = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(
      pkg.dependencies?.[packageName] ?? pkg.devDependencies?.[packageName],
    );
  } catch {
    return false;
  }
}

/**
 * Whether every installed script's imports resolve on disk.
 *
 * The hook wrapper guards only the ENTRY file's existence, so a script whose `./lib/`
 * import is missing passes the guard and then crashes at import time on every fire,
 * visibly only in transcripts. A partial install is exactly the state nothing else
 * checks: the build's dependency test sees the payload before install, and the
 * execution test runs scripts only with their libs present.
 *
 * A bare specifier is judged by whether it can actually resolve HERE, not by rule.
 * The sanctioned shape (rename.mjs driving the host's own `typescript`) resolves from
 * the host repo, so it passes.
 *
 * A DYNAMIC import is a hard requirement only when the manifest tracks its target: an
 * optional feature's lib is deliberately absent when its option is off (design.mjs's
 * tailwind bridge), and a dynamic bare import probing for a host package is the same
 * pattern one level up. Neither is a broken install, and flagging them would leave
 * doctor permanently red on a working configuration.
 */
export function checkScriptImports(root: string, ctx: Ctx): CheckResult {
  const manifestFiles = ctx.claude.manifest?.files ?? {};
  const scriptsRoot = join(root, SCRIPTS_DIR);
  let entries: string[];
  try {
    entries = readdirSync(scriptsRoot, { recursive: true }) as string[];
  } catch {
    return { findings: [], readouts: [] };
  }

  const findings: Finding[] = [];
  let scripts = 0;
  let imports = 0;
  for (const entry of entries.filter((name) => name.endsWith('.mjs')).sort()) {
    const abs = join(scriptsRoot, entry);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    scripts += 1;
    const rel = relative(root, abs);
    for (const { specifier, dynamic } of importSpecifiersIn(text)) {
      imports += 1;
      if (specifier.startsWith('node:')) continue;
      if (builtinModules.includes(specifier)) continue;
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const target = resolve(dirname(abs), specifier);
        if (existsSync(target)) continue;
        const tracked =
          relative(root, target).replaceAll('\\', '/') in manifestFiles;
        if (dynamic && !tracked) continue;
        findings.push({
          level: 'ERROR',
          msg: dynamic
            ? `${rel}: imports ${specifier} at runtime, a file the manifest tracks but which is missing on disk, so the code path that reaches it crashes. Run: npx houserules update`
            : `${rel}: imports ${specifier}, which does not resolve. The hook wrapper guards only the entry file, so this script crashes at import time on every hook fire. Run: npx houserules update`,
        });
      } else if (!dynamic && !bareSpecifierResolves(root, abs, specifier)) {
        findings.push({
          level: 'ERROR',
          msg: `${rel}: imports ${specifier}, a bare specifier that resolves neither from the script's location nor from the repo's package.json. The copied payload runs on bare node and may use only node builtins, files shipped beside it, or packages the host repo provides.`,
        });
      }
    }
  }

  return {
    findings,
    readouts: [
      `script imports: ${imports} import(s) across ${scripts} script(s) resolved`,
    ],
  };
}
