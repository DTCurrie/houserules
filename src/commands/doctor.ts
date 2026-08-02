import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { detect, trackedScriptFiles, trackedTemplateFiles } from '../detect.js';
import { verifyDefaultsFor } from '../render.js';
import { MANIFEST_PATH } from '../apply.js';
import { payloadPath } from '../paths.js';
import {
  listWorkspacePackages,
  readJson,
} from '../../payload-dist/scripts/lib/workspaces.mjs';
import { validateKitConfig } from '../core/config.js';
import {
  computeDrift,
  driftedFiles,
  FIXABLE,
  type DriftReport,
  type FileDrift,
} from '../core/drift.js';
import { TargetRepo } from '../core/fs-target.js';
import { MODULES, buildPlan, computeEffects, computePrune } from '../plan.js';
import { apply } from '../apply.js';
import { EXIT } from '../types.js';
import type { KitManifest } from '../types.js';
import type { Flags, Settings } from '../types.js';
import * as log from './log.js';

// module id → hook script that must appear in a settings.json hook command.
const HOOK_SCRIPTS: Record<string, string[]> = {
  core: ['guard-bash.mjs'],
  'lint-fix': ['lint-format-fix.mjs'],
  changesets: ['changeset-check.mjs'],
  'session-context': ['session-context.mjs'],
  'debug-session': ['debug-session-check.mjs'],
  'read-guard': ['guard-read.mjs'],
  regen: ['regen-on-edit.mjs'],
  backlog: ['backlog-inject.mjs'],
};

// The always-loaded surface is paid on every turn (CONVENTIONS §1). ~3-4K tokens
// is the sane target. Take the upper end as the ceiling and ~200 lines alongside.
const RESIDENT_TOKEN_BUDGET = 4000;
const RESIDENT_LINE_BUDGET = 200;

const estimateTokens = (chars: number) => Math.ceil(chars / 4); // dumb-simple; no tokenizer dep.
const countLines = (t: string) =>
  t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0);

// `@` only at line start or after whitespace, so `foo@bar` emails never match. The
// caller keeps only the specifiers that resolve to a real file on disk.
export function parseImports(text: string): string[] {
  const specs: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) specs.push(m[1]);
  return specs;
}

// In Claude Code's load order. `.claude/CLAUDE.md` and `CLAUDE.local.md` are as resident
// as the root one, so measuring only the root under-reports the budget.
const RESIDENT_MEMORY_FILES = [
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  'CLAUDE.local.md',
];

// A globbed rule loads only when a matching file is in the working set, so an empty
// result here means "resident every turn". A list of only `**` counts as unscoped.
export function ruleGlobs(text: string): string[] {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!fm) return [];
  const lines = fm[1].split('\n');
  const at = lines.findIndex((l) => /^paths:/.test(l));
  if (at === -1) return [];
  const inline = lines[at].slice('paths:'.length).trim();
  const raw = inline ? inline.replace(/^\[|\]$/g, '').split(',') : [];
  if (!inline) {
    for (let i = at + 1; i < lines.length; i++) {
      const item = /^[ \t]*-[ \t]*(.+)$/.exec(lines[i]);
      if (!item) break; // next key or blank line ends the list
      raw.push(item[1]);
    }
  }
  return raw
    .map((g) =>
      g
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .replace(/\/\*\*$/, ''),
    )
    .filter((g) => g && g !== '**');
}

// Globless (= always-loaded) rule files under .claude/rules/, repo-relative.
function globlessRuleFiles(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(root, '.claude', 'rules')).filter((f) =>
      f.endsWith('.md'),
    );
  } catch {
    return []; // no rules dir — nothing to measure
  }
  const out: string[] = [];
  for (const name of names.sort()) {
    try {
      const text = readFileSync(join(root, '.claude', 'rules', name), 'utf8');
      if (!ruleGlobs(text).length) out.push(`.claude/rules/${name}`);
    } catch {
      /* unreadable rule file. Not the doctor's problem. */
    }
  }
  return out;
}

