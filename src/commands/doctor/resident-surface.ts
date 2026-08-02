import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { listWorkspacePackages } from '../../../payload-dist/scripts/lib/workspaces.mjs';
import type { CheckResult, Finding } from './finding.js';

// The always-loaded surface is paid on every turn (CONVENTIONS §1). ~3-4K tokens
// is the sane target. Take the upper end as the ceiling and ~200 lines alongside.
const RESIDENT_TOKEN_BUDGET = 4000;
const RESIDENT_LINE_BUDGET = 200;

// An @-import chain deeper than this is pathological. Stop rather than walk it.
const MAX_IMPORT_DEPTH = 5;

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

export interface ResidentMeasurement {
  chars: number;
  lines: number;
  imports: number;
  tokens: number;
  sources: string[];
  globless: string[];
}

// Nested package CLAUDE.mds and path-scoped rules are deliberately excluded. They are
// the on-demand tier and must never be summed into the resident total.
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

// The `description:` frontmatter of an installed skill/agent (single-line, quotes
// optional). Returns null when the file has none.
export function frontmatterDescription(text: string): string | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!fm) return null;
  const m = /^description:[ \t]*(.*)$/m.exec(fm[1]);
  if (!m) return null;
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

export interface SkillAgentMeasurement {
  chars: number;
  tokens: number;
  skills: number;
  agents: number;
}

// Claude Code puts every `description:` in the system prompt on every turn, the same
// resident tier as CLAUDE.md. Bodies load only on invocation and are not counted.
export function measureSkillAgentDescriptions(
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

/**
 * The resident-surface budget, which makes the kit's #1 lever measurable instead of only
 * prose. Read-only, and WARNs past budget rather than ERRORing.
 */
export function checkResidentSurface(root: string): CheckResult {
  const findings: Finding[] = [];
  const readouts: string[] = [];
  const resident = measureResident(root);
  const skillsAgents = measureSkillAgentDescriptions(root);
  const skillAgentTokens = skillsAgents?.tokens ?? 0;

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
    const combinedTokens = resident.tokens + skillAgentTokens;
    const combinedOver =
      combinedTokens > RESIDENT_TOKEN_BUDGET ||
      resident.lines > RESIDENT_LINE_BUDGET;
    if (combinedOver) {
      const parts = [`root CLAUDE.md/rules (~${resident.tokens} tokens)`];
      if (skillAgentTokens)
        parts.push(`skill/agent descriptions (~${skillAgentTokens} tokens)`);
      findings.push({
        level: 'WARN',
        msg: `always-loaded context exceeds budget (~${combinedTokens} tokens / ${resident.lines} lines vs ~${RESIDENT_TOKEN_BUDGET} / ${RESIDENT_LINE_BUDGET}) — ${parts.join(' + ')} — trim root CLAUDE.md to a one-line index + on-demand files (CONVENTIONS §1)`,
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

  return { findings, readouts };
}
