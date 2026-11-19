#!/usr/bin/env node
/**
 * Checks an `agent-ledger@2` file (an `@1` file is read on its older flat 1.25 basis). Three checks, exit 1 on any failure.
 *
 * (a) Per repo, `repos[].turns` and `repos[].weightedInput` against the `-- totals --` turns
 *     and cost-weighted input-equivalent of `<reports>/local-report-<repo>.txt`. A difference passes only
 *     when every session it comes from is traced to one record class: a session whose main or
 *     subagent transcript was modified after the report file was written. A traced difference
 *     names each such session and its own turn and weighted-input difference.
 * (b) Per repo, the rows with `agentType` `phase-orchestrator` against
 *     `grep -l '"agentType":"phase-orchestrator"'` over that slug's subagent meta files.
 * (c) `agent-ledger.mjs` copied alone into a fresh temp directory runs on the first ledger repo
 *     and exits 0.
 *
 * Usage: node check-agent-ledger.mjs --ledger <file> --reports <dir> --projects-root <dir>
 *
 * `--projects-root` holds one install per repo name, as the ledger run was given them. Every
 * flag is required. Exit codes: 0 all checks pass, 1 a check fails, 2 bad usage.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_READ_WEIGHT = 0.1;
const CACHE_WRITE_WEIGHT = 1.25;
const CACHE_WRITE_1H_WEIGHT = 2;
const PROJECT_DIR_NAME_MAX_LENGTH = 200;
const ORCHESTRATOR_PATTERN = '"agentType":"phase-orchestrator"';

const USAGE =
  'usage: node check-agent-ledger.mjs --ledger <file> --reports <dir> --projects-root <dir>';
const flagValue = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const ledgerPath = flagValue('--ledger');
const reportsDir = flagValue('--reports');
const projectsRoot = flagValue('--projects-root');
if (!ledgerPath || !reportsDir || !projectsRoot) {
  console.error(
    `check-agent-ledger: missing --ledger, --reports, or --projects-root\n${USAGE}`,
  );
  process.exit(2);
}
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
if (!['agent-ledger@1', 'agent-ledger@2'].includes(ledger.schema)) {
  console.error(`check-agent-ledger: unsupported schema ${ledger.schema}`);
  process.exit(2);
}
const projectsDir = join(
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  'projects',
);
const failures = [];

const toNumber = (text) => Number(text.replaceAll(',', ''));
const weightedInput = (tokens) =>
  Math.round(
    tokens.input +
      (tokens.cacheWrite - (tokens.cacheWrite1h ?? 0)) * CACHE_WRITE_WEIGHT +
      (tokens.cacheWrite1h ?? 0) * CACHE_WRITE_1H_WEIGHT +
      tokens.cacheRead * CACHE_READ_WEIGHT,
  );

function slugDirOf(repo) {
  const encoded = join(resolve(projectsRoot), repo).replace(
    /[^A-Za-z0-9]/g,
    '-',
  );
  if (encoded.length < PROJECT_DIR_NAME_MAX_LENGTH)
    return join(projectsDir, encoded);
  const prefix = encoded.slice(0, PROJECT_DIR_NAME_MAX_LENGTH);
  const found = readdirSync(projectsDir).filter((name) =>
    name.startsWith(prefix),
  );
  return join(projectsDir, found.length === 1 ? found[0] : prefix);
}

function parseReport(text) {
  const totalsAt = text.indexOf('-- totals --');
  const totals = text.slice(totalsAt);
  const turns = /turns ([\d,]+) \|/.exec(totals);
  const weighted = /cost-weighted input-equivalent: ([\d,]+)/.exec(totals);
  const sessions = new Map();
  for (const match of text
    .slice(0, totalsAt)
    .matchAll(/^ {2}([0-9a-f]{8}) {2}turns (\d+) .*?weighted-in ([\d,]+)/gm))
    sessions.set(match[1], {
      turns: Number(match[2]),
      weightedInput: toNumber(match[3]),
    });
  return {
    turns: turns ? toNumber(turns[1]) : undefined,
    weightedInput: weighted ? toNumber(weighted[1]) : undefined,
    sessions,
  };
}

function ledgerSessions(repo) {
  const sessions = new Map();
  for (const row of ledger.rows) {
    if (row.repo !== repo) continue;
    const session = sessions.get(row.session) ?? {
      turns: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
    };
    session.turns += row.turns;
    session.input += row.tokens.input;
    session.cacheRead += row.tokens.cacheRead;
    session.cacheWrite += row.tokens.cacheWrite;
    session.cacheWrite1h += row.tokens.cacheWrite1h ?? 0;
    sessions.set(row.session, session);
  }
  return sessions;
}

/** Latest mtime across a session's main transcript and its subagent transcripts. */
function sessionMtime(slugDir, session) {
  const mainFile = readdirSync(slugDir).find(
    (name) => name.startsWith(session) && name.endsWith('.jsonl'),
  );
  if (!mainFile) return 0;
  let latest = statSync(join(slugDir, mainFile)).mtimeMs;
  const subagentDir = join(
    slugDir,
    mainFile.replace(/\.jsonl$/, ''),
    'subagents',
  );
  if (existsSync(subagentDir))
    for (const name of readdirSync(subagentDir))
      if (name.endsWith('.jsonl'))
        latest = Math.max(latest, statSync(join(subagentDir, name)).mtimeMs);
  return latest;
}

