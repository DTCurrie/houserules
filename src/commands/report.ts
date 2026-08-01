// `claude-kit report` (claude-kit CLI): read-only transcript telemetry. Aggregates
// this repo's Claude Code session logs (~/.claude/projects/<encoded-cwd>/*.jsonl)
// into per-session + rolled-up token tables, so adopters can watch cache_read climb
// and fresh input fall across init / module toggles.
//
// cache_read is the CHEAP tier — it is cost-weighted (0.1×), never summed flat with
// fresh input, so the numbers can't become a misleading vanity metric. This is the
// install-time-agnostic counterpart to `doctor`'s resident-surface snapshot, and the
// parser (parseTranscript) is deliberately exported as the substrate for later
// sub-reports. Native `/usage` already covers the live view; this is the trend view.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { detect } from '../detect.js';
import type { Flags } from '../types.js';

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface TranscriptMessage {
  role?: string;
  model?: string;
  usage?: Usage;
  content?: unknown;
}

/** One line of a Claude Code transcript .jsonl file — only the fields report() reads. */
interface TranscriptRecord {
  type?: string;
  isSidechain?: boolean;
  message?: TranscriptMessage;
}

interface TranscriptAgg {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  toolResults: number;
  models: Set<string>;
  sidechainTurns: number;
}

// Anthropic cache multipliers relative to base input price: a cache READ bills at
// ~0.1×, a cache WRITE at ~1.25×. Output is a different axis — reported separately.
const CACHE_READ_WEIGHT = 0.1;
const CACHE_WRITE_WEIGHT = 1.25;

// → { turns, input, output, cacheRead, cacheWrite, toolResults, models:Set, sidechainTurns }
export function parseTranscript(text: string): TranscriptAgg {
  const agg: TranscriptAgg = {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolResults: 0,
    models: new Set(),
    sidechainTurns: 0,
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: TranscriptRecord;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = rec.message ?? {};
    if (rec.type === 'assistant' || msg.role === 'assistant') {
      agg.turns += 1;
      if (rec.isSidechain) agg.sidechainTurns += 1;
      if (msg.model) agg.models.add(msg.model);
      const u = msg.usage ?? {};
      agg.input += u.input_tokens ?? 0;
      agg.output += u.output_tokens ?? 0;
      agg.cacheRead += u.cache_read_input_tokens ?? 0;
      agg.cacheWrite += u.cache_creation_input_tokens ?? 0;
    } else if (rec.type === 'user' || msg.role === 'user') {
      const content = msg.content;
      if (Array.isArray(content))
        agg.toolResults += content.filter(
          (b) => (b as { type?: string })?.type === 'tool_result',
        ).length;
    }
  }
  return agg;
}

// Cost-weighted input-equivalent: fresh input at 1×, cache writes at 1.25×, cache
// reads at 0.1× — so a session that offloaded work into the cache reads as cheaper.
function weightedInput(a: TranscriptAgg): number {
  return Math.round(
    a.input +
      a.cacheWrite * CACHE_WRITE_WEIGHT +
      a.cacheRead * CACHE_READ_WEIGHT,
  );
}

const n = (x: number) => x.toLocaleString('en-US');
const pct = (num: number, den: number) =>
  den ? `${Math.round((num / den) * 100)}%` : '0%';

export async function report(dir: string, _flags: Flags): Promise<number> {
  const root = resolve(dir);
  const ctx = detect(root);
  const top = ctx.git.top ?? root;
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const encoded = top.replaceAll('/', '-');
  const projDir = join(base, 'projects', encoded);

  console.log(`\n=== claude-kit report — ${top} ===\n`);
  if (!existsSync(projDir)) {
    console.log(`No transcripts found (looked in ${projDir}).`);
    return 0;
  }
  const files = readdirSync(projDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  if (!files.length) {
    console.log(`No .jsonl transcripts in ${projDir}.`);
    return 0;
  }

  const total: TranscriptAgg = {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolResults: 0,
    models: new Set(),
    sidechainTurns: 0,
  };
  console.log(`${files.length} session(s):\n`);
  for (const file of files) {
    let a: TranscriptAgg;
    try {
      a = parseTranscript(readFileSync(join(projDir, file), 'utf8'));
    } catch {
      continue;
    }
    total.turns += a.turns;
    total.input += a.input;
    total.output += a.output;
    total.cacheRead += a.cacheRead;
    total.cacheWrite += a.cacheWrite;
    total.toolResults += a.toolResults;
    total.sidechainTurns += a.sidechainTurns;
    for (const m of a.models) total.models.add(m);
    const id = file.replace(/\.jsonl$/, '').slice(0, 8);
    console.log(
      `  ${id}  turns ${a.turns}  in ${n(a.input)}  out ${n(a.output)}  ` +
        `cache_read ${n(a.cacheRead)}  cache_write ${n(a.cacheWrite)}  ` +
        `tools ${a.toolResults}  weighted-in ${n(weightedInput(a))}`,
    );
  }

  const cacheableIn = total.input + total.cacheRead + total.cacheWrite;
  console.log('\n-- totals --');
  console.log(
    `  turns ${n(total.turns)} | fresh input ${n(total.input)} | output ${n(total.output)}`,
  );
  console.log(
    `  cache_read ${n(total.cacheRead)} | cache_write ${n(total.cacheWrite)} | tool_results ${n(total.toolResults)}`,
  );
  console.log(
    `  cache-read share of input: ${pct(total.cacheRead, cacheableIn)} (cheap tier — the higher the better)`,
  );
  console.log(
    `  cost-weighted input-equivalent: ${n(weightedInput(total))} (cache_read ×${CACHE_READ_WEIGHT}, cache_write ×${CACHE_WRITE_WEIGHT})`,
  );
  console.log(
    `  models: ${[...total.models].join(', ') || '(none)'} | sidechain turns: ${pct(total.sidechainTurns, total.turns)}`,
  );
  console.log(
    '\n(cache_read is cost-weighted, never summed flat with fresh input; native /usage covers the live view.)',
  );
  return 0;
}