interface ResidentMeasurement {
  chars: number;
  lines: number;
  imports: number;
  tokens: number;
  sources: string[];
  globless: string[];
}

// The `description:` frontmatter of an installed skill/agent (single-line, quotes
// optional). Returns null when the file has none.
export function frontmatterDescription(text: string): string | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!fm) return null;
  const m = /^description:[ \t]*(.*)$/m.exec(fm[1]);
  if (!m) return null;
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

interface SkillAgentMeasurement {
  chars: number;
  tokens: number;
  skills: number;
  agents: number;
}

// Claude Code puts every `description:` in the system prompt on every turn, the same
// resident tier as CLAUDE.md. Bodies load only on invocation and are not counted.
function measureSkillAgentDescriptions(
  root: string,
): SkillAgentMeasurement | null {
  let chars = 0;
  let skills = 0;
  let agents = 0;
  try {
    for (const name of readdirSync(join(root, '.claude', 'skills'))) {
      let text: string;
      try {
        text = readFileSync(
          join(root, '.claude', 'skills', name, 'SKILL.md'),
          'utf8',
        );
      } catch {
        continue;
      }
      const desc = frontmatterDescription(text);
      if (desc) {
        chars += desc.length;
        skills += 1;
      }
    }
  } catch {
    /* no skills dir */
  }
  try {
    for (const name of readdirSync(join(root, '.claude', 'agents')).filter(
      (f) => f.endsWith('.md'),
    )) {
      let text: string;
      try {
        text = readFileSync(join(root, '.claude', 'agents', name), 'utf8');
      } catch {
        continue;
      }
      const desc = frontmatterDescription(text);
      if (desc) {
        chars += desc.length;
        agents += 1;
      }
    }
  } catch {
    /* no agents dir */
  }
  if (!skills && !agents) return null;
  return { chars, tokens: estimateTokens(chars), skills, agents };
}

// Nested package CLAUDE.mds and path-scoped rules are deliberately excluded. They are
// the on-demand tier and must never be summed into the resident total.
function measureResident(root: string): ResidentMeasurement | null {
  const globless = globlessRuleFiles(root);
  const sources = [
    ...RESIDENT_MEMORY_FILES.filter((rel) => existsSync(join(root, rel))),
    ...globless,
  ];
  if (!sources.length) return null;
  const seen = new Set<string>();
  let chars = 0;
  let lines = 0;
  let imports = 0;
  const visit = (abs: string, depth: number) => {
    if (seen.has(abs) || depth > 5) return;
    seen.add(abs);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      return;
    }
    chars += text.length;
    lines += countLines(text);
    if (depth > 0) imports += 1;
    for (const spec of parseImports(text)) {
      const target = resolve(dirname(abs), spec);
      try {
        if (statSync(target).isFile()) visit(target, depth + 1);
      } catch {
        /* unresolved specifier. Not an import. */
      }
    }
  };
  for (const rel of sources) visit(join(root, rel), 0);
  return {
    chars,
    lines,
    imports,
    tokens: estimateTokens(chars),
    sources,
    globless,
  };
}

export function allHookCommands(
  settings: Settings | null | undefined,
): string[] {
  const commands: string[] = [];
  for (const groups of Object.values(settings?.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const hook of group?.hooks ?? [])
        commands.push(String(hook.command ?? ''));
    }
  }
  return commands;
}

type Level = 'ERROR' | 'WARN';

export interface Finding {
  level: Level;
  msg: string;
}

/**
 * Drift entries that move the exit code. `yours` never does. There is no way to
 * acknowledge a deliberate edit, so counting it would leave doctor permanently red on an
 * install that is working exactly as intended.
 */
export function blockingDrift(drifted: FileDrift[]): FileDrift[] {
  return drifted.filter((file) => file.status !== 'yours' && !file.yours);
}

