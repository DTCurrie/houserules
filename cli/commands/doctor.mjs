// `claude-kit doctor` (claude-kit CLI): validate an installation against reality.
// ERRORs (broken install) exit 1; WARNs (drift, advisories) exit 0.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { detect, trackedTemplateFiles } from '../detect.mjs';
import { verifyDefaultsFor } from '../render.mjs';
import { MANIFEST_PATH } from '../apply.mjs';
import { MODULES } from '../plan.mjs';
import { payloadPath } from '../paths.mjs';
import {
  listWorkspacePackages,
  readJson,
} from '../../payload/scripts/lib/workspaces.mjs';

// module id → hook script that must appear in a settings.json hook command.
const HOOK_SCRIPTS = {
  core: ['guard-bash.mjs'],
  'lint-fix': ['lint-format-fix.mjs'],
  changesets: ['changeset-check.mjs'],
  'session-context': ['session-context.mjs'],
  'debug-session': ['debug-session-check.mjs'],
  'read-guard': ['guard-read.mjs'],
  regen: ['regen-on-edit.mjs'],
  backlog: ['backlog-inject.mjs'],
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// The always-loaded surface is paid on every turn (CONVENTIONS §1). ~3-4K tokens
// is the sane target; take the upper end as the ceiling and ~200 lines alongside.
const RESIDENT_TOKEN_BUDGET = 4000;
const RESIDENT_LINE_BUDGET = 200;

const estimateTokens = (chars) => Math.ceil(chars / 4); // dumb-simple; no tokenizer dep.
const countLines = (t) =>
  t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0);

// `@path` imports that Claude Code inlines: `@` at line start or after whitespace
// (so `foo@bar` emails never match), followed by a path token. Returns the raw
// specifiers; the caller keeps only those that resolve to a real file on disk.
function parseImports(text) {
  const specs = [];
  for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) specs.push(m[1]);
  return specs;
}

// Every project/local memory file Claude Code loads at session start, in its load
// order. `.claude/CLAUDE.md` and `CLAUDE.local.md` are as resident as the root one —
// measuring only the root under-reports the budget below.
const RESIDENT_MEMORY_FILES = [
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  'CLAUDE.local.md',
];