function checkTotals(summary) {
  const reportFile = join(reportsDir, `local-report-${summary.repo}.txt`);
  const report = parseReport(readFileSync(reportFile, 'utf8'));
  const turnDiff = summary.turns - report.turns;
  const weightedDiff = summary.weightedInput - report.weightedInput;
  console.log(
    `(a) ${summary.repo}: turns ledger ${summary.turns} report ${report.turns} diff ${turnDiff} | ` +
      `weightedInput ledger ${summary.weightedInput} report ${report.weightedInput} diff ${weightedDiff}`,
  );
  if (turnDiff === 0 && weightedDiff === 0) return;
  const reportWrittenAt = statSync(reportFile).mtimeMs;
  const slugDir = slugDirOf(summary.repo);
  const untraced = [];
  for (const [session, sums] of ledgerSessions(summary.repo)) {
    const reported = report.sessions.get(session) ?? {
      turns: 0,
      weightedInput: 0,
    };
    const sessionTurnDiff = sums.turns - reported.turns;
    const sessionWeightedDiff = weightedInput(sums) - reported.weightedInput;
    if (sessionTurnDiff === 0 && sessionWeightedDiff === 0) continue;
    const changedAfter = sessionMtime(slugDir, session) > reportWrittenAt;
    console.log(
      `    session ${session}: turns diff ${sessionTurnDiff} weightedInput diff ${sessionWeightedDiff} ` +
        (changedAfter
          ? 'traced: transcript modified after the report was written'
          : 'UNTRACED'),
    );
    if (!changedAfter) untraced.push(session);
  }
  for (const session of report.sessions.keys())
    if (!ledgerSessions(summary.repo).has(session)) {
      console.log(
        `    session ${session}: in the report, missing from the ledger, UNTRACED`,
      );
      untraced.push(session);
    }
  if (untraced.length)
    failures.push(
      `(a) ${summary.repo}: ${untraced.length} untraced session difference(s)`,
    );
}

function grepOrchestratorMetas(slugDir) {
  const result = spawnSync(
    'grep',
    ['-rl', '--include=*.meta.json', ORCHESTRATOR_PATTERN, slugDir],
    { encoding: 'utf8' },
  );
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`grep exited ${result.status}: ${result.stderr}`);
  return result.stdout.split('\n').filter(Boolean).length;
}

function checkOrchestrators(summary) {
  const ledgerCount = ledger.rows.filter(
    (row) =>
      row.repo === summary.repo && row.agentType === 'phase-orchestrator',
  ).length;
  const grepCount = grepOrchestratorMetas(slugDirOf(summary.repo));
  console.log(
    `(b) ${summary.repo}: phase-orchestrator rows ${ledgerCount} grep -l ${grepCount}`,
  );
  if (ledgerCount !== grepCount)
    failures.push(
      `(b) ${summary.repo}: ${ledgerCount} rows against ${grepCount} meta files`,
    );
}

function checkStandaloneCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ledger-'));
  const script = join(dir, 'agent-ledger.mjs');
  copyFileSync(join(HERE, 'agent-ledger.mjs'), script);
  const out = join(dir, 'ledger.json');
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        script,
        '--machine',
        'local',
        '--out',
        out,
        join(resolve(projectsRoot), ledger.repos[0].repo),
      ],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    console.log(
      `(c) standalone copy in ${dir}: exit 0, ${stdout.trim().split('\n').at(-1)}`,
    );
  } catch (error) {
    console.log(`(c) standalone copy in ${dir}: exit ${error.status}`);
    console.log(String(error.stderr ?? '').trim());
    failures.push(`(c) standalone copy exited ${error.status}`);
  }
}

for (const summary of ledger.repos) checkTotals(summary);
for (const summary of ledger.repos) checkOrchestrators(summary);
checkStandaloneCopy();

if (failures.length) {
  console.log(`FAIL: ${failures.length} check(s)`);
  for (const failure of failures) console.log(`  ${failure}`);
  process.exit(1);
}
console.log('PASS: all checks');
