#!/usr/bin/env node
/**
 * Runs the existing checkers over each kind of generated document and prints, per kind, how
 * many documents there are, how many pass, the pass share, and the rules that failed.
 *
 * Usage: node doc-conformance.mjs --repo <root> --issues <issues.json> [--before <ISO>] [--json <out>]
 *
 * `--repo` and `--issues` are required (exit 2 with a usage line when missing). `--before`
 * drops history changesets committed after that time. `--json` writes
 * `{ schema: "doc-conformance@1", kinds: [{ kind, documents, passed, share, warned, checkers, rules }] }`
 * where `checkers` lists every checker the kind maps to, sorted, whether or not any failed, and each rule is `{ checker, rule, failures, examples }`, `failures` counts documents,
 * and `examples` holds at most three paths or ids. `warned` counts documents with at least one
 * warning. Nothing else is written. Checkers come from this repo's `.claude/scripts/`, never
 * from `--repo`, and none is edited.
 *
 * A document passes a kind when every mapped checker reports no error-level defect on it.
 * Warnings never fail it. Mapping:
 *
 *   plan               plan-lint (run once over a temp copy of the plans tree, see below) and
 *                      prose-lint over every .md in the workspace. Documents are the
 *                      directories holding ROADMAP.md at any depth, plus each MILESTONE.md.
 *   changeset-disk     changeset-shape, public-text, and prose-lint over `.changeset/*.md`.
 *   changeset-history  the same three over every changeset file added in git history, read
 *                      with `git log` and `git show`, filtered by `--before`.
 *   issue              public-text and prose-lint over each body in `--issues`.
 *   findings           check-findings (its `checkFindings` export) and prose-lint over each
 *                      .md under `.claude/plans/` holding a `### XX-NN` block. The destination
 *                      set is the file's own destination values plus `none`, so a destination
 *                      is checked for pairing with its action but not against a phase list.
 *
 * plan-lint takes no path and reads only `.claude/plans/<slug>` and `<milestone>/<member>`.
 * To run it per workspace without editing it, this builds a temp root whose top-level entries
 * are symlinks to the repo, except `.claude/plans`, which holds copies of the markdown files
 * with each workspace under a container such as `_archive` or `_health-checks` lifted to
 * `<container>--<name>` so plan-lint reads it as a plan. Its output lines are mapped back to
 * the original workspace paths. Findings that belong to no workspace, such as a
 * config-level one, are dropped.
 *
 * `changeset-shape` and `public-text` are small checks defined here, since no checker script
 * validates a changeset or an issue body. changeset-shape checks the frontmatter fences, the
 * release lines, a non-empty summary, and the 15-word limit the changeset skill sets.
 * public-text flags a ledger id such as `CLI-72633f`, which the project keeps out of public
 * text. It skips the id inside a board sync marker, `<!-- houserules:entry:<id> -->`, which the
 * sync writes on purpose. An id anywhere else in the body still fails.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, '../../../.claude/scripts');
const { checkProse } = await import(join(SCRIPTS, 'prose-lint.mjs'));
const { checkFindings, parseFindings } = await import(
  join(SCRIPTS, 'lib/finding-blocks.mjs')
);
const { BACKLOG_ID } = await import(join(SCRIPTS, 'lib/backlog-id.mjs'));

const USAGE =
  'usage: node doc-conformance.mjs --repo <root> --issues <issues.json> [--before <ISO>] [--json <out>]';
const KINDS = [
  'plan',
  'changeset-disk',
  'changeset-history',
  'issue',
  'findings',
];
const KIND_CHECKERS = Object.freeze({
  plan: ['plan-lint', 'prose-lint'],
  'changeset-disk': ['changeset-shape', 'prose-lint', 'public-text'],
  'changeset-history': ['changeset-shape', 'prose-lint', 'public-text'],
  issue: ['prose-lint', 'public-text'],
  findings: ['check-findings', 'prose-lint'],
});
const SYNC_MARKER = /<!-- houserules:entry:[A-Z][A-Z0-9]*-[0-9a-f]{6} -->/g;
const MAX_EXAMPLES = 3;
const MAX_SUMMARY_WORDS = 15;
const RELEASE_LINE = /^\s*['"]?[^'"]+?['"]?\s*:\s*(patch|minor|major)\s*$/;
const FINDING_HEAD = /^### [A-Z]{2}-\d{2} /m;
const LINT_LINE = /^(.+?)(?::(\d+))? {2}(ERROR|WARN) {2}\[([^\]]+)\] {2}/;
const KEY_SEPARATOR = '\u0000';
const PERCENT = 100;
const MAX_CHILD_OUTPUT_BYTES = 256 * 1024 * 1024;

/** A defect list entry: `{ checker, rule, level }`. */
const makeDefect = (checker, rule, level = 'error') => ({
  checker,
  rule,
  level,
});

