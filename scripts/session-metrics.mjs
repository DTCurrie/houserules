#!/usr/bin/env node
/**
 * Dev-only session-metrics analyzer, never published. Reads Claude Code transcripts under
 * ~/.claude/projects/<slug>/ and prints hook-health and guard-efficacy tables, so toolset
 * behavior (crashing hooks, blocked commands) is measured rather than guessed.
 *
 * Usage: `node scripts/session-metrics.mjs [--slug <dir>]... [--corpus <name>=<dir>,<dir>]...`
 *
 * The default corpus is the cwd's git top encoded the way Claude Code encodes it (slashes
 * become dashes). Each `--slug` merges another transcript dir into that default corpus: a
 * repo's pre-rename history, or a sub-directory cwd that got its own dir. Each `--corpus`
 * instead names a corpus explicitly and replaces the default, so one invocation can compare
 * several projects; with more than one corpus a combined view is appended. Repo-dependent
 * sections (installed skills, outcome checks) resolve each corpus's repo root from the cwds
 * its transcripts recorded, and are skipped when no recorded cwd still exists on disk.
 *
 * The transcript format is Claude Code internal and unversioned, so every line parses
 * defensively: a bad line is skipped and counted, never thrown on. Hook attachments appear
 * only when a hook emitted output, so denominators come from counting tool_use events.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const COMMAND_PREVIEW_LENGTH = 200;

// A /changeset fire counts as landed when a .changeset file was git-added within this window.
// Wide because the user commits after the session, sometimes days later.
const CHANGESET_MATCH_WINDOW_MS = 72 * 60 * 60 * 1000;

// A ledger-writing skill fire counts as landed when an entry appears within this window,
// used only for entries too old to carry the `chat` session-id field.
const LEDGER_MATCH_WINDOW_MS = 30 * 60 * 1000;

// Two adjacent Bash commands at or above this bigram-dice similarity count as a retry.
const RETRY_SIMILARITY = 0.9;

const BULK_TOP_N = 10;
const RETRY_TOP_N = 5;

// How the harness encodes a user's permission denial and an interrupt inside a tool_result.
const DENIAL_PREFIX = "The user doesn't want to proceed with this tool use";
const INTERRUPT_PREFIX = '[Request interrupted by user';

// How a user-typed slash command appears inside a user message.
const COMMAND_NAME_PATTERN = /<command-name>\/([a-z0-9-]+)<\/command-name>/g;

// A non-zero hook exit whose stderr carries any of these is the hook itself failing,
// not the hook doing its job. Grounded in the houserules corpus, where every non-zero
// PreToolUse exit was a missing-module crash from the pre-rename install.
const CRASH_SIGNS = [
  'Cannot find module',
  'node:internal',
  'Node.js v',
  'throw err',
];

function parseArgs(argv) {
  const corpora = [];
  const extraSlugs = [];
  const fail = (message) => {
    console.error(message);
    console.error(
      'usage: session-metrics.mjs [--slug <dir>]... [--corpus <name>=<dir>,<dir>]...',
    );
    process.exit(1);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === '--slug') {
      if (!value) fail('--slug needs a transcript dir name');
      extraSlugs.push(value);
      i += 1;
    } else if (argv[i] === '--corpus') {
      const [name, list] = (value ?? '').split('=');
      if (!name || !list) fail('--corpus needs <name>=<dir>[,<dir>...]');
      corpora.push({ name, slugs: list.split(',').filter(Boolean) });
      i += 1;
    } else {
      fail(`unknown argument: ${argv[i]}`);
    }
  }
  return { corpora, extraSlugs };
}

function repoRoot() {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  return git.status === 0 ? git.stdout.trim() : process.cwd();
}

function projectsDir() {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return join(base, 'projects');
}

// One pass over every line of every session file, extracting only the small event shapes
// the metrics need. Nothing here holds a full transcript record past its own line.
function readCorpus(spec) {
  const corpus = {
    name: spec.name,
    slugs: spec.slugs,
    files: 0,
    lines: 0,
    skippedLines: 0,
    missingDirs: [],
    sessions: new Map(),
    cwdCounts: new Map(),
    seenCommandUuids: new Set(),
    root: null,
  };
  for (const slug of spec.slugs) {
    const dir = join(projectsDir(), slug);
    if (!existsSync(dir)) {
      corpus.missingDirs.push(dir);
      continue;
    }
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
    for (const file of files) {
      corpus.files += 1;
      let text;
      try {
        text = readFileSync(join(dir, file), 'utf8');
      } catch {
        corpus.skippedLines += 1;
        continue;
      }
      const fallbackSession = file.replace(/\.jsonl$/, '');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        corpus.lines += 1;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          corpus.skippedLines += 1;
          continue;
        }
        extractEvents(record, fallbackSession, corpus);
      }
    }
  }
  corpus.root = resolveRoot(corpus);
  return corpus;
}

// The transcripts themselves say where the repo lived: every record carries a cwd. The
// most common one still on disk wins, so a corpus whose directory was renamed away
// (pre-rename history) resolves to nothing and repo-dependent sections skip.
function resolveRoot(corpus) {
  const ranked = [...corpus.cwdCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [cwd] of ranked) {
    if (!existsSync(cwd)) continue;
    const git = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    });
    if (git.status === 0) return git.stdout.trim();
  }
  return null;
}

function combineCorpora(list) {
  const combined = {
    name: 'combined',
    slugs: list.flatMap((corpus) => corpus.slugs),
    files: 0,
    lines: 0,
    skippedLines: 0,
    missingDirs: [],
    sessions: new Map(),
    cwdCounts: new Map(),
    seenCommandUuids: new Set(),
    root: null,
  };
  for (const corpus of list) {
    combined.files += corpus.files;
    combined.lines += corpus.lines;
    combined.skippedLines += corpus.skippedLines;
    combined.missingDirs.push(...corpus.missingDirs);
    for (const [id, session] of corpus.sessions)
      combined.sessions.set(id, session);
  }
  return combined;
}

function sessionOf(corpus, id) {
  let session = corpus.sessions.get(id);
  if (!session) {
    session = {
      hookFires: [],
      toolUses: [],
      toolUseIndexById: new Map(),
      toolResults: [],
      commandFires: [],
      interrupts: 0,
    };
    corpus.sessions.set(id, session);
  }
  return session;
}

function extractEvents(record, fallbackSession, corpus) {
  const session = sessionOf(corpus, record.sessionId ?? fallbackSession);
  if (typeof record.cwd === 'string')
    corpus.cwdCounts.set(
      record.cwd,
      (corpus.cwdCounts.get(record.cwd) ?? 0) + 1,
    );
  const attachment = record.attachment;
  if (record.type === 'attachment' && attachment?.hookName) {
    session.hookFires.push({
      hookName: attachment.hookName,
      exitCode: attachment.exitCode,
      stderr: attachment.stderr ?? '',
      content: attachment.content ?? '',
      durationMs: attachment.durationMs,
      toolUseID: attachment.toolUseID,
      afterToolUseCount: session.toolUses.length,
    });
    return;
  }
  const message = record.message;
  if (record.type === 'user') scanUserCommands(record, session, corpus);
  if (record.type === 'user' && Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (block?.type === 'tool_result') {
        const parts = textParts(block.content);
        session.toolResults.push({
          toolUseId: block.tool_use_id,
          bytes: JSON.stringify(block.content ?? '').length,
          denied: parts.some((part) => part.startsWith(DENIAL_PREFIX)),
          interrupted: parts.some((part) => part.startsWith(INTERRUPT_PREFIX)),
        });
      } else if (
        block?.type === 'text' &&
        typeof block.text === 'string' &&
        block.text.startsWith(INTERRUPT_PREFIX)
      ) {
        // An interrupt lands as a text block in the user message, not as a tool_result.
        session.interrupts += 1;
      }
    }
    return;
  }
  if (record.type !== 'assistant' || !Array.isArray(message?.content)) return;
  for (const block of message.content) {
    if (block?.type !== 'tool_use') continue;
    const command =
      typeof block.input?.command === 'string'
        ? block.input.command.slice(0, COMMAND_PREVIEW_LENGTH)
        : '';
    session.toolUseIndexById.set(block.id, session.toolUses.length);
    session.toolUses.push({
      id: block.id,
      name: block.name,
      command,
      skill:
        block.name === 'Skill' && typeof block.input?.skill === 'string'
          ? block.input.skill
          : undefined,
      ts: Date.parse(record.timestamp ?? '') || undefined,
      isSidechain: record.isSidechain === true,
    });
  }
}

// A slash command the USER types injects the skill directly and never produces a Skill
// tool call, so it is only countable from the <command-name> block in the user message.
// Resumed sessions copy prior messages forward, so fires dedupe on the message uuid.
function scanUserCommands(record, session, corpus) {
  if (record.isMeta === true) return;
  if (typeof record.uuid === 'string') {
    if (corpus.seenCommandUuids.has(record.uuid)) return;
    corpus.seenCommandUuids.add(record.uuid);
  }
  for (const text of textParts(record.message?.content))
    for (const match of text.matchAll(COMMAND_NAME_PATTERN))
      session.commandFires.push({
        skill: match[1],
        ts: Date.parse(record.timestamp ?? '') || undefined,
      });
}

function textParts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text);
}

function isCrash(fire) {
  const text = `${fire.stderr}\n${fire.content}`;
  return CRASH_SIGNS.some((sign) => text.includes(sign));
}

function crashSignature(fire) {
  const match = `${fire.stderr}\n${fire.content}`.match(
    /Cannot find module '([^']+)'/,
  );
  if (match) return `Cannot find module '${match[1]}'`;
  const firstLine = fire.stderr.split('\n').find((l) => l.trim());
  return firstLine?.trim().slice(0, 100) ?? '(empty stderr)';
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
}

function hookHealth(corpus) {
  const byHook = new Map();
  const crashSignatures = new Map();
  for (const session of corpus.sessions.values()) {
    for (const fire of session.hookFires) {
      let row = byHook.get(fire.hookName);
      if (!row) {
        row = { fires: 0, nonZero: 0, crashes: 0, blocks: 0, durations: [] };
        byHook.set(fire.hookName, row);
      }
      row.fires += 1;
      if (typeof fire.durationMs === 'number')
        row.durations.push(fire.durationMs);
      if (!fire.exitCode) continue;
      row.nonZero += 1;
      if (isCrash(fire)) {
        row.crashes += 1;
        const sig = crashSignature(fire);
        crashSignatures.set(sig, (crashSignatures.get(sig) ?? 0) + 1);
      } else {
        row.blocks += 1;
      }
    }
  }
  for (const row of byHook.values()) row.durations.sort((a, b) => a - b);
  return { byHook, crashSignatures };
}

// A genuine block is a non-zero, non-crash PreToolUse exit. For each one, what the model
// did next in that session: gave-up (no later Bash call), retried (next Bash call starts
// with the same word), or diverted (next Bash call does something else).
function guardEfficacy(corpus) {
  const blocks = [];
  for (const [sessionId, session] of corpus.sessions) {
    for (const fire of session.hookFires) {
      if (!fire.hookName.startsWith('PreToolUse')) continue;
      if (!fire.exitCode || isCrash(fire)) continue;
      const knownIndex = session.toolUseIndexById.get(fire.toolUseID);
      const blockedIndex = knownIndex ?? fire.afterToolUseCount - 1;
      const blocked =
        knownIndex === undefined ? undefined : session.toolUses[knownIndex];
      const next = session.toolUses
        .slice(blockedIndex + 1)
        .find((use) => use.name === 'Bash');
      blocks.push({
        session: sessionId.slice(0, 8),
        blockedCommand: blocked?.command ?? '(tool_use not found)',
        nextCommand: next?.command,
        aftermath: aftermathOf(blocked, next),
      });
    }
  }
  return blocks;
}

function aftermathOf(blocked, next) {
  if (!next) return 'gave-up';
  if (!blocked) return 'unknown';
  const firstWord = (command) => command.trim().split(/\s+/)[0] ?? '';
  return firstWord(next.command) === firstWord(blocked.command)
    ? 'retried'
    : 'diverted';
}

function skillFires(corpus, skillName) {
  const fires = [];
  for (const [sessionId, session] of corpus.sessions) {
    for (const use of session.toolUses)
      if (use.skill && (!skillName || use.skill === skillName))
        fires.push({
          skill: use.skill,
          ts: use.ts,
          sessionId,
          source: 'model',
        });
    for (const fire of session.commandFires)
      if (!skillName || fire.skill === skillName)
        fires.push({
          skill: fire.skill,
          ts: fire.ts,
          sessionId,
          source: 'user',
        });
  }
  return fires;
}

function skillAdoption(corpus, skillsDir) {
  const counts = new Map();
  for (const fire of skillFires(corpus)) {
    const row = counts.get(fire.skill) ?? { model: 0, user: 0 };
    row[fire.source] += 1;
    counts.set(fire.skill, row);
  }
  const installed = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  const dead = installed.filter((name) => !counts.has(name));
  return { counts, installed, dead };
}

// A /changeset fire landed if git history shows a .changeset/*.md file added within the
// match window after it. Commit time is the only durable trace: the files themselves are
// deleted again at release, and they carry no session id.
function changesetOutcome(corpus, root) {
  const log = spawnSync(
    'git',
    [
      'log',
      '--diff-filter=A',
      '--format=COMMIT %ct',
      '--name-only',
      '--',
      '.changeset',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const addTimes = [];
  let filesAdded = 0;
  let commitMs = 0;
  for (const line of (log.stdout ?? '').split('\n')) {
    if (line.startsWith('COMMIT ')) {
      commitMs = Number(line.slice('COMMIT '.length)) * 1000;
    } else if (line.endsWith('.md') && !line.endsWith('README.md')) {
      filesAdded += 1;
      addTimes.push(commitMs);
    }
  }
  const fires = skillFires(corpus, 'changeset');
  const matched = fires.filter(
    (fire) =>
      fire.ts &&
      addTimes.some(
        (added) =>
          added >= fire.ts && added <= fire.ts + CHANGESET_MATCH_WINDOW_MS,
      ),
  ).length;
  return { fires: fires.length, matched, filesAdded };
}

// A ledger-writing skill fire landed if the ledger holds an `add` entry from the same
// session (`chat` field, exact) or within the match window (older entries, heuristic).
// Each entry matches at most one fire.
function ledgerOutcome(corpus, ledgerPath, skillName) {
  const entries = [];
  if (existsSync(ledgerPath)) {
    for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.action === 'add')
          entries.push({
            ts: Date.parse(entry.ts ?? '') || undefined,
            chat: entry.chat,
            used: false,
          });
      } catch {
        // A ledger line that does not parse is someone else's defect to report, not this script's to throw on.
      }
    }
  }
  const fires = skillFires(corpus, skillName);
  let matched = 0;
  for (const fire of fires) {
    const entry = entries.find(
      (candidate) =>
        !candidate.used &&
        (candidate.chat === fire.sessionId ||
          (candidate.ts &&
            fire.ts &&
            Math.abs(candidate.ts - fire.ts) <= LEDGER_MATCH_WINDOW_MS)),
    );
    if (!entry) continue;
    entry.used = true;
    matched += 1;
  }
  return { fires: fires.length, matched, totalAdds: entries.length };
}

function bigramCounts(text) {
  const counts = new Map();
  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

// Dice coefficient over character bigrams: cheap, order-tolerant, and good enough to
// call two command lines "the same command again" without a real edit distance.
function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const aCounts = bigramCounts(a);
  const bCounts = bigramCounts(b);
  let shared = 0;
  let total = 0;
  for (const [gram, count] of aCounts) {
    total += count;
    if (bCounts.has(gram)) shared += Math.min(count, bCounts.get(gram));
  }
  for (const count of bCounts.values()) total += count;
  return total ? (2 * shared) / total : 1;
}

function frictionSignals(corpus) {
  const compactedSessions = [];
  const bulkByTool = new Map();
  const retryRuns = [];
  const denials = [];
  let interrupts = 0;
  for (const [sessionId, session] of corpus.sessions) {
    interrupts += session.interrupts;
    if (session.hookFires.some((f) => f.hookName === 'SessionStart:compact'))
      compactedSessions.push(sessionId.slice(0, 8));

    for (const result of session.toolResults) {
      const index = session.toolUseIndexById.get(result.toolUseId);
      const use = index === undefined ? undefined : session.toolUses[index];
      const tool = use?.name ?? '(unmatched)';
      const row = bulkByTool.get(tool) ?? { results: 0, bytes: 0 };
      row.results += 1;
      row.bytes += result.bytes;
      bulkByTool.set(tool, row);
      if (result.denied) denials.push({ tool, command: use?.command ?? '' });
      else if (result.interrupted) interrupts += 1;
    }

    // Sidechain Bash calls interleave arbitrarily with the main chain and each other in
    // file order, so adjacency is only meaningful on the main chain.
    const bashCommands = session.toolUses
      .filter((use) => use.name === 'Bash' && !use.isSidechain)
      .map((use) => use.command.trim().replace(/\s+/g, ' '));
    let runLength = 1;
    for (let i = 1; i <= bashCommands.length; i += 1) {
      const isNear =
        i < bashCommands.length &&
        similarity(bashCommands[i - 1], bashCommands[i]) >= RETRY_SIMILARITY;
      if (isNear) {
        runLength += 1;
        continue;
      }
      if (runLength >= 2)
        retryRuns.push({
          session: sessionId.slice(0, 8),
          length: runLength,
          command: bashCommands[i - 1].slice(0, 80),
        });
      runLength = 1;
    }
  }
  return { compactedSessions, bulkByTool, retryRuns, denials, interrupts };
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
  );
  const line = (cells) =>
    `  ${cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')}`;
  console.log(line(headers));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const row of rows) console.log(line(row));
}

function report(corpus) {
  console.log(`\n=== session-metrics — ${corpus.name} ===\n`);
  console.log(`transcript dirs: ${corpus.slugs.join(', ')}`);
  console.log(`repo root: ${corpus.root ?? '(none still on disk)'}`);
  console.log(
    `sessions ${corpus.sessions.size} | files ${corpus.files} | lines ${corpus.lines} | skipped ${corpus.skippedLines}`,
  );
  for (const dir of corpus.missingDirs)
    console.log(`(no transcripts at ${dir})`);

  let bashCalls = 0;
  for (const session of corpus.sessions.values())
    bashCalls += session.toolUses.filter((use) => use.name === 'Bash').length;

  const { byHook, crashSignatures } = hookHealth(corpus);
  console.log('\n-- hook health --\n');
  const rows = [...byHook.entries()]
    .sort((a, b) => b[1].fires - a[1].fires)
    .map(([hook, row]) => [
      hook,
      row.fires,
      row.nonZero,
      row.crashes,
      row.blocks,
      percentile(row.durations, 50),
      percentile(row.durations, 95),
      row.durations.at(-1) ?? 0,
    ]);
  renderTable(
    [
      'hook',
      'fires',
      'non-zero',
      'crashes',
      'blocks',
      'p50ms',
      'p95ms',
      'maxms',
    ],
    rows,
  );
  console.log(
    `\n  (fires counts recorded attachments, which exist only when a hook emitted output.` +
      `\n   For scale: this corpus holds ${bashCalls} Bash tool calls.)`,
  );
  if (crashSignatures.size) {
    console.log('\n  crash signatures:');
    for (const [sig, count] of [...crashSignatures.entries()].sort(
      (a, b) => b[1] - a[1],
    ))
      console.log(`    ${String(count).padStart(4)}  ${sig}`);
  }

  const blocks = guardEfficacy(corpus);
  console.log('\n-- guard efficacy --\n');
  if (!blocks.length) {
    console.log(
      '  no genuine blocks in this corpus (every non-zero PreToolUse exit was a hook crash)',
    );
  } else {
    for (const block of blocks) {
      console.log(`  ${block.session}  [${block.aftermath}]`);
      console.log(`    blocked: ${block.blockedCommand}`);
      if (block.nextCommand) console.log(`    next:    ${block.nextCommand}`);
    }
  }

  const { counts, installed, dead } = skillAdoption(
    corpus,
    corpus.root ? join(corpus.root, '.claude', 'skills') : '',
  );
  console.log('\n-- skills --\n');
  if (counts.size) {
    const total = (row) => row.model + row.user;
    renderTable(
      ['skill', 'model', 'user', 'total'],
      [...counts.entries()]
        .sort((a, b) => total(b[1]) - total(a[1]))
        .map(([skill, row]) => [skill, row.model, row.user, total(row)]),
    );
    console.log(
      '\n  (model = Skill tool invocations; user = typed slash commands, built-ins included)',
    );
  } else {
    console.log('  no skill fires in this corpus');
  }
  if (installed.length)
    console.log(
      `\n  dead skills (installed, zero fires): ${dead.length ? dead.join(', ') : 'none'}`,
    );

  if (corpus.root) {
    console.log('\n  outcomes:');
    const changesets = changesetOutcome(corpus, corpus.root);
    console.log(
      `    /changeset:   fired ${changesets.fires}, a .changeset file was git-added within 72h for ${changesets.matched}` +
        ` (${changesets.filesAdded} files added across history)`,
    );
    for (const [skillName, ledgerFile] of [
      ['backlog-add', 'backlog.jsonl'],
      ['decide', 'decisions.jsonl'],
    ]) {
      const outcome = ledgerOutcome(
        corpus,
        join(corpus.root, '.claude', 'ledgers', ledgerFile),
        skillName,
      );
      console.log(
        `    /${skillName}:`.padEnd(18) +
          `fired ${outcome.fires}, matched a ledger add for ${outcome.matched}` +
          ` (${outcome.totalAdds} adds in the local ledger)`,
      );
    }
    console.log(
      '    (ledger rates undercount where sync to GitHub Projects has pruned the local .jsonl)',
    );
  } else {
    console.log('\n  outcomes: skipped, no live repo root to check against');
  }

  const friction = frictionSignals(corpus);
  console.log('\n-- friction --\n');
  console.log(
    `  compaction: ${friction.compactedSessions.length} session(s) resumed from auto-compact` +
      (friction.compactedSessions.length
        ? ` (${friction.compactedSessions.join(', ')})`
        : ''),
  );
  console.log('\n  tool_result bulk (top by bytes):');
  renderTable(
    ['tool', 'results', 'bytes'],
    [...friction.bulkByTool.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, BULK_TOP_N)
      .map(([tool, row]) => [
        tool,
        row.results,
        row.bytes.toLocaleString('en-US'),
      ]),
  );
  const retriedCalls = friction.retryRuns.reduce(
    (sum, run) => sum + run.length - 1,
    0,
  );
  console.log(
    `\n  bash retries (main chain, adjacent commands >= ${RETRY_SIMILARITY} similar): ` +
      `${friction.retryRuns.length} runs, ${retriedCalls} repeated calls`,
  );
  for (const run of [...friction.retryRuns]
    .sort((a, b) => b.length - a.length)
    .slice(0, RETRY_TOP_N))
    console.log(`    ${run.session}  x${run.length}  ${run.command}`);
  console.log(
    `\n  denials: ${friction.denials.length} tool use(s) rejected by the user, ` +
      `${friction.interrupts} interrupted mid-call`,
  );
  for (const denial of friction.denials.slice(0, RETRY_TOP_N))
    console.log(
      `    ${denial.tool}${denial.command ? `  ${denial.command.slice(0, 80)}` : ''}`,
    );
  console.log('');
}

const { corpora, extraSlugs } = parseArgs(process.argv.slice(2));
const cwdTop = repoRoot();
const specs = corpora.length
  ? corpora
  : [
      {
        name: basename(cwdTop),
        slugs: [cwdTop.replaceAll('/', '-'), ...extraSlugs],
      },
    ];
const read = specs.map(readCorpus);
for (const corpus of read) report(corpus);
if (read.length > 1) report(combineCorpora(read));
