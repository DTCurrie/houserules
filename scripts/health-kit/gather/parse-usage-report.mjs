#!/usr/bin/env node
// Parses a houserules usage report document into the usage@1 JSON described by SCHEMA.md.
// Usage: node parse-usage-report.mjs <document> <out.json> [--schema <path>]
// Both positionals are required. `--schema` defaults to the SCHEMA.md beside this script.
// Exit codes: 0 written, 1 the document fails its own arithmetic or key-path checks, 2 bad usage.
// Node builtins only. Checks its own arithmetic and its own key paths before writing.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  console.error(`parse-usage-report: ${message}`);
  process.exit(1);
}

const num = (s) => Number(String(s).replace(/,/g, ''));

const args = process.argv.slice(2);
let schemaPath = fileURLToPath(new URL('./SCHEMA.md', import.meta.url));
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--schema') {
    schemaPath = args[++i];
    if (!schemaPath) fail('--schema needs a path');
  } else positional.push(args[i]);
}
if (positional.length !== 2) {
  console.error(
    'usage: node parse-usage-report.mjs <document> <out.json> [--schema <path>]',
  );
  process.exit(2);
}
const [docPath, outPath] = positional;
const docText = readFileSync(docPath, 'utf8');
const lines = docText.split('\n');

/** Rows of a whitespace-aligned table: the lines after the dashes line, up to a blank line. */
function tableRows(sectionLines, headerPattern) {
  const h = sectionLines.findIndex((l) => headerPattern.test(l));
  if (h < 0) return [];
  let i = h + 1;
  if (sectionLines[i] && /^\s*-+(\s+-+)*\s*$/.test(sectionLines[i])) i++;
  const rows = [];
  for (; i < sectionLines.length; i++) {
    if (sectionLines[i].trim() === '') break;
    rows.push(sectionLines[i].trim().split(/\s+/));
  }
  return rows;
}

function parseSummary() {
  const start = lines.findIndex((l) => /^## Summary\s*$/.test(l));
  if (start < 0) fail('no "## Summary" section');
  const tbl = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i])) tbl.push(lines[i]);
    else if (tbl.length) break;
  }
  if (tbl.length < 3) fail('Summary table has no rows');
  const cells = (l) =>
    l
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
  const heads = cells(tbl[0]).map((h) => h.toLowerCase());
  const col = (prefix) => heads.findIndex((h) => h.startsWith(prefix));
  const idx = {
    project: col('project'),
    kitVersion: col('kit version'),
    installedAt: col('installed at'),
    reportCli: col('report cli'),
    sessions: col('sessions'),
    turns: col('turns'),
    modules: col('modules'),
  };
  for (const k of [
    'project',
    'kitVersion',
    'installedAt',
    'reportCli',
    'sessions',
    'turns',
  ]) {
    if (idx[k] < 0) fail(`Summary table has no ${k} column`);
  }
  return tbl.slice(2).map((l) => {
    const c = cells(l);
    return {
      project: c[idx.project],
      kitVersion: c[idx.kitVersion],
      installedAt: c[idx.installedAt],
      reportCli: c[idx.reportCli],
      sessions: num(c[idx.sessions]),
      turns: num(c[idx.turns]),
      modules: idx.modules < 0 ? null : num(c[idx.modules]),
    };
  });
}