function proseDefects(name, text) {
  return checkProse(name, text).findings.map((finding) =>
    makeDefect('prose-lint', finding.rule, finding.level),
  );
}

function publicTextDefects(text) {
  return [...text.replace(SYNC_MARKER, '').matchAll(BACKLOG_ID)].length > 0
    ? [makeDefect('public-text', 'public-text/ledger-id')]
    : [];
}

/** Splits a changeset into its frontmatter lines and its body, or null without fences. */
function splitChangeset(text) {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const close = lines.findIndex((line, at) => at > 0 && line.trim() === '---');
  if (close === -1) return null;
  return {
    front: lines.slice(1, close),
    body: lines.slice(close + 1).join('\n'),
  };
}

function changesetDefects(name, text) {
  const parts = splitChangeset(text);
  if (!parts)
    return [makeDefect('changeset-shape', 'changeset/no-frontmatter')];
  const found = [];
  if (parts.front.some((line) => line.trim() && !RELEASE_LINE.test(line)))
    found.push(makeDefect('changeset-shape', 'changeset/bad-release-line'));
  const summary = parts.body.trim();
  if (!summary)
    found.push(makeDefect('changeset-shape', 'changeset/empty-summary'));
  else if (summary.split(/\s+/).length > MAX_SUMMARY_WORDS)
    found.push(
      makeDefect(
        'changeset-shape',
        `changeset/summary-over-${MAX_SUMMARY_WORDS}-words`,
      ),
    );
  found.push(...publicTextDefects(summary));
  found.push(...proseDefects(name, summary));
  return found;
}

const FINDING_RULES = [
  [
    /^missing (.+)$/,
    (match) => `findings/missing-${match[1].replace(/ /g, '-')}`,
  ],
  [/^tag /, () => 'findings/invalid-tag'],
  [/^candidate action /, () => 'findings/invalid-action'],
  [/^destination "/, () => 'findings/invalid-destination'],
  [/must name/, () => 'findings/action-destination-pairing'],
  [/^evidence has no/, () => 'findings/evidence-unanchored'],
  [/^numbering gap/, () => 'findings/numbering-gap'],
  [/^no findings and no statement/, () => 'findings/no-findings-statement'],
];

function findingsDefects(name, text) {
  const destinations = new Set(['none']);
  for (const block of parseFindings(text))
    for (const value of block.fields.get('destination') ?? [])
      destinations.add(value);
  const found = checkFindings(text, destinations).map((message) => {
    const body = message.replace(/^[A-Z]{2}-\d{2}: /, '');
    const hit = FINDING_RULES.find(([pattern]) => pattern.test(body));
    return makeDefect(
      'check-findings',
      hit ? hit[1](hit[0].exec(body)) : 'findings/other',
    );
  });
  return [...found, ...proseDefects(name, text)];
}

function walk(dir, keep, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, keep, out);
    else if (keep(entry.name)) out.push(path);
  }
  return out;
}

const subdirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

/**
 * Builds a temp root whose top-level entries are symlinks to the repo, except `.claude/plans`,
 * which starts empty for the caller to fill.
 */
function buildSymlinkedRoot(repo) {
  const root = mkdtempSync(join(tmpdir(), 'doc-conformance-'));
  for (const name of readdirSync(repo))
    if (name !== '.claude') symlinkSync(join(repo, name), join(root, name));
  mkdirSync(join(root, '.claude/plans'), { recursive: true });
  const claude = join(repo, '.claude');
  for (const name of readdirSync(claude))
    if (name !== 'plans')
      symlinkSync(join(claude, name), join(root, '.claude', name));
  return root;
}

/**
 * Walks each top-level plan directory, copying it through `copy` and registering its
 * workspaces through `addDoc`. Both take an original and a temp path relative to `.claude/plans`.
 */
