/**
 * Extracts every lint-format-fix Stop run from Claude Code transcripts as `stop-runs@1`
 * JSON Lines on stdout. Read-only: it writes nothing but stdout and spawns only read-only
 * `git` commands.
 *
 * Usage, in both forms:
 *   node scripts/bench/field-stop-runs.mjs <repo>... [--projects-dir <dir>]
 *   node --input-type=module - <repo>... < scripts/bench/field-stop-runs.mjs
 *
 * One self-contained file, Node built-ins only, so it pipes over ssh. Each `<repo>` is a
 * repository's directory name. Sessions group by the git root of their recorded `cwd`.
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

const SCHEMA = 'stop-runs@1';
const OVER_BUDGET_MS = 90_000;
const AT_TIMEOUT_MS = 120_000;
const PAST_TIMEOUT_MS = 125_000;
const HEAD_BYTES = 262_144;
const ERROR_EXCERPT = 300;
const ATTACHMENT_WINDOW_MS = 10_000;
const MAX_HISTORY = 300;
const GIT_MAX_BUFFER = 512 * 1024 * 1024;
const NEWLINE_BYTE = 0x0a;
const PROJECTS_DIR_FLAG = '--projects-dir=';
const ERROR_PREFIX_OPEN = '[';
const ERROR_PREFIX_CLOSE = ']: ';

const FIXER_MESSAGES = new Set([
  'Running lint/format auto-fix',
  'Running lint:fix + format:fix',
]);
const FIXER_SCRIPT = 'lint-format-fix';
const EDIT_TOOLS = new Map([
  ['Edit', 'file_path'],
  ['MultiEdit', 'file_path'],
  ['Write', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
]);
const CHURN_COMMAND =
  /\bgit\s+(?:pull|switch|checkout)\b|\bgh\s+pr\s+checkout\b|\b(?:pnpm|npm|yarn|bun)\s+(?:install|i|add|ci)\b/;
const CLI_PACKAGE = '@houserules/cli';
const MANIFEST_PATH = '.claude/houserules.manifest.json';
const FIXER_PATH = '.claude/scripts/lint-format-fix.mjs';
const CONFIG_PATH = '.claude/houserules.config.json';

function parseArgs(argv) {
  const names = [];
  let projectsDir;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-') continue;
    if (arg === '--projects-dir') projectsDir = argv[++i];
    else if (arg.startsWith(PROJECTS_DIR_FLAG))
      projectsDir = arg.slice(PROJECTS_DIR_FLAG.length);
    else names.push(arg);
  }
  projectsDir ??= join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    'projects',
  );
  return { names, projectsDir };
}

const slugify = (text) => text.replace(/[^a-zA-Z0-9]/g, '-');

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.status === 0 ? result.stdout : null;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function gitRootOf(cwd) {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function headCwd(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const length = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const lines = buffer.subarray(0, length).toString('utf8').split('\n');
    for (const line of lines) {
      const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
      if (!match) continue;
      try {
        return JSON.parse(`"${match[1]}"`);
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Every transcript under the projects dir whose slug could hold one of the named repos. */
function listTranscripts(projectsDir, names) {
  const wanted = names.map(slugify);
  const found = [];
  let slugs;
  try {
    slugs = readdirSync(projectsDir);
  } catch {
    return found;
  }
  for (const slug of slugs.sort()) {
    if (!wanted.some((name) => slug.includes(name))) continue;
    const dir = join(projectsDir, slug);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (entry.endsWith('.jsonl')) {
        found.push({
          path: join(dir, entry),
          label: `${slug}/${entry}`,
          session: entry.replace(/\.jsonl$/, ''),
          subagent: false,
        });
        continue;
      }
      const subDir = join(dir, entry, 'subagents');
      if (!existsSync(subDir)) continue;
      let subs;
      try {
        subs = readdirSync(subDir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const sub of subs.sort())
        found.push({
          path: join(subDir, sub),
          label: `${slug}/${entry}/subagents/${sub}`,
          session: entry,
          subagent: true,
        });
    }
  }
  return found;
}

function isFixerEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  for (const field of [entry.statusMessage, entry.command]) {
    if (typeof field !== 'string') continue;
    if (FIXER_MESSAGES.has(field) || field.includes(FIXER_SCRIPT)) return true;
  }
  return false;
}

