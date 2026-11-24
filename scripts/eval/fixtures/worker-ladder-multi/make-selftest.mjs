#!/usr/bin/env node
/**
 * Builds three fake sample directories under `<out>` for proving `score.mjs` without a session:
 * `solution/sample-1` with `hidden/solution/invoice.js`, `wrong/sample-1` with
 * `hidden/wrong/invoice.js`, and `start/sample-1` with the repo's own first pass left in place.
 *
 *   node make-selftest.mjs <out-dir>
 *
 * The solution's worker writes, then runs the acceptance, and its dispatcher only redirects a log
 * to `/tmp`. The wrong one's worker runs the acceptance, then rewrites the source by heredoc, its
 * dispatcher writes a file, and its tree also changed `src/tax-rates.js`. The start one's worker
 * only ran the acceptance. So every scorer column reads differently across the three.
 *
 * Exit codes: 0 when the samples were built, 2 on a usage error.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const EXIT_USAGE = 2;
const OVERLAY_PATH = join('agents', 'task-worker.md');
const ACCEPTANCE =
  'node --test test/invoice.test.js test/invoice-format.test.js';

function overlaySha(arm) {
  const bytes = readFileSync(
    join(FIXTURE_DIR, 'arms', arm, 'overlay', OVERLAY_PATH),
  );
  return createHash('sha256').update(bytes).digest('hex');
}

function assistant(toolUses, parent = null) {
  return {
    type: 'assistant',
    parent_tool_use_id: parent,
    message: {
      role: 'assistant',
      content: toolUses.map(([name, input], index) => ({
        type: 'tool_use',
        id: `toolu_${name}_${index}`,
        name,
        input,
      })),
    },
  };
}

function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function writeRunJson(dir, label, sessionId, root) {
  const overlayHash = overlaySha('sonnet');
  writeFileSync(
    join(dir, 'run.json'),
    `${JSON.stringify(
      {
        arm: label,
        sample: 1,
        root,
        model: 'sonnet',
        validityAgent: 'task-worker',
        exitCode: 0,
        timedOut: false,
        sessionId,
        overlays: [
          {
            path: OVERLAY_PATH,
            initSha256: overlayHash,
            overlaySha256: overlayHash,
            exitSha256: overlayHash,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function writeStream(dir, sessionId, mainCalls, cost) {
  writeFileSync(
    join(dir, 'stream.jsonl'),
    jsonl([
      {
        type: 'system',
        subtype: 'init',
        apiKeySource: 'ANTHROPIC_API_KEY',
        session_id: sessionId,
      },
      assistant(mainCalls),
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: cost,
        session_id: sessionId,
        subagent_stats: { by_type: { 'task-worker': 1 } },
      },
    ]),
  );
}

function writeSubagent(dir, sessionId, workerCalls) {
  const subagents = join(dir, 'transcripts', sessionId, 'subagents');
  writeFileSync(
    join(subagents, 'agent-worker1.jsonl'),
    jsonl([assistant(workerCalls)]),
  );
  writeFileSync(
    join(subagents, 'agent-worker1.meta.json'),
    `${JSON.stringify({ agentType: 'task-worker', model: 'claude-sonnet-5-5' })}\n`,
  );
}

function writeTree(dir, invoiceSource, outsideEdit) {
  cpSync(join(FIXTURE_DIR, 'repo', 'src'), join(dir, 'tree', 'src'), {
    recursive: true,
  });
  cpSync(invoiceSource, join(dir, 'tree', 'src', 'invoice.js'));
  if (outsideEdit) appendFileSync(join(dir, 'tree', 'src', outsideEdit), '\n');
  cpSync(join(FIXTURE_DIR, 'repo', 'test'), join(dir, 'tree', 'test'), {
    recursive: true,
  });
}

function buildSample(
  out,
  label,
  { invoiceSource, outsideEdit, root, mainCalls, workerCalls, cost },
) {
  const dir = join(out, label, 'sample-1');
  const sessionId = `selftest-${label}`;
  mkdirSync(join(dir, 'transcripts', sessionId, 'subagents'), {
    recursive: true,
  });
  writeRunJson(dir, label, sessionId, root);
  writeStream(dir, sessionId, mainCalls, cost);
  writeSubagent(dir, sessionId, workerCalls);
  writeTree(dir, invoiceSource, outsideEdit);
}

const out = process.argv[2];
if (!out) {
  console.error('usage: node make-selftest.mjs <out-dir>');
  process.exit(EXIT_USAGE);
}

const root = '/private/tmp/selftest/sample-1';
const dispatch = [
  'Agent',
  { subagent_type: 'task-worker', description: 'Slice 1', prompt: 'brief' },
];
const readSeam = ['Read', { file_path: `${root}/src/invoice-contract.js` }];

buildSample(out, 'solution', {
  invoiceSource: join(FIXTURE_DIR, 'hidden', 'solution', 'invoice.js'),
  root,
  cost: 0.21,
  mainCalls: [
    dispatch,
    ['Bash', { command: 'node --test > /tmp/selftest-log.txt 2>&1' }],
  ],
  workerCalls: [
    ['Bash', { command: ACCEPTANCE }],
    readSeam,
    [
      'Write',
      {
        file_path: `${root}/src/invoice.js`,
        content: 'export const buildInvoice = () => ({});',
      },
    ],
    ['Bash', { command: `cd ${root} && ${ACCEPTANCE} 2>&1` }],
  ],
});

buildSample(out, 'wrong', {
  invoiceSource: join(FIXTURE_DIR, 'hidden', 'wrong', 'invoice.js'),
  outsideEdit: 'tax-rates.js',
  root,
  cost: 0.08,
  mainCalls: [
    dispatch,
    ['Write', { file_path: `${root}/NOTES.md`, content: 'notes' }],
  ],
  workerCalls: [
    readSeam,
    ['Bash', { command: ACCEPTANCE }],
    [
      'Bash',
      {
        command:
          "cat > src/invoice.js <<'EOF'\nexport const buildInvoice = (order) => order.length > 0;\nEOF",
      },
    ],
  ],
});

buildSample(out, 'start', {
  invoiceSource: join(FIXTURE_DIR, 'repo', 'src', 'invoice.js'),
  root,
  cost: 0.03,
  mainCalls: [dispatch],
  workerCalls: [['Bash', { command: ACCEPTANCE }]],
});

for (const label of ['solution', 'wrong', 'start'])
  console.log(`built ${join(out, label, 'sample-1')}`);
