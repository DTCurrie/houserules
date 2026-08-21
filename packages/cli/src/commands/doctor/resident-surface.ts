import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { listWorkspacePackages } from '@houserules/payload/workspaces';
import { frontmatterBlock, splitFrontmatter } from '../../core/frontmatter.js';
import type { CheckResult, Finding } from '@houserules/api';

// The always-loaded surface is paid on every turn (CONVENTIONS §1). ~3-4K tokens
// is the sane target. Take the upper end as the ceiling and ~200 lines alongside.
const RESIDENT_TOKEN_BUDGET = 4000;
const RESIDENT_LINE_BUDGET = 200;

// An @-import chain deeper than this is pathological. Stop rather than walk it.
const MAX_IMPORT_DEPTH = 5;

const estimateTokens = (chars: number) => Math.ceil(chars / 4); // dumb-simple, no tokenizer dep.
const countLines = (t: string) =>
  t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0);

/**
 * `@` only at line start or after whitespace, so `foo@bar` emails never match. The
 * caller keeps only the specifiers that resolve to a real file on disk.
 */
export function parseImports(text: string): string[] {
  const specs: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const spec = m[1];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

// In Claude Code's load order. `.claude/CLAUDE.md` and `CLAUDE.local.md` are as resident
// as the root one, so measuring only the root under-reports the budget.
const RESIDENT_MEMORY_FILES = [
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  'CLAUDE.local.md',
];

/**
 * Strips YAML quoting and any trailing inline comment from one sequence entry.
 *
 * A quoted entry is taken up to its closing quote, so a `#` inside a glob survives. An
 * unquoted one loses whitespace-then-`#` to the end, which is where YAML ends a scalar.
 */
function cleanGlob(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^(['"])(.*?)\1/.exec(trimmed);
  const value = quoted ? (quoted[2] ?? '') : trimmed.replace(/\s+#.*$/, '');
  return value.replace(/\/\*\*$/, '');
}

/**
 * A globbed rule loads only when a matching file is in the working set, so an empty
 * result here means "resident every turn". A list of only `**` counts as unscoped.
 */
export function ruleGlobs(text: string): string[] {
  const fm = frontmatterBlock(text);
  if (fm === null) return [];
  const lines = fm.split('\n');
  const at = lines.findIndex((l) => /^paths:/.test(l));
  if (at === -1) return [];
  const pathsLine = lines[at];
  if (pathsLine === undefined) return [];
  const inline = pathsLine.slice('paths:'.length).trim();
  const raw = inline ? inline.replace(/^\[|\]$/g, '').split(',') : [];
  if (!inline) {
    for (let i = at + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) break;
      // A comment or blank line is legal inside a YAML block sequence and does not end it.
      // Breaking on one truncates the list, and drops it entirely when the comment sits
      // between `paths:` and the first entry, which then reads as a globless always-loaded
      // rule and spends the resident budget that is not actually being spent.
      if (/^[ \t]*(#|$)/.test(line)) continue;
      const item = /^[ \t]*-[ \t]*(.+)$/.exec(line);
      if (!item) break; // the next key ends the list
      const value = item[1];
      if (value === undefined) break;
      raw.push(value);
    }
  }
  return raw.map(cleanGlob).filter((g) => g && g !== '**');
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

export interface ResidentMeasurement {
  chars: number;
  lines: number;
  imports: number;
  tokens: number;
  sources: string[];
  globless: string[];
}

/**
 * Nested package CLAUDE.mds and path-scoped rules are deliberately excluded. They are
 * the on-demand tier and must never be summed into the resident total.
 */
export function measureResident(root: string): ResidentMeasurement | null {
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
    if (seen.has(abs) || depth > MAX_IMPORT_DEPTH) return;
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

/**
 * The `description:` frontmatter of an installed skill/agent (single-line, quotes
 * optional). Returns null when the file has none.
 */
export function frontmatterDescription(text: string): string | null {
  const fm = frontmatterBlock(text);
  if (fm === null) return null;
  const m = /^description:[ \t]*(.*)$/m.exec(fm);
  if (!m) return null;
  const captured = m[1];
  if (captured === undefined) return null;
  return captured.trim().replace(/^['"]|['"]$/g, '');
}

export interface SkillAgentMeasurement {
  chars: number;
  tokens: number;
  skills: number;
  agents: number;
}

/**
 * Every `SKILL.md` under `dir`, at any depth. Claude Code accepts a category-organized
 * layout (`skills/<category>/<name>/SKILL.md`), not only the flat `skills/<name>/SKILL.md`
 * one level down, so a directory holding a `SKILL.md` is not assumed to be a leaf.
 */
function findSkillFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md'))
    found.push(join(dir, 'SKILL.md'));
  for (const entry of entries) {
    if (entry.isDirectory())
      found.push(...findSkillFiles(join(dir, entry.name)));
  }
  return found;
}

/**
 * Claude Code puts every `description:` in the system prompt on every turn, the same
 * resident tier as CLAUDE.md. Bodies load only on invocation and are not counted.
 */
export function measureSkillAgentDescriptions(
  root: string,
): SkillAgentMeasurement | null {
  let chars = 0;
  let skills = 0;
  let agents = 0;
  for (const file of findSkillFiles(join(root, '.claude', 'skills'))) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const desc = frontmatterDescription(text);
    if (desc) {
      chars += desc.length;
      skills += 1;
    }
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

interface OutputStyleSettings {
  outputStyle?: string;
}

function readOutputStyleSettings(path: string): OutputStyleSettings | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The active style is settings.local.json's `outputStyle`, falling back to settings.json's.
 * Mirrors the same precedence `output-prose`'s own check reads it with.
 */
function activeOutputStyleName(root: string): string | null {
  const local = readOutputStyleSettings(
    join(root, '.claude', 'settings.local.json'),
  );
  if (typeof local?.outputStyle === 'string') return local.outputStyle;
  const main = readOutputStyleSettings(join(root, '.claude', 'settings.json'));
  return typeof main?.outputStyle === 'string' ? main.outputStyle : null;
}

/**
 * The `name:` frontmatter of an installed output style. Claude Code matches `outputStyle`
 * against this, not the filename, so the lookup below has to key on it too.
 */
function frontmatterName(text: string): string | null {
  const fm = frontmatterBlock(text);
  if (fm === null) return null;
  const m = /^name:[ \t]*(.*)$/m.exec(fm);
  const captured = m?.[1];
  if (captured === undefined) return null;
  return captured.trim().replace(/^['"]|['"]$/g, '');
}

export interface OutputStyleMeasurement {
  chars: number;
  tokens: number;
  name: string;
}

/**
 * An active output style is injected into the system prompt on every turn, the same
 * resident tier as CLAUDE.md. Only the body is counted, since the frontmatter itself
 * never reaches the prompt.
 */
export function measureActiveOutputStyle(
  root: string,
): OutputStyleMeasurement | null {
  const activeName = activeOutputStyleName(root);
  if (!activeName) return null;
  let names: string[];
  try {
    names = readdirSync(join(root, '.claude', 'output-styles')).filter((f) =>
      f.endsWith('.md'),
    );
  } catch {
    return null;
  }
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(root, '.claude', 'output-styles', name), 'utf8');
    } catch {
      continue;
    }
    if (frontmatterName(text) !== activeName) continue;
    const chars = splitFrontmatter(text).body.length;
    return { chars, tokens: estimateTokens(chars), name: activeName };
  }
  return null;
}

/**
 * The resident-surface budget, which makes houserules' #1 lever measurable instead of only
 * prose. Read-only, and WARNs past budget rather than ERRORing.
 */
export function checkResidentSurface(root: string): CheckResult {
  const findings: Finding[] = [];
  const readouts: string[] = [];
  const resident = measureResident(root);
  const skillsAgents = measureSkillAgentDescriptions(root);
  const style = measureActiveOutputStyle(root);
  const skillAgentTokens = skillsAgents?.tokens ?? 0;
  const styleTokens = style?.tokens ?? 0;

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
    // Every always-loaded tier alone, or any combination, can push the total over.
    const combinedTokens = resident.tokens + skillAgentTokens + styleTokens;
    const combinedOver =
      combinedTokens > RESIDENT_TOKEN_BUDGET ||
      resident.lines > RESIDENT_LINE_BUDGET;
    if (combinedOver) {
      const parts = [`root CLAUDE.md/rules (~${resident.tokens} tokens)`];
      if (skillAgentTokens)
        parts.push(`skill/agent descriptions (~${skillAgentTokens} tokens)`);
      if (styleTokens) parts.push(`output style (~${styleTokens} tokens)`);
      findings.push({
        level: 'WARN',
        msg: `always-loaded context exceeds budget (~${combinedTokens} tokens / ${resident.lines} lines vs ~${RESIDENT_TOKEN_BUDGET} / ${RESIDENT_LINE_BUDGET}). ${parts.join(' + ')}. Trim root CLAUDE.md to a one-line index + on-demand files (CONVENTIONS §1)`,
      });
    }
    // A globless rule loads every turn. Usually not intended, and invisible without
    // this line (CONVENTIONS §6).
    if (resident.globless.length)
      findings.push({
        level: 'WARN',
        msg:
          `rule file(s) loaded on EVERY turn (no \`paths:\` frontmatter): ${resident.globless.join(', ')} — ` +
          'scope each with a `paths:` glob list so it loads only when a matching file is in play, or move it out of .claude/rules/ (CONVENTIONS §6)',
      });
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
  if (style)
    readouts.push(
      `resident output style (${style.name}): ~${style.tokens} tokens`,
    );

  return { findings, readouts };
}