function classifyWorkspaces(plansDir, copy, addDoc) {
  for (const slug of subdirs(plansDir)) {
    const dir = join(plansDir, slug);
    if (existsSync(join(dir, 'MILESTONE.md'))) {
      copy(slug, slug);
      addDoc(slug, slug);
      for (const member of subdirs(dir))
        if (existsSync(join(dir, member, 'ROADMAP.md')))
          addDoc(join(slug, member), join(slug, member));
    } else if (existsSync(join(dir, 'ROADMAP.md'))) {
      copy(slug, slug);
      addDoc(slug, slug);
    } else {
      const members = subdirs(dir).filter((member) =>
        existsSync(join(dir, member, 'ROADMAP.md')),
      );
      if (members.length === 0) copy(slug, slug);
      for (const member of members) {
        copy(join(slug, member), `${slug}--${member}`);
        addDoc(join(slug, member), `${slug}--${member}`);
      }
    }
  }
}

/**
 * Copies the plans tree into a temp root and returns `{ root, docs }`, each doc being
 * `{ id, tempRelative, originalRelative, files }` with paths relative to the root's `.claude/plans`.
 */
function stagePlans(repo) {
  const plansDir = join(repo, '.claude/plans');
  const docs = [];
  const root = buildSymlinkedRoot(repo);
  const copy = (originalRelative, tempRelative) =>
    cpSync(
      join(plansDir, originalRelative),
      join(root, '.claude/plans', tempRelative),
      {
        recursive: true,
        filter: (source) =>
          !source.includes('node_modules') &&
          (!/\.[a-z0-9]+$/i.test(source) || source.endsWith('.md')),
      },
    );
  const addDoc = (originalRelative, tempRelative) =>
    docs.push({
      id: join('.claude/plans', originalRelative),
      tempRelative,
      originalRelative,
      files: walk(join(plansDir, originalRelative), (fileName) =>
        fileName.endsWith('.md'),
      ),
    });
  classifyWorkspaces(plansDir, copy, addDoc);
  return { root, docs };
}

function runPlanLint(root) {
  const run = spawnSync('node', [join(SCRIPTS, 'plan-lint.mjs')], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
  });
  return run.stdout ?? '';
}

/** Maps plan-lint output lines onto the doc whose staged path holds each one. */
function assignLintLines(output, docs) {
  const byDoc = new Map(docs.map((doc) => [doc, []]));
  const owners = [...docs].sort(
    (a, b) => b.tempRelative.length - a.tempRelative.length,
  );
  for (const line of output.split('\n')) {
    const match = LINT_LINE.exec(line);
    if (!match) continue;
    const file = match[1];
    const owner = owners.find((doc) => {
      const prefix = join('.claude/plans', doc.tempRelative);
      return file === prefix || file.startsWith(`${prefix}/`);
    });
    if (owner)
      byDoc
        .get(owner)
        .push(makeDefect('plan-lint', match[4], match[3].toLowerCase()));
  }
  return byDoc;
}