/**
 * The severity rollup, kept pure so the CI contract is testable without a repo on disk.
 *
 * A rejected config outranks everything, because nothing downstream can be trusted when
 * the config itself will not parse.
 */
export function doctorExitCode(args: {
  configProblems: readonly string[];
  findings: readonly Finding[];
  drifted: FileDrift[];
}): number {
  if (args.configProblems.length) return EXIT.badConfig;
  const hasError = args.findings.some((f) => f.level === 'ERROR');
  if (hasError || blockingDrift(args.drifted).length) return EXIT.error;
  return EXIT.ok;
}

/**
 * Validates an installation against reality.
 *
 * @returns Exit 1 on an ERROR (a broken install) or on actionable drift, exit 2 on a
 * config the schema rejects. Drift you caused yourself (`yours`) is reported with a diff
 * but never moves the exit code, because there is no way to acknowledge a deliberate
 * edit and it would leave doctor permanently red on an install working as intended.
 */
export async function doctor(dir: string, flags: Flags): Promise<number> {
  const root = resolve(dir);
  const ctx = detect(root);
  const findings: Finding[] = [];
  const readouts: string[] = []; // always-printed context lines, not error/warn findings.
  const report = (level: Level, msg: string) => findings.push({ level, msg });
  // Kept apart from the general findings so the exit code can distinguish "your
  // config is not valid" (2) from "your install has a problem" (1).
  const configProblems: string[] = [];

  // The resident-surface budget makes the kit's #1 lever measurable instead of only
  // prose. Read-only, and WARNs past budget rather than ERRORing.
  const resident = measureResident(root);
  const skillsAgents = measureSkillAgentDescriptions(root);
  const saTokens = skillsAgents?.tokens ?? 0;
  if (resident) {
    const over =
      resident.tokens > RESIDENT_TOKEN_BUDGET ||
      resident.lines > RESIDENT_LINE_BUDGET;
    const importNote = resident.imports
      ? ` + ${resident.imports} @-import(s)`
      : '';
    readouts.push(
      `resident context (${resident.sources.join(' + ')}${importNote}): ~${resident.tokens} tokens / ${resident.lines} lines ` +
        `vs budget ~${RESIDENT_TOKEN_BUDGET} / ${RESIDENT_LINE_BUDGET}` +
        (over
          ? ` — OVER`
          : ` — ${RESIDENT_TOKEN_BUDGET - resident.tokens} tokens, ${RESIDENT_LINE_BUDGET - resident.lines} lines headroom`),
    );
    // Either tier alone, or the two together, can push the always-loaded total over.
    const combinedTokens = resident.tokens + saTokens;
    const combinedOver =
      combinedTokens > RESIDENT_TOKEN_BUDGET ||
      resident.lines > RESIDENT_LINE_BUDGET;
    if (combinedOver) {
      const parts = [`root CLAUDE.md/rules (~${resident.tokens} tokens)`];
      if (saTokens)
        parts.push(`skill/agent descriptions (~${saTokens} tokens)`);
      report(
        'WARN',
        `always-loaded context exceeds budget (~${combinedTokens} tokens / ${resident.lines} lines vs ~${RESIDENT_TOKEN_BUDGET} / ${RESIDENT_LINE_BUDGET}) — ${parts.join(' + ')} — trim root CLAUDE.md to a one-line index + on-demand files (CONVENTIONS §1)`,
      );
    }
    // A globless rule loads every turn. Usually not intended, and invisible without
    // this line (CONVENTIONS §6).
    if (resident.globless.length)
      report(
        'WARN',
        `rule file(s) loaded on EVERY turn (no \`paths:\` frontmatter): ${resident.globless.join(', ')} — ` +
          'scope each with a `paths:` glob list so it loads only when a matching file is in play, or move it out of .claude/rules/ (CONVENTIONS §6)',
      );
    // Nested package CLAUDE.mds are the on-demand tier. List separately, never summed.
    const nested = listWorkspacePackages(root)
      .map((p) => ({
        rel: `${p.relDir}/CLAUDE.md`,
        abs: join(p.dir, 'CLAUDE.md'),
      }))
      .filter((n) => existsSync(n.abs));
    if (nested.length)
      readouts.push(
        `nested (on-demand, not in resident total): ${nested.map((n) => n.rel).join(', ')}`,
      );
  }
  // A second, distinct resident surface, reported on its own line so a budget move is
  // attributable to what caused it.
  if (skillsAgents)
    readouts.push(
      `resident skill/agent descriptions (${skillsAgents.skills} skill(s) + ${skillsAgents.agents} agent(s)): ~${skillsAgents.tokens} tokens`,
    );

  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) report('ERROR', `node ${process.versions.node} < 20`);
  if (!ctx.git.isRepo) report('ERROR', 'not a git work tree');

  const manifest = ctx.claude.manifest;
  if (!manifest) {
    report(
      'ERROR',
      `no ${MANIFEST_PATH} — kit not installed here (run: npx claude-kit init)`,
    );
  } else {
    if (manifest.kitVersion !== flags.kitVersion) {
      report(
        'WARN',
        `installed kit v${manifest.kitVersion}, this CLI is v${flags.kitVersion} — run: npx claude-kit update`,
      );
    }
    // Reference templates that got committed before the kit ignored them. File integrity
    // itself is the drift engine's job, further down.
    const strayTemplates = ctx.git.isRepo ? trackedTemplateFiles(root) : [];
    if (strayTemplates.length) {
      report(
        'WARN',
        `${strayTemplates.length} reference template(s) under .claude/kit-templates/ are committed (reference-only). Untrack, keeping them on disk: npx claude-kit update — or: git rm --cached -r .claude/kit-templates && git add .claude/kit-templates/.gitignore`,
      );
    }
    // Same story for .claude/scripts/, which is build output.
    const commitScripts = ctx.claude.kitConfig?.scripts?.commit === true;
    const strayScripts =
      ctx.git.isRepo && !commitScripts ? trackedScriptFiles(root) : [];
    if (strayScripts.length) {
      report(
        'WARN',
        `${strayScripts.length} script(s) under .claude/scripts/ are committed (build output). Untrack, keeping them on disk: npx claude-kit update — or: git rm --cached -r .claude/scripts && git add .claude/scripts/.gitignore`,
      );
    }
  }

  const config = ctx.claude.kitConfig;
  if (!config) {
    report(manifest ? 'ERROR' : 'WARN', 'no .claude/kit.config.json');
  } else {
    // Schema validation runs first: a rejected config is one the hooks are silently
    // misreading, and the field name beats the downstream symptom.
    const raw = readFileSync(join(root, '.claude', 'kit.config.json'), 'utf8');
    configProblems.push(...validateKitConfig(raw));
    for (const problem of configProblems) {
      report('ERROR', `kit.config.json: ${problem}`);
    }

    if (config.version !== 2)
      report(
        'WARN',
        `kit.config.json version ${config.version ?? 1} (current schema: 2)`,
      );
    const workspacePackages = listWorkspacePackages(root);
    const workspaceNames = new Set(workspacePackages.map((p) => p.name));
    for (const target of config.targets ?? []) {
      if (target.pathPrefix && !existsSync(join(root, target.pathPrefix))) {
        report(
          'WARN',
          `target "${target.name}": pathPrefix ${target.pathPrefix} does not exist`,
        );
      }
      if (target.sourcePath && !existsSync(join(root, target.sourcePath))) {
        report(
          'WARN',
          `target "${target.name}": sourcePath ${target.sourcePath} does not exist`,
        );
      }
      if (
        workspaceNames.size &&
        target.packageName !== '.' &&
        !workspaceNames.has(target.packageName)
      ) {
        report(
          'WARN',
          `target "${target.name}": package ${target.packageName} not found in the workspace`,
        );
      }
      const pkgDir = target.pathPrefix ? join(root, target.pathPrefix) : root;
      const scripts = readJson(join(pkgDir, 'package.json'))?.scripts ?? {};
      const fixCommands =
        target.fixCommands ??
        (config.fix?.commands as string[] | undefined) ??
        [];
      for (const cmd of fixCommands) {
        if (!scripts[cmd])
          report(
            'WARN',
            `target "${target.name}": fix script "${cmd}" not in ${target.pathPrefix || './'}package.json`,
          );
      }
      // Only a target's EXPLICIT verifyCommands, never the global `verify` fallback,
      // which sub-packages routinely lack because they rely on a root verify.
      if (manifest?.modules?.includes('verify-changed'))
        for (const cmd of target.verifyCommands ?? []) {
          if (!scripts[cmd])
            report(
              'WARN',
              `target "${target.name}": verify script "${cmd}" not in ${target.pathPrefix || './'}package.json`,
            );
        }
    }
    // A workspace member no target covers silently misses lint-fix, reviewer, and ledger
    // coverage while doctor still reports healthy.
    const targeted = new Set((config.targets ?? []).map((t) => t.packageName));
    for (const p of workspacePackages) {
      if (!targeted.has(p.name))
        report(
          'WARN',
          `workspace package "${p.name}" (${p.relDir}) has no kit target — add one to .claude/kit.config.json targets[] by hand (re-running init skips the existing config)`,
        );
    }
  }

  if (manifest && ctx.claude.settingsExists && !ctx.claude.settingsParseError) {
    const commands = allHookCommands(ctx.claude.settings);
    const lintFixWired = (config?.targets ?? []).some(
      (t) => t.fixCommands?.length,
    );
    for (const moduleId of manifest.modules ?? []) {
      // lint-fix deliberately leaves its Stop hooks unwired when no target has a fix
      // command (dfdc87). That gap is intentional.
      if (moduleId === 'lint-fix' && !lintFixWired) continue;
      for (const scriptName of HOOK_SCRIPTS[moduleId] ?? []) {
        if (!commands.some((c) => c.includes(scriptName))) {
          report(
            'WARN',
            `module "${moduleId}": hook script ${scriptName} not wired in .claude/settings.json`,
          );
        }
      }
    }
  } else if (manifest && !ctx.claude.settingsExists) {
    report(
      'ERROR',
      'kit installed but .claude/settings.json is missing (hooks unwired) — rerun init',
    );
  }
  if (ctx.claude.settingsParseError)
    report(
      'ERROR',
      `.claude/settings.json unparseable: ${ctx.claude.settingsParseError}`,
    );
  if (ctx.claude.settingsLocalExists) {
    try {
      const local = JSON.parse(
        readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'),
      );
      const dupes = allHookCommands(local).filter((c) =>
        /(guard-bash|lint-format-fix|changeset-check|session-context|debug-session-check)\.mjs/.test(
          c,
        ),
      );
      if (dupes.length)
        report(
          'WARN',
          'settings.local.json also wires kit hook scripts — they will run twice',
        );
    } catch {
      /* local file is the user's business */
    }
  }

  if (manifest?.modules?.includes('changesets')) {
    if (!ctx.changesets.configExists)
      report(
        'ERROR',
        'changesets module installed but .changeset/config.json is missing',
      );
    else if (ctx.changesets.invocation === 'external-cli') {
      report(
        'WARN',
        'changesets CLI not installed (pnpx/npx works; add @changesets/cli as a devDependency for release flows)',
      );
    }
  }

  for (const agentFile of ctx.claude.agents) {
    try {
      const text = readFileSync(
        join(root, '.claude', 'agents', agentFile),
        'utf8',
      );
      if (/^description:.*DRAFT/m.test(text))
        report(
          'WARN',
          `agent ${agentFile} is still a DRAFT — fill in its authoritative source`,
        );
    } catch {
      /* unreadable agent file. Not the doctor's problem. */
    }
  }

  if (manifest?.modules?.includes('rename') && !ctx.typescript) {
    report(
      'WARN',
      'rename module installed but no typescript dependency detected — rename.mjs will fail',
    );
  }

  if (
    manifest?.modules?.includes('verify-changed') &&
    config &&
    !config.verify
  ) {
    report(
      'WARN',
      'verify-changed module installed but no `verify` block in kit.config.json — add one by hand ' +
        '(`update` will NOT: kit.config.json is user-owned and never rewritten). For this repo: ' +
        `"verify": ${JSON.stringify(verifyDefaultsFor(ctx.packageManager, ctx.isMonorepo))}`,
    );
  }

  // Modules and hooks the manifest records but the current kit no longer defines. The
  // kit is otherwise add-and-update-only, so without this an orphan stays invisible.
  if (manifest) {
    const knownModuleIds = new Set(MODULES.map((m) => m.id));
    for (const id of manifest.modules ?? []) {
      if (!knownModuleIds.has(id))
        report(
          'WARN',
          `manifest lists module "${id}" which this kit no longer defines — npx claude-kit update prunes its retired files/hooks`,
        );
    }
    // A kit-owned OR kit-signed hook script this kit no longer ships is retired.
    let currentScripts = new Set<string>();
    try {
      currentScripts = new Set(
        readdirSync(payloadPath('scripts')).filter((f) => f.endsWith('.mjs')),
      );
    } catch {
      /* payload unreadable. Skip the retired-script check. */
    }
    const suspects = new Set<string>();
    for (const p of Object.keys(manifest.files ?? {}))
      if (/^\.claude\/scripts\/[^/]+\.mjs$/.test(p))
        suspects.add(p.split('/').pop()!);
    for (const h of manifest.settings?.hooks ?? [])
      if (h.script) suspects.add(h.script);
    const wiredCommands = ctx.claude.settings
      ? allHookCommands(ctx.claude.settings)
      : [];
    for (const base of suspects) {
      if (currentScripts.has(base)) continue; // still shipped — fine
      const wired = wiredCommands.some((c) => c.includes(base));
      report(
        'WARN',
        `retired kit hook script ${base} is no longer shipped by this kit${wired ? ' but is still wired (a dead node process on every trigger)' : ''} — prune it: npx claude-kit update`,
      );
    }
  }

  // Installing the style file does not activate it. Keyed on the frontmatter NAME
  // "Kit Terse", because the `kit-terse` filename slug silently falls back to Default.
  if (manifest?.modules?.includes('terse-style')) {
    const styleOf = (s: Settings | null | undefined) =>
      typeof s?.outputStyle === 'string' ? s.outputStyle : null;
    const local = readJson<Settings>(
      join(root, '.claude', 'settings.local.json'),
    );
    const active = styleOf(local) ?? styleOf(ctx.claude.settings);
    if (active === 'Kit Terse') {
      readouts.push('terse-style: ACTIVE (outputStyle "Kit Terse")');
    } else if (active === 'kit-terse') {
      report(
        'WARN',
        'terse-style: outputStyle "kit-terse" is the filename slug and silently falls back to Default — set outputStyle to "Kit Terse" (the frontmatter name)',
      );
    } else if (active) {
      readouts.push(
        `terse-style: INACTIVE — installed, but outputStyle "${active}" is active instead`,
      );
    } else {
      readouts.push(
        'terse-style: INACTIVE — installed but no outputStyle set; activate via /config → Output style → "Kit Terse", or set "outputStyle": "Kit Terse"',
      );
    }
  }

  // Derived from the same plan `update` would run, so the two can never disagree. A WARN
  // rather than an ERROR, because a drifted install is not a broken one.
  let drift: DriftReport = { files: [] };
  if (manifest) {
    const targets = ctx.claude.kitConfig?.targets?.length
      ? ctx.claude.kitConfig.targets
      : ctx.targets;
    try {
      const planResult = computeEffects(
        root,
        buildPlan(ctx, {
          moduleIds: manifest.modules ?? ['core'],
          targets,
          seedChangesetConfig: false,
        }),
        { manifest, force: flags.force },
      );
      const prune = computePrune(root, {
        manifest,
        plannedDests: planResult.plannedDests,
      });
      drift = computeDrift(root, planResult.effects, prune);

      if (flags.fix) {
        const fixable = new Set(
          driftedFiles(drift)
            .filter(
              (f) =>
                FIXABLE.includes(f.status) ||
                (f.status === 'yours' && flags.force),
            )
            .map((f) => f.path),
        );
        if (fixable.size) {
          apply(
            root,
            { ...planResult, prune: null },
            {
              kitVersion: flags.kitVersion,
              moduleIds: manifest.modules ?? ['core'],
              previousManifest: manifest,
              paths: fixable,
            },
          );
        }
        if (flags.prune) {
          const repo = new TargetRepo(root);
          for (const file of drift.files) {
            if (file.status === 'orphaned') repo.remove(file.path);
          }
        }
        // Re-derive against the reconciled tree so the report reflects reality.
        const after = computeEffects(
          root,
          buildPlan(ctx, {
            moduleIds: manifest.modules ?? ['core'],
            targets,
            seedChangesetConfig: false,
          }),
          { manifest: readJson<KitManifest>(join(root, MANIFEST_PATH)) },
        );
        drift = computeDrift(
          root,
          after.effects,
          computePrune(root, {
            manifest: readJson<KitManifest>(join(root, MANIFEST_PATH)),
            plannedDests: after.plannedDests,
          }),
        );
      }
    } catch (e) {
      report('ERROR', `could not compute drift: ${(e as Error).message}`);
    }
  }

  for (const file of driftedFiles(drift)) {
    const explain: Record<string, string> = {
      missing: 'missing — `doctor --fix` recreates it',
      stale: 'stale — the kit has a newer version; `update` refreshes it',
      yours: 'yours — you edited it; kept unless --force',
      'no-marker':
        'managed markers removed — `doctor --fix` re-inserts the block',
      orphaned:
        'orphaned — no enabled module produces it; `--fix --prune` removes it',
    };
    // A missing file is a broken install, a hook wired to a script that is not there,
    // not merely drift.
    report(
      file.status === 'missing' ? 'ERROR' : 'WARN',
      `${file.path}: ${explain[file.status] ?? file.status}`,
    );
  }

  const errors = findings.filter((f) => f.level === 'ERROR');
  const warns = findings.filter((f) => f.level === 'WARN');
  const drifted = driftedFiles(drift);
  const blocking = blockingDrift(drifted);
  const code = doctorExitCode({ configProblems, findings, drifted });

  if (flags.json) {
    // Stable shape: this is a CI contract, asserted in src/__test__/cli.test.ts.
    log.json({
      ok: code === EXIT.ok,
      exitCode: code,
      root,
      configProblems,
      findings,
      readouts,
      drift: drift.files,
      counts: {
        errors: errors.length,
        warnings: warns.length,
        drifted: drifted.length,
        blocking: blocking.length,
      },
    });
    return code;
  }

  for (const line of readouts) console.log(`· ${line}`);
  for (const f of findings)
    console.log(`${f.level === 'ERROR' ? '✗ ERROR' : '! WARN '}  ${f.msg}`);
  // Diffs come after the finding list so the summary stays scannable. Only the
  // statuses where "what changed" is actionable carry one.
  for (const file of drifted) {
    if (!file.diff) continue;
    console.log(`\n--- ${file.path} (${file.status})`);
    console.log(
      file.diff
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    );
  }
  console.log(
    findings.length
      ? `\n${errors.length} error(s), ${warns.length} warning(s).`
      : '✓ kit installation healthy — no findings.',
  );
  if (drifted.length && !flags.fix) {
    console.log('Run `npx claude-kit doctor --fix` to reconcile.');
  }
  return code;
}