// The `paths:` globs of a .claude/rules/*.md file, empty when it has none. Claude
// Code loads a rule WITH globs only when a matching file is in the working set; one
// WITHOUT them is resident on every turn (so an empty list here means "counts against
// the budget"). Mirrors the platform's own degenerate case: a list of only `**` is
// treated as unscoped. Supports both `paths: [a, b]` and a YAML block list.
function ruleGlobs(text) {
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
function globlessRuleFiles(root) {
  let names;
  try {
    names = readdirSync(join(root, '.claude', 'rules')).filter((f) =>
      f.endsWith('.md'),
    );
  } catch {
    return []; // no rules dir — nothing to measure
  }
  const out = [];
  for (const name of names.sort()) {
    try {
      const text = readFileSync(join(root, '.claude', 'rules', name), 'utf8');
      if (!ruleGlobs(text).length) out.push(`.claude/rules/${name}`);
    } catch {
      /* unreadable rule file — not the doctor's problem */
    }
  }
  return out;
}

// Measure the RESIDENT context surface: every project/local memory file plus every
// @-import they pull in (transitively, bounded), plus the globless rule files that
// load on every turn. Returns null when the repo has no resident surface at all.
// Nested package CLAUDE.mds and path-scoped rules are deliberately NOT counted —
// they are the on-demand tier and must never be summed into the resident total.
function measureResident(root) {
  const globless = globlessRuleFiles(root);
  const sources = [
    ...RESIDENT_MEMORY_FILES.filter((rel) => existsSync(join(root, rel))),
    ...globless,
  ];
  if (!sources.length) return null;
  const seen = new Set();
  let chars = 0;
  let lines = 0;
  let imports = 0;
  const visit = (abs, depth) => {
    if (seen.has(abs) || depth > 5) return;
    seen.add(abs);
    let text;
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
        /* unresolved specifier (package ref, typo) — not an import */
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

function allHookCommands(settings) {
  const commands = [];
  for (const groups of Object.values(settings?.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const hook of group?.hooks ?? [])
        commands.push(String(hook.command ?? ''));
    }
  }
  return commands;
}

export async function doctor(dir, flags) {
  const root = resolve(dir);
  const ctx = detect(root);
  const findings = [];
  const readouts = []; // always-printed context lines, not error/warn findings.
  const report = (level, msg) => findings.push({ level, msg });

  // Resident-surface budget: make the kit's #1 lever (always-loaded context)
  // measurable instead of only prose. Read-only; WARNs past budget, never ERRORs.
  const resident = measureResident(root);
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
    if (over)
      report(
        'WARN',
        `always-loaded context exceeds budget (~${resident.tokens} tokens / ${resident.lines} lines vs ~${RESIDENT_TOKEN_BUDGET} / ${RESIDENT_LINE_BUDGET}) — trim root CLAUDE.md to a one-line index + on-demand files (CONVENTIONS §1)`,
      );
    // A rule file with no `paths:` globs is loaded on every turn — usually not what
    // the author intended, and invisible without this line (CONVENTIONS §6).
    if (resident.globless.length)
      report(
        'WARN',
        `rule file(s) loaded on EVERY turn (no \`paths:\` frontmatter): ${resident.globless.join(', ')} — ` +
          'scope each with a `paths:` glob list so it loads only when a matching file is in play, or move it out of .claude/rules/ (CONVENTIONS §6)',
      );
    // Nested package CLAUDE.mds are the on-demand tier — list separately, never summed.
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
    for (const [rel, expected] of Object.entries(manifest.files ?? {})) {
      const abs = join(root, rel);
      if (!existsSync(abs))
        report('ERROR', `kit file missing: ${rel} (update recreates it)`);
      else if (sha256(readFileSync(abs)) !== expected) {
        report(
          'WARN',
          `kit file locally edited: ${rel} (update will keep your version; --force overwrites)`,
        );
      }
    }
    // Reference templates that got committed before the kit ignored them.
    const strayTemplates = ctx.git.isRepo ? trackedTemplateFiles(root) : [];
    if (strayTemplates.length) {
      report(
        'WARN',
        `${strayTemplates.length} reference template(s) under .claude/kit-templates/ are committed (reference-only). Untrack, keeping them on disk: npx claude-kit update — or: git rm --cached -r .claude/kit-templates && git add .claude/kit-templates/.gitignore`,
      );
    }
  }

  // kit.config.json vs reality.
  const config = ctx.claude.kitConfig;
  if (!config) {
    report(manifest ? 'ERROR' : 'WARN', 'no .claude/kit.config.json');
  } else {
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
      for (const cmd of target.fixCommands ?? config.fix?.commands ?? []) {
        if (!scripts[cmd])
          report(
            'WARN',
            `target "${target.name}": fix script "${cmd}" not in ${target.pathPrefix || './'}package.json`,
          );
      }
      // Verify-changed: only validate a target's EXPLICIT verifyCommands (a detected
      // script later renamed away) — not the global `verify` fallback, which sub-packages
      // routinely lack because they rely on a root verify.
      if (manifest?.modules?.includes('verify-changed'))
        for (const cmd of target.verifyCommands ?? []) {
          if (!scripts[cmd])
            report(
              'WARN',
              `target "${target.name}": verify script "${cmd}" not in ${target.pathPrefix || './'}package.json`,
            );
        }
    }
    // Inverse of the target→workspace check: a workspace member that no target
    // covers silently misses lint-fix / reviewer / ledger coverage while doctor
    // still reports healthy. Point at the seed file (re-running init skips it).
    const targeted = new Set((config.targets ?? []).map((t) => t.packageName));
    for (const p of workspacePackages) {
      if (!targeted.has(p.name))
        report(
          'WARN',
          `workspace package "${p.name}" (${p.relDir}) has no kit target — add one to .claude/kit.config.json targets[] by hand (re-running init skips the existing config)`,
        );
    }
  }

  // Hooks wired?
  if (manifest && ctx.claude.settingsExists && !ctx.claude.settingsParseError) {
    const commands = allHookCommands(ctx.claude.settings);
    const lintFixWired = (config?.targets ?? []).some(
      (t) => t.fixCommands?.length,
    );
    for (const moduleId of manifest.modules ?? []) {
      // lint-fix deliberately leaves its Stop hooks unwired when no target has a
      // fix command (dfdc87) — don't flag that intentional gap.
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

  // Changesets story.
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

  // DRAFT agents left unfilled.
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
      /* unreadable agent file — not the doctor's problem */
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

  // Retired kit surface: modules/hooks the manifest records but the CURRENT kit no
  // longer defines (the kit was add/update-only — this makes an orphan visible so
  // `update` can prune it). See tool-output-compaction-inert.
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
    let currentScripts = new Set();
    try {
      currentScripts = new Set(
        readdirSync(payloadPath('scripts')).filter((f) => f.endsWith('.mjs')),
      );
    } catch {
      /* payload unreadable — skip the retired-script check */
    }
    const suspects = new Set();
    for (const p of Object.keys(manifest.files ?? {}))
      if (/^\.claude\/scripts\/[^/]+\.mjs$/.test(p))
        suspects.add(p.split('/').pop());
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

  // Terse output style: installing the file does not activate it (the style is
  // user-selected). Report the real state from `outputStyle`, keyed on the
  // frontmatter NAME "Kit Terse" — the `kit-terse` filename slug silently falls
  // back to Default. See output-style-keyed-by-name-not-filename.
  if (manifest?.modules?.includes('terse-style')) {
    const styleOf = (s) =>
      typeof s?.outputStyle === 'string' ? s.outputStyle : null;
    const local = readJson(join(root, '.claude', 'settings.local.json'));
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

  const errors = findings.filter((f) => f.level === 'ERROR');
  const warns = findings.filter((f) => f.level === 'WARN');
  for (const line of readouts) console.log(`· ${line}`);
  for (const f of findings)
    console.log(`${f.level === 'ERROR' ? '✗ ERROR' : '! WARN '}  ${f.msg}`);
  console.log(
    findings.length
      ? `\n${errors.length} error(s), ${warns.length} warning(s).`
      : '✓ kit installation healthy — no findings.',
  );
  return errors.length ? 1 : 0;
}