function bucketOf(ms) {
  if (ms === null) return 'unknown';
  if (ms < OVER_BUDGET_MS) return 'under';
  if (ms < AT_TIMEOUT_MS) return 'over-budget';
  if (ms < PAST_TIMEOUT_MS) return 'at-timeout';
  return 'past-timeout';
}

function isPrompt(record) {
  if (record.type !== 'user' || record.isMeta) return false;
  const content = record.message?.content;
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return !content.some((block) => block?.type === 'tool_result');
}

function remoteOf(url) {
  if (!url) return null;
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Splits a transcript into its parsed JSON records, each with the byte offset where its line starts. */
function readRecords(path) {
  const buffer = readFileSync(path);
  const records = [];
  let offset = 0;
  while (offset < buffer.length) {
    let end = buffer.indexOf(NEWLINE_BYTE, offset);
    if (end === -1) end = buffer.length;
    const lineStart = offset;
    offset = end + 1;
    if (end === lineStart) continue;
    let record;
    try {
      record = JSON.parse(buffer.toString('utf8', lineStart, end));
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    records.push({ record, lineStart });
  }
  return records;
}

/** The excerpts of a Stop summary's hook errors that came from the fixer. */
function hookErrorsOf(record, fixer) {
  const errors = Array.isArray(record.hookErrors) ? record.hookErrors : [];
  const prefixes = [fixer.statusMessage, fixer.command].filter(
    (candidate) => typeof candidate === 'string',
  );
  const hookErrors = [];
  for (const error of errors) {
    if (typeof error !== 'string') continue;
    const prefix = prefixes.find((candidate) =>
      error.startsWith(`${ERROR_PREFIX_OPEN}${candidate}${ERROR_PREFIX_CLOSE}`),
    );
    if (prefix !== undefined) {
      const bodyStart =
        ERROR_PREFIX_OPEN.length + prefix.length + ERROR_PREFIX_CLOSE.length;
      hookErrors.push(error.slice(bodyStart, bodyStart + ERROR_EXCERPT));
    } else if (error.includes(FIXER_SCRIPT)) {
      const cut = error.indexOf(ERROR_PREFIX_CLOSE);
      hookErrors.push(
        error
          .slice(cut === -1 ? 0 : cut + ERROR_PREFIX_CLOSE.length)
          .slice(0, ERROR_EXCERPT),
      );
    }
  }
  return hookErrors;
}

/** Matches each run to the nearest unused fixer Stop attachment in the same transcript. */
function matchAttachments(runs, attachments) {
  for (const run of runs) {
    run.attachment = null;
    if (run.tsMs === null) continue;
    let best;
    for (const candidate of attachments) {
      if (candidate.isUsed) continue;
      const gap = Math.abs(candidate.tsMs - run.tsMs);
      if (gap > ATTACHMENT_WINDOW_MS) continue;
      if (!best || gap < best.gap) best = { candidate, gap };
    }
    if (!best) continue;
    best.candidate.isUsed = true;
    const attachment = best.candidate.attachment;
    run.attachment = {
      type: attachment.type ?? null,
      exitCode:
        typeof attachment.exitCode === 'number' ? attachment.exitCode : null,
      stderr: attachment.stderr ?? null,
      stdout: attachment.stdout ?? null,
      durationMs:
        typeof attachment.durationMs === 'number'
          ? attachment.durationMs
          : null,
      content: attachment.content ?? null,
    };
  }
}

/**
 * Parses one transcript into its Stop runs. Offsets are byte positions of each line, so a
 * run's `transcriptBytes` is the file size before its record.
 */
function parseTranscript(info, root) {
  const runs = [];
  const attachments = [];
  let oldestMs = Infinity;
  let newestMs = -Infinity;
  let summaryRecords = 0;
  let turnPaths = new Set();
  let churn = 0;
  for (const { record, lineStart } of readRecords(info.path)) {
    const tsMs = Date.parse(record.timestamp ?? '');
    if (!Number.isNaN(tsMs)) {
      oldestMs = Math.min(oldestMs, tsMs);
      newestMs = Math.max(newestMs, tsMs);
    }

    if (isPrompt(record)) {
      turnPaths = new Set();
      continue;
    }
    if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
      for (const block of record.message.content) {
        if (block?.type !== 'tool_use') continue;
        const field = EDIT_TOOLS.get(block.name);
        if (field) {
          const path = block.input?.[field];
          if (typeof path === 'string' && path) turnPaths.add(path);
        } else if (
          block.name === 'Bash' &&
          typeof block.input?.command === 'string' &&
          CHURN_COMMAND.test(block.input.command)
        ) {
          churn += 1;
        }
      }
      continue;
    }
    if (record.type === 'attachment' && record.attachment) {
      const attachment = record.attachment;
      const isStop =
        attachment.hookEvent === 'Stop' ||
        (typeof attachment.hookName === 'string' &&
          attachment.hookName.startsWith('Stop'));
      if (isStop && isFixerEntry(attachment) && !Number.isNaN(tsMs))
        attachments.push({ tsMs, attachment, isUsed: false });
      continue;
    }
    if (record.type !== 'system' || record.subtype !== 'stop_hook_summary')
      continue;
    summaryRecords += 1;
    const infos = Array.isArray(record.hookInfos) ? record.hookInfos : [];
    const fixer = infos.find(isFixerEntry);
    if (!fixer) continue;
    const durationMs =
      typeof fixer.durationMs === 'number' ? fixer.durationMs : null;
    const paths = [...turnPaths].map((editedPath) =>
      editedPath.startsWith(root + sep)
        ? editedPath.slice(root.length + 1)
        : editedPath,
    );
    runs.push({
      file: info.label,
      session: info.session,
      tsMs: Number.isNaN(tsMs) ? null : tsMs,
      ts: Number.isNaN(tsMs) ? null : new Date(tsMs).toISOString(),
      durationMs,
      subagent: info.subagent || record.isSidechain === true,
      claudeVersion: typeof record.version === 'string' ? record.version : null,
      editedPaths: paths,
      transcriptBytes: lineStart,
      bashChurn: churn,
      hookErrors: hookErrorsOf(record, fixer),
    });
    churn = 0;
  }
  matchAttachments(runs, attachments);
  return { runs, summaryRecords, oldestMs, newestMs };
}

/** Commits touching `path`, oldest first, each with the file's text there (null if gone). */
function fileHistory(root, path) {
  const log = git(root, [
    'log',
    `--max-count=${MAX_HISTORY}`,
    '--format=%H%x09%cI',
    '--',
    path,
  ]);
  if (!log) return [];
  const versions = [];
  for (const line of log.split('\n').filter(Boolean).reverse()) {
    const [commit, date] = line.split('\t');
    const text = git(root, ['show', `${commit}:${path}`]);
    if (text !== null)
      versions.push({ commit, date, dateMs: Date.parse(date), text });
  }
  return versions;
}

function dedupe(items, keyOf) {
  const out = [];
  for (const item of items)
    if (!out.length || keyOf(out.at(-1)) !== keyOf(item)) out.push(item);
  return out;
}

function fixerHistory(root) {
  const versions = fileHistory(root, FIXER_PATH).map((v) => {
    const budget = /FIX_BUDGET_MS\s*=\s*([\d_]+)/.exec(v.text);
    return {
      commit: v.commit,
      date: v.date,
      dateMs: v.dateMs,
      fixBudgetMs: budget ? Number(budget[1].replaceAll('_', '')) : null,
      detached: /detached:\s*true/.test(v.text),
    };
  });
  return dedupe(versions, (v) => `${v.fixBudgetMs}|${v.detached}`);
}

function manifestHistory(root) {
  const versions = [];
  const add = (text, commit) => {
    try {
      const manifest = JSON.parse(text);
      if (typeof manifest?.kitVersion !== 'string') return;
      versions.push({
        kitVersion: manifest.kitVersion,
        installedAt:
          typeof manifest.installedAt === 'string'
            ? manifest.installedAt
            : null,
        installedAtMs: Date.parse(manifest.installedAt ?? ''),
        commit,
      });
    } catch {
      // A manifest version that does not parse carries no kit version.
    }
  };
  for (const v of fileHistory(root, MANIFEST_PATH)) add(v.text, v.commit);
  const current = readText(join(root, MANIFEST_PATH));
  if (current !== null) add(current, null);
  return dedupe(versions, (v) => `${v.kitVersion}|${v.installedAt}`);
}

function cliHistory(root) {
  const versions = fileHistory(root, 'package.json').map((v) => {
    let version = null;
    try {
      const pkg = JSON.parse(v.text);
      version =
        pkg.dependencies?.[CLI_PACKAGE] ??
        pkg.devDependencies?.[CLI_PACKAGE] ??
        pkg.peerDependencies?.[CLI_PACKAGE] ??
        null;
    } catch {
      // Unparseable package.json at that commit.
    }
    return { commit: v.commit, date: v.date, dateMs: v.dateMs, version };
  });
  return dedupe(versions, (v) => v.version);
}

function verifyDepsSetting(root) {
  const npmrc = readText(join(root, '.npmrc'));
  const fromNpmrc =
    npmrc && /^\s*verify-deps-before-run\s*=\s*(.+?)\s*$/m.exec(npmrc);
  if (fromNpmrc) return { value: fromNpmrc[1], file: '.npmrc' };
  const yaml = readText(join(root, 'pnpm-workspace.yaml'));
  const fromYaml =
    yaml && /^\s*verifyDepsBeforeRun\s*:\s*(.+?)\s*$/m.exec(yaml);
  if (fromYaml) return { value: fromYaml[1], file: 'pnpm-workspace.yaml' };
  return null;
}

function scriptTexts(dir, commands) {
  const scripts = readJson(join(dir, 'package.json'))?.scripts ?? {};
  const out = {};
  for (const command of commands)
    out[command] =
      typeof scripts[command] === 'string' ? scripts[command] : null;
  return out;
}

function commandsFor(target, globalCommands) {
  if (Array.isArray(target.fixCommands)) return target.fixCommands;
  if (target.fixCommands === null) return [];
  return globalCommands;
}

function repoFacts(root) {
  const config = readJson(join(root, CONFIG_PATH));
  const fix = config?.fix ?? null;
  const targets = Array.isArray(config?.targets) ? config.targets : [];
  const globalCommands = Array.isArray(fix?.commands) ? fix.commands : [];
  const targetScripts = {};
  for (const target of targets) {
    if (typeof target?.pathPrefix !== 'string') continue;
    targetScripts[target.pathPrefix] = scriptTexts(
      join(root, target.pathPrefix),
      commandsFor(target, globalCommands),
    );
  }
  const tracked = git(root, ['ls-files']);
  return {
    trackedFiles:
      tracked === null ? null : tracked.split('\n').filter(Boolean).length,
    fix,
    targets,
    scripts: {
      root: scriptTexts(root, globalCommands),
      targets: targetScripts,
    },
    verifyDepsBeforeRun: verifyDepsSetting(root),
    packageManager:
      readJson(join(root, 'package.json'))?.packageManager ?? null,
    remote: remoteOf(git(root, ['remote', 'get-url', 'origin'])),
    manifestHistory: manifestHistory(root),
    fixerHistory: fixerHistory(root),
    cliHistory: cliHistory(root),
  };
}

function fixerInForce(facts, tsMs) {
  if (tsMs === null) return { source: 'unknown' };
  const tracked = facts.fixerHistory.filter((v) => v.dateMs <= tsMs).at(-1);
  if (tracked)
    return {
      source: 'fixer-history',
      commit: tracked.commit,
      fixBudgetMs: tracked.fixBudgetMs,
      detached: tracked.detached,
    };
  const installed = facts.manifestHistory
    .filter((v) => !Number.isNaN(v.installedAtMs) && v.installedAtMs <= tsMs)
    .sort((a, b) => a.installedAtMs - b.installedAtMs)
    .at(-1);
  if (installed)
    return {
      source: 'manifest',
      kitVersion: installed.kitVersion,
      installedAt: installed.installedAt,
    };
  const cli = facts.cliHistory
    .filter((v) => v.version !== null && v.dateMs <= tsMs)
    .at(-1);
  if (cli) return { source: 'package-json', cliVersion: cli.version };
  return { source: 'unknown' };
}

function targetsOf(facts, paths) {
  const prefixes = facts.targets
    .map((target) => target?.pathPrefix)
    .filter((prefix) => typeof prefix === 'string');
  return prefixes.filter((prefix) =>
    paths.some((editedPath) => editedPath.startsWith(prefix)),
  );
}

function overlapCounts(runs) {
  const span = (run) => [run.tsMs - (run.durationMs ?? 0), run.tsMs];
  return runs.map((run) => {
    if (run.tsMs === null) return 0;
    const [start, end] = span(run);
    return runs.filter((other) => {
      if (other === run || other.tsMs === null) return false;
      if (other.session === run.session) return false;
      const [oStart, oEnd] = span(other);
      return oStart <= end && start <= oEnd;
    }).length;
  });
}

function groupByRoot(names, projectsDir) {
  const byRoot = new Map();
  for (const info of listTranscripts(projectsDir, names)) {
    const cwd = headCwd(info.path);
    if (!cwd) continue;
    const root = gitRootOf(cwd);
    if (!root || !names.includes(basename(root))) continue;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(info);
  }
  return byRoot;
}

function repoLine(root, facts, sessions) {
  return {
    kind: 'repo',
    schema: SCHEMA,
    repo: basename(root),
    root,
    remote: facts.remote,
    sessions,
    trackedFiles: facts.trackedFiles,
    fix: facts.fix,
    targets: facts.targets,
    scripts: facts.scripts,
    verifyDepsBeforeRun: facts.verifyDepsBeforeRun,
    packageManager: facts.packageManager,
    manifestHistory: facts.manifestHistory.map(
      ({ kitVersion, installedAt, commit }) => ({
        kitVersion,
        installedAt,
        commit,
      }),
    ),
    fixerHistory: facts.fixerHistory.map(
      ({ commit, date, fixBudgetMs, detached }) => ({
        commit,
        date,
        fixBudgetMs,
        detached,
      }),
    ),
    cliHistory: facts.cliHistory.map(({ commit, date, version }) => ({
      commit,
      date,
      version,
    })),
  };
}

function runLine(root, facts, run, overlappingRuns) {
  return {
    kind: 'run',
    schema: SCHEMA,
    repo: basename(root),
    remote: facts.remote,
    file: run.file,
    ts: run.ts,
    durationMs: run.durationMs,
    bucket: bucketOf(run.durationMs),
    subagent: run.subagent,
    claudeVersion: run.claudeVersion,
    editedPaths: run.editedPaths,
    targets: targetsOf(facts, run.editedPaths),
    transcriptBytes: run.transcriptBytes,
    bashChurn: run.bashChurn,
    overlappingRuns,
    fixerInForce: fixerInForce(facts, run.tsMs),
    hookErrors: run.hookErrors,
    attachment: run.attachment,
  };
}

function metaLine(names, { transcripts, summaryRecords, oldestMs, newestMs }) {
  const stamp = (ms) =>
    Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  return {
    kind: 'meta',
    schema: SCHEMA,
    generated: new Date().toISOString(),
    node: process.version,
    repos: names,
    transcripts,
    oldest: stamp(oldestMs),
    newest: stamp(newestMs),
    summaryRecords,
  };
}

function main() {
  const { names, projectsDir } = parseArgs(process.argv.slice(2));
  const byRoot = groupByRoot(names, projectsDir);

  const repoLines = [];
  const runLines = [];
  let oldestMs = Infinity;
  let newestMs = -Infinity;
  let transcripts = 0;
  let summaryRecords = 0;
  for (const root of [...byRoot.keys()].sort()) {
    const facts = repoFacts(root);
    const parsed = [];
    for (const info of byRoot.get(root)) {
      try {
        parsed.push(parseTranscript(info, root));
      } catch {
        continue;
      }
      transcripts += 1;
    }
    const runs = parsed.flatMap((transcript) => transcript.runs);
    for (const transcript of parsed) {
      summaryRecords += transcript.summaryRecords;
      oldestMs = Math.min(oldestMs, transcript.oldestMs);
      newestMs = Math.max(newestMs, transcript.newestMs);
    }
    const overlaps = overlapCounts(runs);
    repoLines.push(repoLine(root, facts, byRoot.get(root).length));
    runs.forEach((run, i) => {
      runLines.push(runLine(root, facts, run, overlaps[i]));
    });
  }
  runLines.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));

  const meta = metaLine(names, {
    transcripts,
    summaryRecords,
    oldestMs,
    newestMs,
  });
  const lines = [meta, ...repoLines, ...runLines];
  process.stdout.write(
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
  );
}

main();