function parseHeader(bullets) {
  const byLabel = new Map();
  for (const l of bullets) {
    const m = /^- \*\*(.+?):\*\*\s*(.*)$/.exec(l);
    if (m) byLabel.set(m[1], m[2]);
  }
  const get = (label) => (byLabel.has(label) ? byLabel.get(label) : null);
  const labelled = (prefix) => {
    for (const [label, value] of byLabel) {
      const m = new RegExp(`^${prefix} \\((\\d+)\\)$`).exec(label);
      if (m) return { count: Number(m[1]), value };
    }
    return { count: null, value: null };
  };
  const kit = get('Kit version');
  const kitMatch =
    kit === null ? null : /^(\S+)(?:\s+\(installed (\S+?)\))?/.exec(kit);
  const pathValue = get('Path');
  const hooks = labelled('Hooks wired');
  const modules = labelled('Modules');
  const split = (v) =>
    v === null ? [] : v.split(', ').filter((s) => s.length);
  return {
    path: pathValue === null ? null : pathValue.replace(/`/g, ''),
    kitVersion: kitMatch ? kitMatch[1] : null,
    installedAt: kitMatch && kitMatch[2] ? kitMatch[2] : null,
    reportCli: get('Report produced by CLI'),
    neededUpdate: get('Needed update to run report'),
    installStyle: get('Install style'),
    packages: get('houserules packages'),
    hooksCount: hooks.count,
    hooks: split(hooks.value),
    modulesCount: modules.count,
    modules: split(modules.value),
    versionCaveat: get('Version caveat'),
  };
}

const SESSION_RE =
  /^\s{2}(\w{8})\s+turns (\S+)\s+in (\S+)\s+out (\S+)\s+cache_read (\S+)\s+cache_write (\S+)\s+tools (\S+)\s+weighted-in (\S+)(?:\s+wall (.+?))?\s*$/;
const SPLIT_RE =
  /^\s+main weighted-in (\S+) out (\S+) \| subagents weighted-in (\S+) out (\S+)\s*$/;
const MODEL_RE = /^(\S+): weighted-in (\S+) out (\S+)$/;

function parseSessions(bodyLines) {
  const sessions = [];
  let current = null;
  for (const l of bodyLines) {
    const m = SESSION_RE.exec(l);
    if (m) {
      current = {
        id: m[1],
        turns: num(m[2]),
        input: num(m[3]),
        output: num(m[4]),
        cacheRead: num(m[5]),
        cacheWrite: num(m[6]),
        tools: num(m[7]),
        weightedIn: num(m[8]),
        wall: m[9] === undefined ? null : m[9],
        main: null,
        subagents: null,
        models: [],
      };
      sessions.push(current);
      continue;
    }
    if (!current || !/^\s{6,}\S/.test(l)) continue;
    const s = SPLIT_RE.exec(l);
    if (s) {
      current.main = { weightedIn: num(s[1]), output: num(s[2]) };
      current.subagents = { weightedIn: num(s[3]), output: num(s[4]) };
      continue;
    }
    for (const part of l.trim().split(' | ')) {
      const mm = MODEL_RE.exec(part);
      if (!mm)
        fail(`unparsed session continuation line: ${l.trim().slice(0, 80)}`);
      current.models.push({
        model: mm[1],
        weightedIn: num(mm[2]),
        output: num(mm[3]),
      });
    }
  }
  return sessions;
}

function parseTotals(sec) {
  const text = sec.join('\n');
  const req = (re, what) => {
    const m = re.exec(text);
    if (!m) fail(`totals block lacks ${what}`);
    return m;
  };
  const a = req(
    /turns (\S+) \| fresh input (\S+) \| output (\S+)/,
    'the turns line',
  );
  const b = req(
    /cache_read (\S+) \| cache_write (\S+) \| tool_results (\S+)/,
    'the cache line',
  );
  const share = req(
    /cache-read share of input: (\d+)%/,
    'the cache-read share',
  );
  const w = req(
    /cost-weighted input-equivalent: (\S+)/,
    'the cost-weighted line',
  );
  const mod = /^\s*models: (.*?)(?: \| sidechain turns: (\d+)%)?\s*$/m.exec(
    text,
  );
  const ph = /^\s*(\S+) .*record\(s\).*placeholder/m.exec(text);
  return {
    turns: num(a[1]),
    input: num(a[2]),
    output: num(a[3]),
    cacheRead: num(b[1]),
    cacheWrite: num(b[2]),
    toolResults: num(b[3]),
    cacheReadSharePct: Number(share[1]),
    weightedIn: num(w[1]),
    models: mod ? mod[1].split(', ').filter((s) => s.length) : [],
    sidechainPct: mod && mod[2] !== undefined ? Number(mod[2]) : null,
    placeholderRecords: ph ? num(ph[1]) : 0,
  };
}

function parseHookHealth(sec) {
  const hookHealth = tableRows(sec, /^\s*hook\s+fires\s/).map((t) => {
    if (t.length !== 8)
      fail(`hook health row has ${t.length} cells: ${t.join(' ')}`);
    return {
      hook: t[0],
      fires: num(t[1]),
      nonZero: num(t[2]),
      crashes: num(t[3]),
      blocks: num(t[4]),
      p50ms: num(t[5]),
      p95ms: num(t[6]),
      maxms: num(t[7]),
    };
  });
  const text = sec.join('\n');
  const bash = /this corpus holds ([\d,]+) Bash tool calls/.exec(text);
  const crashSignatures = [];
  const ci = sec.findIndex((l) => /^\s*crash signatures:/.test(l));
  if (ci >= 0) {
    for (let i = ci + 1; i < sec.length && sec[i].trim() !== ''; i++) {
      const m = /^\s+(\d[\d,]*)\s+(.+?)\s*$/.exec(sec[i]);
      if (m) crashSignatures.push({ count: num(m[1]), signature: m[2] });
    }
  }
  return { hookHealth, bashCalls: bash ? num(bash[1]) : null, crashSignatures };
}

function parseGuard(sec) {
  const body = sec.map((l) => l.trim()).filter((l) => l.length);
  return body.length ? body.join(' ') : null;
}

function parseSkills(sec) {
  const rows = tableRows(sec, /^\s*skill\s+model\s+user\s+total\s*$/).map(
    (t) => ({
      skill: t[0],
      model: num(t[1]),
      user: num(t[2]),
      total: num(t[3]),
    }),
  );
  const ta = /toolset-active sessions: (\d+) of (\d+)/.exec(sec.join('\n'));
  let unusedLabel = null;
  let unused = [];
  for (const l of sec) {
    const m =
      /^\s*(unused here|dead skills) \(installed, zero fires\):\s*(.*?)\s*$/.exec(
        l,
      );
    if (m) {
      unusedLabel = m[1];
      unused = m[2].split(', ').filter((s) => s.length);
    }
  }
  const outcomes = [];
  for (const l of sec) {
    const m =
      /^\s*\/(changeset|backlog-add|decide):\s+fired (\d+),\s*(.*)$/.exec(l);
    if (!m) continue;
    const o = {
      skill: m[1],
      fired: Number(m[2]),
      matched: 0,
      matchedGit: null,
      recordEntries: null,
      filesAdded: null,
      ledgerAdds: null,
    };
    if (m[1] === 'changeset') {
      const c =
        /^matched (\d+) via the outcome record and (\d+) via the \d+h git window \((\d+) record entries, (\d+) files added across history\)/.exec(
          m[3],
        );
      if (!c)
        fail(`unparsed changeset outcome line: ${l.trim().slice(0, 100)}`);
      o.matched = Number(c[1]);
      o.matchedGit = Number(c[2]);
      o.recordEntries = Number(c[3]);
      o.filesAdded = Number(c[4]);
    } else {
      const c =
        /^matched a ledger add for (\d+) \((\d+) adds? in the local ledger\)/.exec(
          m[3],
        );
      if (!c) fail(`unparsed ${m[1]} outcome line: ${l.trim().slice(0, 100)}`);
      o.matched = Number(c[1]);
      o.ledgerAdds = Number(c[2]);
    }
    outcomes.push(o);
  }
  return {
    rows,
    toolsetActive: ta ? { active: Number(ta[1]), total: Number(ta[2]) } : null,
    unusedLabel,
    unused,
    outcomes,
  };
}

function parseFriction(sec) {
  const text = sec.join('\n');
  const comp =
    /compaction: (\d+) session\(s\) resumed from auto-compact(?: \(([^)]*)\))?/.exec(
      text,
    );
  const compaction = {
    count: comp ? Number(comp[1]) : 0,
    sessions:
      comp && comp[2] ? comp[2].split(', ').filter((s) => s.length) : [],
  };
  const toolResultBulk = tableRows(sec, /^\s*tool\s+results\s+bytes\s*$/).map(
    (t) => ({
      tool: t[0],
      results: num(t[1]),
      bytes: num(t[2]),
    }),
  );
  const br = /bash retries \(.*?\): (\d+) runs, (\d+) repeated calls/.exec(
    text,
  );
  const top = [];
  const bi = sec.findIndex((l) => /^\s*bash retries/.test(l));
  if (bi >= 0) {
    for (let i = bi + 1; i < sec.length && sec[i].trim() !== ''; i++) {
      const m = /^\s+(\w{8})\s+x(\d+)\s+(.+?)\s*$/.exec(sec[i]);
      if (!m) fail(`unparsed bash retries line: ${sec[i].trim().slice(0, 80)}`);
      top.push({ session: m[1], count: Number(m[2]), command: m[3] });
    }
  }
  const dn =
    /denials: (\d+) tool use\(s\) rejected by the user, (\d+) interrupted mid-call/.exec(
      text,
    );
  const samples = [];
  const di = sec.findIndex((l) => /^\s*denials:/.test(l));
  if (di >= 0) {
    for (let i = di + 1; i < sec.length && sec[i].trim() !== ''; i++) {
      const m = /^\s+(\S+)(?:\s{2,}(.+?))?\s*$/.exec(sec[i]);
      if (m)
        samples.push({ tool: m[1], command: m[2] === undefined ? null : m[2] });
    }
  }
  return {
    compaction,
    toolResultBulk,
    bashRetries: {
      runs: br ? Number(br[1]) : 0,
      repeatedCalls: br ? Number(br[2]) : 0,
      top,
    },
    denials: {
      rejected: dn ? Number(dn[1]) : 0,
      interrupted: dn ? Number(dn[2]) : 0,
      samples,
    },
  };
}

function parseResident(sec) {
  const rec = /recorded (\d+) of (\d+) session\(s\)/.exec(sec.join('\n'));
  if (!rec) fail('resident context section lacks the "recorded A of T" line');
  const rows = [];
  for (const t of tableRows(sec, /^\s*session\s+entrypoint\s/)) {
    const session = t[0];
    if (t.slice(1).join(' ').startsWith('not recorded')) {
      rows.push({
        session,
        recorded: false,
        entrypoint: null,
        system: null,
        instructions: null,
        skills: null,
        agents: null,
        style: null,
        total: null,
        tokens: null,
        nestedLoads: null,
        nestedBytes: null,
      });
      continue;
    }
    let rest = t.slice(1);
    let entrypoint = null;
    if (!/^[\d,]+$/.test(rest[0])) entrypoint = rest.shift();
    if (rest.length !== 9)
      fail(`resident row ${session} has ${rest.length} numeric cells`);
    const nested = /^\(([\d,]+)\)$/.exec(rest[8]);
    if (!nested)
      fail(`resident row ${session} has a malformed nested loads cell`);
    rows.push({
      session,
      recorded: true,
      entrypoint,
      system: num(rest[0]),
      instructions: num(rest[1]),
      skills: num(rest[2]),
      agents: num(rest[3]),
      style: num(rest[4]),
      total: num(rest[5]),
      tokens: num(rest[6]),
      nestedLoads: num(rest[7]),
      nestedBytes: num(nested[1]),
    });
  }
  const medians = [];
  for (const l of sec) {
    const m = /^medians \((.+?)\): total ([\d,]+) bytes, ~tokens ([\d,]+)/.exec(
      l,
    );
    if (!m) continue;
    const scoped = /^(.+), (\d+) session\(s\)$/.exec(m[1]);
    medians.push({
      scope: m[1] === 'all sessions' ? 'all' : scoped ? scoped[1] : m[1],
      sessions: scoped ? Number(scoped[2]) : null,
      totalBytes: num(m[2]),
      tokens: num(m[3]),
    });
  }
  const nested = [];
  let cur = null;
  for (const l of sec) {
    const h =
      /^\s+nested loads, (\w+): (\d+) loads \(([\d,]+) bytes\)\s*$/.exec(l);
    if (h) {
      cur = {
        session: h[1],
        loads: Number(h[2]),
        bytes: num(h[3]),
        mainLoads: 0,
        mainBytes: 0,
        subagentLoads: 0,
        subagentBytes: 0,
        rules: [],
      };
      nested.push(cur);
      continue;
    }
    if (!cur || !/^\s{4}\S/.test(l)) continue;
    const m = /^\s+(.+?): (\d+) loads \(([\d,]+) bytes\)\s*$/.exec(l);
    if (!m) continue; // "+N more" truncation lines carry no row
    if (m[1] === 'main chain') {
      cur.mainLoads = Number(m[2]);
      cur.mainBytes = num(m[3]);
    } else if (m[1] === 'subagents') {
      cur.subagentLoads = Number(m[2]);
      cur.subagentBytes = num(m[3]);
    } else
      cur.rules.push({ path: m[1], loads: Number(m[2]), bytes: num(m[3]) });
  }
  return {
    recorded: Number(rec[1]),
    total: Number(rec[2]),
    rows,
    medians,
    nested,
  };
}

function parseProject(name, sectionLines) {
  const fenceStart = sectionLines.findIndex((l) => /^```/.test(l));
  if (fenceStart < 0) fail(`${name}: no fenced report block`);
  let fenceEnd = sectionLines.findIndex(
    (l, i) => i > fenceStart && /^```\s*$/.test(l),
  );
  if (fenceEnd < 0) fenceEnd = sectionLines.length;
  const header = parseHeader(sectionLines.slice(0, fenceStart));
  const body = sectionLines.slice(fenceStart + 1, fenceEnd);

  const project = {
    name,
    render: 'current',
    header,
    sessionsStated: 0,
    range: null,
    sessions: [],
    totals: null,
    hookHealth: [],
    bashCalls: null,
    crashSignatures: [],
    guard: null,
    skills: null,
    friction: null,
    resident: null,
  };

  if (
    body.some((l) =>
      /^(No \.jsonl transcripts in |No transcripts found \(looked in )/.test(l),
    )
  ) {
    project.render = 'empty';
    return project;
  }

  const rangeMatch = body
    .map((l) => /^sessions: (\d+), from (\S+) to (\S+)\s*$/.exec(l))
    .find(Boolean);
  if (rangeMatch) project.range = { from: rangeMatch[2], to: rangeMatch[3] };
  else project.render = '0.4.1';

  const statedIdx = body.findIndex((l) => /^\d+ session\(s\):\s*$/.test(l));
  if (statedIdx < 0) fail(`${name}: no "N session(s):" line`);
  project.sessionsStated = Number(/^(\d+)/.exec(body[statedIdx])[1]);

  const sections = new Map();
  let firstMarker = body.length;
  let currentName = null;
  body.forEach((l, i) => {
    const m = /^-- (.+) --\s*$/.exec(l);
    if (m) {
      if (firstMarker === body.length) firstMarker = i;
      currentName = m[1];
      sections.set(currentName, []);
    } else if (currentName) sections.get(currentName).push(l);
  });

  project.sessions = parseSessions(body.slice(statedIdx + 1, firstMarker));
  if (sections.has('totals'))
    project.totals = parseTotals(sections.get('totals'));
  if (sections.has('hook health')) {
    const h = parseHookHealth(sections.get('hook health'));
    project.hookHealth = h.hookHealth;
    project.bashCalls = h.bashCalls;
    project.crashSignatures = h.crashSignatures;
  }
  if (sections.has('guard efficacy'))
    project.guard = parseGuard(sections.get('guard efficacy'));
  if (sections.has('skills'))
    project.skills = parseSkills(sections.get('skills'));
  if (sections.has('friction'))
    project.friction = parseFriction(sections.get('friction'));
  if (sections.has('resident context')) {
    project.resident = parseResident(sections.get('resident context'));
  }
  return project;
}

const h1 = lines
  .map((l) => /^# .*?(\d{4}-\d{2}-\d{2})\s*$/.exec(l))
  .find(Boolean);
if (!h1) fail('no H1 with a YYYY-MM-DD date');

const summary = parseSummary();

const perProject = lines.findIndex((l) =>
  /^## Per-project reports\s*$/.test(l),
);
if (perProject < 0) fail('no "## Per-project reports" section');
const projects = [];
{
  let name = null;
  let buf = [];
  const flush = () => {
    if (name !== null) projects.push(parseProject(name, buf));
  };
  for (let i = perProject + 1; i < lines.length; i++) {
    const m = /^### (.+?)\s*$/.exec(lines[i]);
    if (m) {
      flush();
      name = m[1];
      buf = [];
    } else if (/^## /.test(lines[i])) {
      flush();
      name = null;
    } else if (name !== null) buf.push(lines[i]);
  }
  flush();
}

const output = {
  schema: 'usage@1',
  source: basename(docPath),
  date: h1[1],
  summary,
  projects,
};

for (const p of projects) {
  const row = summary.find((s) => s.project === p.name);
  if (!row) fail(`${p.name}: no row in the Summary table`);
  const turnsSum = p.sessions.reduce((a, s) => a + s.turns, 0);
  const totalTurns = p.totals ? p.totals.turns : 0;
  const pairs = [
    ['sessions.length', p.sessions.length, 'sessionsStated', p.sessionsStated],
    ['sessions.length', p.sessions.length, 'Summary Sessions', row.sessions],
    ['sum of sessions[].turns', turnsSum, 'totals.turns', totalTurns],
    ['sum of sessions[].turns', turnsSum, 'Summary Turns', row.turns],
  ];
  for (const [la, a, lb, b] of pairs) {
    if (a !== b) fail(`${p.name}: ${la} is ${a} but ${lb} is ${b}`);
  }
}

function readKeyList(path) {
  const text = readFileSync(path, 'utf8').split('\n');
  const start = text.findIndex((l) => /^```keys usage\s*$/.test(l));
  if (start < 0) fail(`${path}: no "keys usage" block`);
  const set = new Set();
  for (let i = start + 1; i < text.length && !/^```\s*$/.test(text[i]); i++) {
    const t = text[i].trim();
    if (t) set.add(t.split(/\s+/)[0]);
  }
  return set;
}

const allowed = readKeyList(schemaPath);

function walk(value, path) {
  if (Array.isArray(value)) {
    for (const el of value) walk(el, `${path}[]`);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    const p = path === '' ? k : `${path}.${k}`;
    const keyPath = Array.isArray(v) ? `${p}[]` : p;
    if (!allowed.has(keyPath))
      fail(`key path not in the "keys usage" block: ${keyPath}`);
    walk(v, p);
  }
}
walk(output, '');

writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
let totalSessions = 0;
let totalTurns = 0;
for (const p of projects) {
  const turns = p.sessions.reduce((a, s) => a + s.turns, 0);
  totalSessions += p.sessions.length;
  totalTurns += turns;
  console.log(
    `${p.name}  ${p.render}  ${p.sessions.length} sessions  ${turns} turns`,
  );
}
console.log(
  `total  ${projects.length} projects  ${totalSessions} sessions  ${totalTurns} turns`,
);
