#!/usr/bin/env node
/**
 * Writes one local-installs report document from `<reports>/local-report-<repo>.txt` and each
 * install's manifest, settings, package.json, and config.
 *
 * Usage: node assemble-local-report.mjs --reports <dir> --out <file> --projects-root <dir>
 *          --repos <a,b,c> --cli-version <x.y.z> --date <YYYY-MM-DD> --older-than <x.y.z>
 *
 * Every flag is required. `--reports` holds the raw `houserules report` outputs, `--projects-root`
 * holds one install per repo name, `--cli-version` is the build that produced the raw reports,
 * and `--older-than` is the kit version below which a project gets an older-version caveat.
 *
 * Exit codes: 0 written, 1 a Summary cell differs from its raw report, the section count is not
 * the repo count, or the output holds the home path or username, 2 bad usage.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { execFileSync } from 'node:child_process';

const USAGE =
  'usage: node assemble-local-report.mjs --reports <dir> --out <file> --projects-root <dir> ' +
  '--repos <a,b,c> --cli-version <x.y.z> --date <YYYY-MM-DD> --older-than <x.y.z>';
const FLAGS = [
  'reports',
  'out',
  'projects-root',
  'repos',
  'cli-version',
  'date',
  'older-than',
];
const opts = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.startsWith('--') ? argv[i].slice(2) : null;
    if (!FLAGS.includes(name) || argv[i + 1] === undefined) {
      console.error(`assemble-local-report: bad argument ${argv[i]}\n${USAGE}`);
      process.exit(2);
    }
    opts[name] = argv[i + 1];
  }
  const missing = FLAGS.filter((f) => !opts[f]);
  if (missing.length) {
    console.error(
      `assemble-local-report: missing --${missing.join(', --')}\n${USAGE}`,
    );
    process.exit(2);
  }
}
const reportsDir = resolve(opts.reports);
const outPath = resolve(opts.out);
const projectsRoot = resolve(opts['projects-root']);
const REPOS = opts.repos.split(',').filter(Boolean);
const CLI_VERSION = opts['cli-version'];
const REPORT_CLI = `${CLI_VERSION} (this repo's build)`;
const NOTE_DATE = opts.date;
const OLDER_THAN = opts['older-than'];
const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];
const countWord = NUMBER_WORDS[REPOS.length] ?? String(REPOS.length);

const home = homedir();
const user = userInfo().username;
const mask = (s) =>
  s.split(home).join('~').split(`-Users-${user}-`).join('-Users-<user>-');

const fail = (msg) => {
  console.error(`assemble-local-report: ${msg}`);
  process.exit(1);
};
const readJson = (p) =>
  existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
const fmt = (n) => Number(n).toLocaleString('en-US');
const verLt = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
};

const latest = execFileSync('npm', ['view', '@houserules/cli', 'version'], {
  encoding: 'utf8',
}).trim();

function hooksOf(settings) {
  const out = [];
  for (const [event, groups] of Object.entries(settings?.hooks ?? {})) {
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        const m = /([\w.-]+\.mjs)/.exec(
          String(h.command ?? '').replace(/^.*?scripts\//, ''),
        );
        const script = m ? m[1] : null;
        if (!script) continue;
        out.push(`${event}${g.matcher ? `[${g.matcher}]` : ''}→${script}`);
      }
    }
  }
  return out;
}

function installedPackages(root) {
  const dir = join(root, 'node_modules', '@houserules');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((n) => readJson(join(dir, n, 'package.json')))
    .filter(Boolean)
    .map((p) => `${p.name.replace('@houserules/', '')}@${p.version}`);
}

function installInfo(root) {
  const pkg = readJson(join(root, 'package.json'));
  const cfg = readJson(join(root, '.claude', 'houserules.config.json'));
  const pm = existsSync(join(root, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(root, 'yarn.lock'))
      ? 'yarn'
      : existsSync(join(root, 'package-lock.json'))
        ? 'npm'
        : null;
  let style = null;
  if (pkg?.devDependencies?.['@houserules/cli']) {
    style = `devDependency in package.json${pm ? ` (${pm})` : ''}`;
  } else if (pkg?.dependencies?.['@houserules/cli']) {
    style = `dependency in package.json${pm ? ` (${pm})` : ''}`;
  } else if (pkg) {
    style = 'no @houserules/cli dependency in package.json';
  }
  const installed = installedPackages(root);
  const have = new Set(installed.map((p) => p.replace(/@[^@]*$/, '')));
  const missing = (cfg?.plugins ?? [])
    .map((p) => p.name)
    .filter(
      (n) =>
        !have.has(n.replace(/^@houserules\//, '').replace(/^.*\//, '')) &&
        !have.has(n.replace(/^@houserules\//, '')),
    );
  const parts = [];
  if (installed.length) parts.push(installed.join(', '));
  if (missing.length) {
    parts.push(
      `from config plugins list, no installed copy: ${missing.join(', ')}`,
    );
  }
  return { style, packages: parts.length ? parts.join('; ') : null };
}

const projects = [];
for (const repo of REPOS) {
  const root = join(projectsRoot, repo);
  const rawFile = join(reportsDir, `local-report-${repo}.txt`);
  if (!existsSync(rawFile)) fail(`missing ${rawFile}`);
  const raw = readFileSync(rawFile, 'utf8').replace(/\s+$/, '');
  const manifest = readJson(join(root, '.claude', 'houserules.manifest.json'));
  if (!manifest) fail(`no manifest for ${repo}`);
  const settings = readJson(join(root, '.claude', 'settings.json'));
  const hooks = hooksOf(settings);
  const { style, packages } = installInfo(root);
  const sm = /^(\d+) session\(s\):/m.exec(raw);
  const sessions = sm ? Number(sm[1]) : 0;
  const tm = /^-- totals --\n\s+turns ([\d,]+)/m.exec(raw);
  const turns = tm ? Number(tm[1].replace(/,/g, '')) : 0;
  projects.push({
    repo,
    raw,
    manifest,
    hooks,
    style,
    packages,
    sessions,
    turns,
  });
}

const lines = [];
lines.push(`# houserules usage report, local installs: ${NOTE_DATE}`, '');
lines.push(
  '> **Redacted.** These outputs follow the same policy as `houserules report --export`. In the `bash retries` and `denials` lists, each command is reduced to its name (`cat`, `git switch`, `python3`; `(assignment)` for a leading `VAR=…`), and arguments, paths, IDs and file contents are removed. Snippets from tools other than Bash are replaced with `[redacted]`. Usernames in paths are masked (`~/…`, `-Users-<user>-…`). Counts, session ID prefixes, hook names, skill names, and repo-relative rule file paths are kept.',
  '',
);
lines.push('## How this was collected', '');
lines.push(
  `- Read ${projects.length} local installs under \`${mask(projectsRoot)}\`, one section each: ${REPOS.join(', ')}.`,
  `- One analyzer for all ${countWord}: this repo's build of \`@houserules/cli\` at **${CLI_VERSION}** ran \`houserules report\` from each project root over that machine's \`~/.claude/projects/<slug>/*.jsonl\` transcripts. The raw text in each section is that output with the home directory masked.`,
  `- Latest \`@houserules/cli\` on npm at run time: **${latest}**, read once by \`assemble-local-report.mjs\`.`,
  '- No update rule applies, so the "Needed update to run report" bullet and the Summary column are dropped. No install was changed.',
  `- Header bullets each have one local source. Path is \`${mask(projectsRoot)}/<name>\`. Kit version, install time, and Modules come from \`.claude/houserules.manifest.json\` (\`kitVersion\`, \`installedAt\`, \`modules\`). Hooks wired comes from \`.claude/settings.json\`, one entry per event, matcher, and script name. Install style and houserules packages come from \`package.json\` and \`node_modules/@houserules/*/package.json\`, or from the \`plugins\` list of \`.claude/houserules.config.json\` where no installed copy exists. Report produced by CLI is the literal build version.`,
  '- A bullet with no local source is omitted, never filled.',
  '- Sessions and Turns in the Summary are read from each raw report: the `N session(s):` line and the `turns N` value on the `-- totals --` line.',
  '',
);
lines.push('## Summary', '');
lines.push(
  '| Project | Kit version (manifest) | Installed at | Report CLI | Behind latest? | Sessions | Turns | Modules |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
);
for (const p of projects) {
  const kv = p.manifest.kitVersion;
  const behind = verLt(kv, latest) ? `yes (${kv} → ${latest})` : 'no';
  lines.push(
    `| ${p.repo} | ${kv} | ${String(p.manifest.installedAt).slice(0, 10)} | ${REPORT_CLI} | ${behind} | ${fmt(p.sessions)} | ${fmt(p.turns)} | ${p.manifest.modules.length} |`,
  );
}
lines.push('', '## Older-version caveats', '');
const old = projects.filter((p) => verLt(p.manifest.kitVersion, OLDER_THAN));
if (old.length === 0) {
  lines.push(`- No install has a kit version older than ${OLDER_THAN}.`);
} else {
  for (const p of old) {
    lines.push(
      `- **${p.repo}**: kit version is **${p.manifest.kitVersion}**, and the report format is ${CLI_VERSION}.`,
    );
  }
}
lines.push('', '## Per-project reports', '');
for (const p of projects) {
  const m = p.manifest;
  lines.push(`### ${p.repo}`, '');
  lines.push(`- **Path:** \`${mask(join(projectsRoot, p.repo))}\``);
  lines.push(`- **Kit version:** ${m.kitVersion} (installed ${m.installedAt})`);
  lines.push(`- **Report produced by CLI:** ${REPORT_CLI}`);
  if (p.style) lines.push(`- **Install style:** ${p.style}`);
  if (p.packages) lines.push(`- **houserules packages:** ${p.packages}`);
  if (p.hooks.length)
    lines.push(`- **Hooks wired (${p.hooks.length}):** ${p.hooks.join(', ')}`);
  lines.push(`- **Modules (${m.modules.length}):** ${m.modules.join(', ')}`);
  lines.push('', '```text', mask(p.raw), '```', '');
}
const doc = lines.join('\n');

// Built-in check
const sections = doc.match(/^### /gm) ?? [];
if (sections.length !== REPOS.length)
  fail(`expected ${REPOS.length} project sections, found ${sections.length}`);
for (const p of projects) {
  const row = doc.split('\n').find((l) => l.startsWith(`| ${p.repo} |`));
  const cells = row.split('|').map((c) => c.trim());
  const rawSessions = /^(\d+) session\(s\):/m.exec(p.raw);
  const rawTurns = /^-- totals --\n\s+turns ([\d,]+)/m.exec(p.raw);
  const wantS = rawSessions ? rawSessions[1] : '0';
  const wantT = rawTurns ? rawTurns[1] : '0';
  if (cells[6].replace(/,/g, '') !== wantS)
    fail(`${p.repo}: Summary sessions ${cells[6]} != raw ${wantS}`);
  if (cells[7] !== fmt(wantT.replace(/,/g, '')))
    fail(`${p.repo}: Summary turns ${cells[7]} != raw ${wantT}`);
}
if (doc.includes(home)) fail('output contains the home path');
if (doc.includes(user)) fail('output contains the username');

writeFileSync(outPath, doc);
console.log(`wrote ${outPath} (${projects.length} projects, latest ${latest})`);