function planDocuments(repo) {
  const plansDir = join(repo, '.claude/plans');
  if (!existsSync(plansDir)) return [];
  const { root, docs } = stagePlans(repo);
  try {
    const byDoc = assignLintLines(runPlanLint(root), docs);
    return docs.map((doc) => ({
      id: doc.id,
      defects: [
        ...byDoc.get(doc),
        ...doc.files.flatMap((file) =>
          proseDefects(file, readFileSync(file, 'utf8')),
        ),
      ],
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function changesetDisk(repo) {
  const dir = join(repo, '.changeset');
  return walk(dir, (name) => name.endsWith('.md') && name !== 'README.md')
    .filter((file) => dirname(file) === dir)
    .map((file) => ({
      id: relative(repo, file),
      defects: changesetDefects(file, readFileSync(file, 'utf8')),
    }));
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Returns the history doc for a changeset file added in `commit`, or null when git cannot show it. */
function readAddedChangeset(repo, commit, line) {
  let text;
  try {
    text = git(repo, ['show', `${commit}:${line}`]);
  } catch {
    return null;
  }
  return {
    id: `${commit.slice(0, 7)}:${line}`,
    defects: changesetDefects(line, text),
  };
}

function changesetHistory(repo, before) {
  let log;
  try {
    log = git(repo, [
      'log',
      '--diff-filter=A',
      '--name-only',
      '--format=@@%H %cI',
      '--',
      '.changeset',
    ]);
  } catch {
    return [];
  }
  const docs = [];
  let commit = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('@@')) {
      const [hash, when] = line.slice(2).split(' ');
      commit = !before || Date.parse(when) <= Date.parse(before) ? hash : null;
      continue;
    }
    if (!commit) continue;
    if (!/^\.changeset\/[^/]+\.md$/.test(line)) continue;
    if (line === '.changeset/README.md') continue;
    const doc = readAddedChangeset(repo, commit, line);
    if (doc) docs.push(doc);
  }
  return docs;
}

function issueDocuments(issuesPath) {
  const issues = JSON.parse(readFileSync(issuesPath, 'utf8'));
  return issues.map((issue) => {
    const text = `${issue.title ?? ''}\n\n${issue.body ?? ''}`;
    return {
      id: `#${issue.number}`,
      defects: [
        ...publicTextDefects(text),
        ...proseDefects('issue.md', issue.body ?? ''),
      ],
    };
  });
}

function findingsDocuments(repo) {
  const plansDir = join(repo, '.claude/plans');
  return walk(plansDir, (name) => name.endsWith('.md'))
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => FINDING_HEAD.test(text))
    .map(({ file, text }) => ({
      id: relative(repo, file),
      defects: findingsDefects(file, text),
    }));
}

function summarize(kind, docs) {
  const errorDefects = (doc) =>
    doc.defects.filter((defect) => defect.level === 'error');
  const passed = docs.filter((doc) => errorDefects(doc).length === 0).length;
  const rules = new Map();
  for (const doc of docs) {
    const seen = new Set();
    for (const defect of errorDefects(doc)) {
      const key = `${defect.checker}${KEY_SEPARATOR}${defect.rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = rules.get(key) ?? {
        checker: defect.checker,
        rule: defect.rule,
        failures: 0,
        examples: [],
      };
      row.failures += 1;
      if (row.examples.length < MAX_EXAMPLES) row.examples.push(doc.id);
      rules.set(key, row);
    }
  }
  return {
    kind,
    documents: docs.length,
    passed,
    share: docs.length === 0 ? null : passed / docs.length,
    warned: docs.filter((doc) =>
      doc.defects.some((defect) => defect.level !== 'error'),
    ).length,
    checkers: [...KIND_CHECKERS[kind]].sort(),
    rules: [...rules.values()].sort(
      (a, b) => b.failures - a.failures || a.rule.localeCompare(b.rule),
    ),
  };
}

function render(kinds) {
  const lines = ['kind\tdocuments\tpassed\tshare\twarned'];
  for (const row of kinds) {
    const share =
      row.share === null ? 'n/a' : `${(row.share * PERCENT).toFixed(1)}%`;
    lines.push(
      `${row.kind}\t${row.documents}\t${row.passed}\t${share}\t${row.warned}`,
    );
    for (const rule of row.rules)
      lines.push(`  ${rule.failures}\t${rule.checker}\t${rule.rule}`);
  }
  return lines.join('\n');
}

function parseOptions(argv) {
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const repoArg = flag('--repo');
  const issuesPath = flag('--issues');
  if (!repoArg || !issuesPath) {
    console.error(`doc-conformance: missing --repo or --issues\n${USAGE}`);
    process.exit(2);
  }
  const before = flag('--before');
  if (before && Number.isNaN(Date.parse(before))) {
    console.error(`doc-conformance: --before is not a timestamp\n${USAGE}`);
    process.exit(2);
  }
  return { repoArg, issuesPath, before, out: flag('--json') };
}

function main() {
  const { repoArg, issuesPath, before, out } = parseOptions(process.argv);
  const repo = resolve(repoArg);
  const byKind = {
    plan: planDocuments(repo),
    'changeset-disk': changesetDisk(repo),
    'changeset-history': changesetHistory(repo, before),
    issue: issueDocuments(resolve(issuesPath)),
    findings: findingsDocuments(repo),
  };
  const kinds = KINDS.map((kind) => summarize(kind, byKind[kind]));
  process.stdout.write(`${render(kinds)}\n`);
  if (out)
    writeFileSync(
      out,
      `${JSON.stringify({ schema: 'doc-conformance@1', kinds }, null, 2)}\n`,
    );
}

main();
