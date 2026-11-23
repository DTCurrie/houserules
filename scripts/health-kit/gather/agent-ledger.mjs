#!/usr/bin/env node
/**
 * Writes an `agent-ledger@2` file: one row per chain, where a chain is one main transcript
 * `<slug>/<session>.jsonl` or one subagent transcript `<slug>/<session>/subagents/agent-<id>.jsonl`.
 *
 * Usage: node agent-ledger.mjs --machine <local|work> --out <file> [--schema <path>] <repoRoot>...
 *
 * The repo label is each root's basename, and the transcript slug is derived from the root the
 * way `houserules report` derives it. Turns and token sums follow the report's arithmetic, so a
 * repo's turns and weighted input equal the report's `-- totals --` lines for the same corpus.
 *
 * The key list is embedded. `--schema` swaps in that file's `keys agent-ledger` block. Without
 * it, a `SCHEMA.md` beside this script must hold a block equal to the embedded one.
 *
 * Exit codes: 0 written, 1 a key or string outside the schema or its string policy, 2 bad usage
 * or a schema mismatch. Reads `~/.claude` (or `CLAUDE_CONFIG_DIR`) only, writes `--out` only.
 * Node builtins only.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 'agent-ledger@2';
const EMBEDDED_KEYS =
  'schema                         string        "agent-ledger@2"\nmachine                        string        fixed keyword, local | work\ngeneratedAt                    string        ISO timestamp of the run\nrepos[]                        object        one per repo walked\nrepos[].repo                   string        repo label\nrepos[].sessions               number        main transcripts walked\nrepos[].chains                 number        rows emitted for this repo\nrepos[].turns                  number        sum of rows[].turns\nrepos[].weightedInput          number        sum of rows[].weightedInput\nrepos[].placeholderTurns       number        sum of rows[].placeholderTurns\nrows[]                         object        one per chain\nrows[].id                      string        chain id\nrows[].repo                    string        repo label\nrows[].session                 string        session id prefix\nrows[].kind                    string        fixed keyword, main | subagent\nrows[].agentType               string|null   meta `agentType`, null for main\nrows[].spawnDepth              number        meta `spawnDepth`, 0 for main\nrows[].parent                  string|null   chain id, see Parent\nrows[].model                   string|null   meta `model`, null for main or when absent\nrows[].pickedEffortModel       string|null   meta `pickedEffortModel`, null when absent\nrows[].effort                  string|null   subagent: the spawning Agent call\'s `effort` input; main: the transcript\'s recorded `perTurnEffort`, most turns win; null is unknown; fixed keyword\nrows[].turns                   number\nrows[].placeholderTurns        number        turns whose usage was excluded\nrows[].turnsByModel{}          number        keys are model ids\nrows[].tokens                  object\nrows[].tokens.input            number        fresh input\nrows[].tokens.output           number\nrows[].tokens.cacheRead        number\nrows[].tokens.cacheWrite       number\nrows[].tokens.cacheWrite1h     number        1-hour part of cacheWrite\nrows[].weightedInput           number        see Shared definitions\nrows[].firstTs                 string|null   ISO timestamp of the first turn\nrows[].lastTs                  string|null   ISO timestamp of the last turn\nrows[].tools{}                 object        keys are tool names\nrows[].tools{}.uses            number        tool_use blocks emitted by this chain\nrows[].tools{}.resultBytes     number        UTF-8 bytes of the matching tool_result content\nrows[].skills{}                number        keys are skill names, value is Skill tool invocations\nrows[].ruleLoads{}             object        keys are paths under .claude/rules/\nrows[].ruleLoads{}.count       number\nrows[].ruleLoads{}.bytes       number\nrows[].series                  object        column-major per-turn series\nrows[].series.ts[]             string|null   ISO timestamp\nrows[].series.model[]          string|null   model id\nrows[].series.input[]          number\nrows[].series.output[]         number\nrows[].series.cacheRead[]      number\nrows[].series.cacheWrite[]     number\nrows[].series.cacheWrite1h[]   number        1-hour part of cacheWrite\nrows[].series.counted[]        boolean       false on a placeholder-usage turn\nrows[].series.tools[]          array         tool names called on this turn, in order\nrows[].series.tools[][]        string        tool name\nrows[].series.markers[]        array         markers on this turn, empty when none\nrows[].series.markers[][]      object        one marker\nrows[].series.markers[][].kind string        fixed keyword\nrows[].series.markers[][].status string|null report marker only\nrows[].series.markers[][].action string|null artifact marker only\nrows[].series.markers[][].intent string|null artifact marker only\nrows[].series.markers[][].edits boolean|null artifact marker only, true when the call carried `edits`\nrows[].series.markers[][].typed boolean|null artifact marker only, true when the call named a type\n';

// Same constants as packages/cli/src/commands/report/token-usage.ts and transcript-events.ts.
const CACHE_READ_WEIGHT = 0.1;
const CACHE_WRITE_WEIGHT = 1.25;
const CACHE_WRITE_1H_WEIGHT = 2;
const REAL_SUBAGENT_USAGE_FROM_PARTS = [2, 1, 307];
// Claude Code truncates an encoded project dir name at this length (entry-ledger.mts).
const PROJECT_DIR_NAME_MAX_LENGTH = 200;
const ID_PREFIX_LENGTH = 8;

const MACHINES = new Set(['local', 'work']);
const KINDS = new Set(['main', 'subagent']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MARKER_KINDS = new Set(['report', 'continue', 'ruling', 'artifact']);
const REPORT_STATUSES = new Set([
  'WAVE_CLOSED',
  'DONE',
  'NEEDS_RULING',
  'BLOCKED',
  'PARTIAL',
]);
// `\b` and not `\s`: five recorded first lines end the status with a period, `NEEDS_RULING.`.
const REPORT_LINE = /^PHASE \S+\/\d+: ([A-Z_]+)\b/;
const ARTIFACT_VALUE = /^[a-z][a-z_-]{0,31}$/;
// A message relayed by SendMessage arrives wrapped: a harness first line, the body, a blank
// line, and a harness footer line.
const RELAYED_MESSAGE_HEAD =
  /^[^\n]*sent a message(?: while you were working)?:\n/;

const NAME = /^[A-Za-z0-9_.:@-]{1,128}$/;
const MODEL_ID = /^[A-Za-z0-9<>._:@[\]-]{1,128}$/;
const REPO_LABEL = /^[A-Za-z0-9._-]{1,100}$/;
const SESSION_PREFIX = /^[0-9a-f]{8}$/;
const CHAIN_ID = /^[A-Za-z0-9._-]{1,100}\/[0-9a-f]{8}\/(?:main|[0-9a-z]{8})$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const RULE_PATH = /^\.claude\/rules\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;
const RULES_DIR_MARKER = `${sep}.claude${sep}rules${sep}`;

const isFixed = (set) => (value) => set.has(value);
const matches = (pattern) => (value) => pattern.test(value);
const isRulePath = (value) =>
  RULE_PATH.test(value) && !value.split('/').includes('..');
const isArtifactValue = (value) =>
  value === 'other' || ARTIFACT_VALUE.test(value);

/** String policy: the check every string value at a schema path must pass. */
const VALUE_POLICY = {
  schema: (value) => value === SCHEMA_VERSION,
  machine: isFixed(MACHINES),
  generatedAt: matches(ISO_TIMESTAMP),
  'repos[].repo': matches(REPO_LABEL),
  'rows[].id': matches(CHAIN_ID),
  'rows[].repo': matches(REPO_LABEL),
  'rows[].session': matches(SESSION_PREFIX),
  'rows[].kind': isFixed(KINDS),
  'rows[].agentType': matches(NAME),
  'rows[].parent': matches(CHAIN_ID),
  'rows[].model': matches(MODEL_ID),
  'rows[].pickedEffortModel': matches(MODEL_ID),
  'rows[].effort': isFixed(EFFORTS),
  'rows[].firstTs': matches(ISO_TIMESTAMP),
  'rows[].lastTs': matches(ISO_TIMESTAMP),
  'rows[].series.ts[]': matches(ISO_TIMESTAMP),
  'rows[].series.model[]': matches(MODEL_ID),
  'rows[].series.tools[][]': matches(NAME),
  'rows[].series.markers[][].kind': isFixed(MARKER_KINDS),
  'rows[].series.markers[][].status': isFixed(REPORT_STATUSES),
  'rows[].series.markers[][].action': isArtifactValue,
  'rows[].series.markers[][].intent': isArtifactValue,
};

/** String policy for the data keys of each map path. */
const MAP_KEY_POLICY = {
  'rows[].turnsByModel{}': matches(MODEL_ID),
  'rows[].tools{}': matches(NAME),
  'rows[].skills{}': matches(NAME),
  'rows[].ruleLoads{}': isRulePath,
};

class UsageError extends Error {}
class PolicyError extends Error {}

function parseArgs(argv) {
  const options = { roots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--machine' || arg === '--out' || arg === '--schema') {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      options[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new UsageError(`unknown flag ${arg}`);
    } else {
      options.roots.push(arg);
    }
  }
  if (!MACHINES.has(options.machine))
    throw new UsageError('--machine must be local or work');
  if (!options.out) throw new UsageError('--out is required');
  if (!options.roots.length)
    throw new UsageError('give at least one repo root');
  return options;
}

/** The fenced block whose info string is `keys agent-ledger`, as written in the document. */
function extractKeysBlock(markdown) {
  const match = /^```keys agent-ledger\n([\s\S]*?)^```/m.exec(markdown);
  if (!match) return undefined;
  return match[1];
}

function resolveKeysBlock(schemaFlag) {
  if (schemaFlag) {
    const block = extractKeysBlock(readFileSync(schemaFlag, 'utf8'));
    if (block === undefined)
      throw new UsageError(`${schemaFlag} has no keys agent-ledger block`);
    return block;
  }
  const beside = join(dirname(fileURLToPath(import.meta.url)), 'SCHEMA.md');
  if (existsSync(beside)) {
    const block = extractKeysBlock(readFileSync(beside, 'utf8'));
    if (block !== EMBEDDED_KEYS)
      throw new UsageError(
        `the embedded key list differs from the keys agent-ledger block in ${beside}`,
      );
  }
  return EMBEDDED_KEYS;
}

function parseKeyPaths(block) {
  const paths = new Set();
  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    paths.add(line.trim().split(/\s+/)[0]);
  }
  return paths;
}

function claudeProjectDir(absolutePath, projectsDir) {
  const encoded = absolutePath.replace(/[^A-Za-z0-9]/g, '-');
  if (encoded.length < PROJECT_DIR_NAME_MAX_LENGTH) return encoded;
  const prefix = encoded.slice(0, PROJECT_DIR_NAME_MAX_LENGTH);
  try {
    const found = readdirSync(projectsDir).filter((name) =>
      name.startsWith(prefix),
    );
    return found.length === 1 ? found[0] : prefix;
  } catch {
    return prefix;
  }
}

function weightedInput(tokens) {
  return Math.round(
    tokens.input +
      (tokens.cacheWrite - tokens.cacheWrite1h) * CACHE_WRITE_WEIGHT +
      tokens.cacheWrite1h * CACHE_WRITE_1H_WEIGHT +
      tokens.cacheRead * CACHE_READ_WEIGHT,
  );
}

function isPlaceholderUsageVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return false;
  for (const [i, floor] of REAL_SUBAGENT_USAGE_FROM_PARTS.entries()) {
    const part = Number(match[i + 1]);
    if (part !== floor) return part < floor;
  }
  return false;
}

function readRecords(file) {
  const records = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // The report skips an unparseable line the same way.
    }
  }
  return records;
}

function readMeta(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Maps the real path of every file under `<root>/.claude/rules/` to its `.claude/rules/` path,
 * so a load recorded through a symlink's target still names the installed rule.
 */
function ruleRealPaths(root) {
  const byRealPath = new Map();
  const rulesDir = join(root, '.claude', 'rules');
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) walk(full);
      else
        byRealPath.set(
          realpathSync(full),
          ['.claude', 'rules', ...relative(rulesDir, full).split(sep)].join(
            '/',
          ),
        );
    }
  };
  walk(rulesDir);
  return byRealPath;
}

function rulePathOf(loadedPath, ruleMap) {
  if (typeof loadedPath !== 'string') return undefined;
  const mapped = ruleMap.get(loadedPath);
  if (mapped) return mapped;
  const at = loadedPath.lastIndexOf(RULES_DIR_MARKER);
  if (at === -1) return undefined;
  return [
    '.claude',
    'rules',
    ...loadedPath.slice(at + RULES_DIR_MARKER.length).split(sep),
  ].join('/');
}

function utf8Bytes(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

function isoOrNull(value) {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) ? value : null;
}

function receivedText(record) {
  const content = record.message?.content;
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((block) => block?.type === 'tool_result'))
      return undefined;
    const parts = content
      .filter(
        (block) => block?.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text);
    if (!parts.length) return undefined;
    text = parts.join('\n');
  } else return undefined;
  if (!RELAYED_MESSAGE_HEAD.test(text)) return text;
  const body = text.replace(RELAYED_MESSAGE_HEAD, '');
  const footerAt = body.lastIndexOf('\n\n');
  return footerAt === -1 ? body : body.slice(0, footerAt);
}

function reportStatus(message) {
  if (typeof message !== 'string') return undefined;
  const firstLine = message.split('\n').find((line) => line.trim());
  const match = REPORT_LINE.exec(firstLine?.trim() ?? '');
  return match && REPORT_STATUSES.has(match[1]) ? match[1] : undefined;
}

function artifactField(input, key) {
  if (!(key in input) || input[key] === undefined || input[key] === null)
    return null;
  const value = input[key];
  return typeof value === 'string' && ARTIFACT_VALUE.test(value)
    ? value
    : 'other';
}

function artifactMarker(input) {
  const callInput = input && typeof input === 'object' ? input : {};
  const typeName = callInput.type_url ?? callInput.type;
  return {
    kind: 'artifact',
    status: null,
    action: artifactField(callInput, 'action'),
    intent: artifactField(callInput, 'intent'),
    edits: callInput.edits !== undefined && callInput.edits !== null,
    typed: typeof typeName === 'string' && typeName.length > 0,
  };
}

function plainMarker(kind) {
  return {
    kind,
    status: null,
    action: null,
    intent: null,
    edits: null,
    typed: null,
  };
}

function emptyRow() {
  return {
    turns: 0,
    placeholderTurns: 0,
    turnsByModel: {},
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
    },
    tools: {},
    skills: {},
    ruleLoads: {},
    series: {
      ts: [],
      model: [],
      input: [],
      output: [],
      cacheRead: [],
      cacheWrite: [],
      cacheWrite1h: [],
      counted: [],
      tools: [],
      markers: [],
    },
  };
}

/**
 * Folds one transcript into a row. A turn is any record the report counts as one: `type` or
 * `message.role` is `assistant`. Tool uses and results follow the report's event reader, which
 * reads `tool_use` blocks from `type: assistant` records and `tool_result` blocks from
 * `type: user` records.
 */
function foldChain(records, isSubagent, ruleMap) {
  const row = emptyRow();
  const toolNameById = new Map();
  const toolUseIds = new Set();
  const pending = new Set();
  const seenResponses = new Map();
  for (const record of records) {
    const message = record.message ?? {};
    const attachment = record.attachment;
    if (attachment?.type === 'nested_memory') {
      const content = attachment.content ?? {};
      const loadedPath =
        typeof attachment.path === 'string'
          ? attachment.path
          : typeof content === 'object'
            ? content.path
            : undefined;
      const rulePath = rulePathOf(loadedPath, ruleMap);
      if (rulePath) {
        const tally = (row.ruleLoads[rulePath] ??= { count: 0, bytes: 0 });
        tally.count += 1;
        tally.bytes += utf8Bytes(
          typeof content === 'string' ? content : content.content,
        );
      }
      continue;
    }
    if (record.type === 'assistant' || message.role === 'assistant') {
      foldTurn(
        row,
        record,
        isSubagent,
        toolNameById,
        toolUseIds,
        pending,
        seenResponses,
      );
      continue;
    }
    if (record.type === 'user' || message.role === 'user')
      foldReceived(row, record, toolNameById, pending);
  }
  const stamps = row.series.ts.filter((ts) => ts !== null);
  row.firstTs = stamps[0] ?? null;
  row.lastTs = stamps.at(-1) ?? null;
  row.toolUseIds = toolUseIds;
  return row;
}

/**
 * Claude Code writes one record per content block of one API response, each with a copy of the
 * same usage. The first record of an id pair is the turn and carries the usage. Later records
 * of the pair add only their tool calls to that turn. A record with no usage is no turn.
 */
function foldTurn(
  row,
  record,
  isSubagent,
  toolNameById,
  toolUseIds,
  pending,
  seenResponses,
) {
  const message = record.message ?? {};
  const hasKey = message.id !== undefined || record.requestId !== undefined;
  const key = `${message.id ?? ''}\u0000${record.requestId ?? ''}`;
  const repeatOf = hasKey ? seenResponses.get(key) : undefined;
  const isTurn = Boolean(message.usage) && repeatOf === undefined;
  const placeholder = isSubagent && isPlaceholderUsageVersion(record.version);
  const usage = placeholder ? {} : (message.usage ?? {});
  const tokens = {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  };
  if (isTurn) {
    row.turns += 1;
    if (placeholder) row.placeholderTurns += 1;
    if (message.model)
      row.turnsByModel[message.model] =
        (row.turnsByModel[message.model] ?? 0) + 1;
    for (const field of Object.keys(tokens)) row.tokens[field] += tokens[field];
    if (hasKey) seenResponses.set(key, row.series.ts.length);
  }
  const markers = isTurn ? [...pending].map(plainMarker) : [];
  if (isTurn) pending.clear();
  const toolNames = [];
  if (record.type === 'assistant' && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (
        block?.type !== 'tool_use' ||
        typeof block.id !== 'string' ||
        typeof block.name !== 'string'
      )
        continue;
      toolNames.push(block.name);
      toolNameById.set(block.id, block.name);
      toolUseIds.add(block.id);
      const tool = (row.tools[block.name] ??= { uses: 0, resultBytes: 0 });
      tool.uses += 1;
      const input = block.input ?? {};
      if (block.name === 'Skill' && typeof input.skill === 'string')
        row.skills[input.skill] = (row.skills[input.skill] ?? 0) + 1;
      if (block.name === 'Artifact') markers.push(artifactMarker(input));
      if (block.name === 'SubagentHandback' || block.name === 'SendMessage') {
        const status = reportStatus(input.message);
        if (status) markers.push({ ...plainMarker('report'), status });
      }
    }
  }
  const series = row.series;
  if (!isTurn) {
    if (repeatOf !== undefined) {
      series.tools[repeatOf].push(...toolNames);
      series.markers[repeatOf].push(...markers);
    }
    return;
  }
  series.ts.push(isoOrNull(record.timestamp));
  series.model.push(typeof message.model === 'string' ? message.model : null);
  series.input.push(tokens.input);
  series.output.push(tokens.output);
  series.cacheRead.push(tokens.cacheRead);
  series.cacheWrite.push(tokens.cacheWrite);
  series.cacheWrite1h.push(tokens.cacheWrite1h);
  series.counted.push(!placeholder);
  series.tools.push(toolNames);
  series.markers.push(markers);
}

function foldReceived(row, record, toolNameById, pending) {
  const content = record.message?.content;
  if (record.type === 'user' && Array.isArray(content)) {
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const name = toolNameById.get(block.tool_use_id);
      if (!name) continue;
      row.tools[name].resultBytes += Buffer.byteLength(
        JSON.stringify(block.content ?? ''),
        'utf8',
      );
    }
  }
  const text = receivedText(record);
  if (text === undefined) return;
  if (text.trim() === 'continue') pending.add('continue');
  if (text.trimStart().startsWith('Ruling:')) pending.add('ruling');
}

function findSpawningCall(records, toolUseId) {
  for (const record of records) {
    if (record.type !== 'assistant' || !Array.isArray(record.message?.content))
      continue;
    for (const block of record.message.content)
      if (block?.type === 'tool_use' && block.id === toolUseId) return block;
  }
  return undefined;
}

function walkRepo(root, projectsDir) {
  const absoluteRoot = resolve(root);
  const repo = basename(absoluteRoot);
  const slugDir = join(
    projectsDir,
    claudeProjectDir(absoluteRoot, projectsDir),
  );
  const ruleMap = ruleRealPaths(absoluteRoot);
  const rows = [];
  const summary = {
    repo,
    sessions: 0,
    chains: 0,
    turns: 0,
    weightedInput: 0,
    placeholderTurns: 0,
  };
  if (!existsSync(slugDir)) {
    process.stderr.write(`agent-ledger: no transcripts for ${repo}\n`);
    return { summary, rows };
  }
  const repoTokens = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  const sessionFiles = readdirSync(slugDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  for (const sessionFile of sessionFiles) {
    summary.sessions += 1;
    const sessionRows = walkSession(slugDir, sessionFile, repo, ruleMap);
    for (const row of sessionRows) {
      summary.chains += 1;
      summary.turns += row.turns;
      summary.placeholderTurns += row.placeholderTurns;
      for (const key of Object.keys(repoTokens))
        repoTokens[key] += row.tokens[key];
      rows.push(row);
    }
  }
  // The report rounds once over the summed tokens, so the repo total does the same.
  summary.weightedInput = weightedInput(repoTokens);
  return { summary, rows };
}

function walkSession(slugDir, sessionFile, repo, ruleMap) {
  const sessionName = sessionFile.replace(/\.jsonl$/, '');
  const session = sessionName.slice(0, ID_PREFIX_LENGTH);
  const mainId = `${repo}/${session}/main`;
  const chains = [];
  const mainRecords = readRecords(join(slugDir, sessionFile));
  chains.push({
    id: mainId,
    records: mainRecords,
    row: foldChain(mainRecords, false, ruleMap),
    meta: undefined,
  });
  const subagentDir = join(slugDir, sessionName, 'subagents');
  if (existsSync(subagentDir)) {
    const subagentFiles = readdirSync(subagentDir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
    for (const file of subagentFiles) {
      const agentId = file.replace(/\.jsonl$/, '').replace(/^agent-/, '');
      const records = readRecords(join(subagentDir, file));
      const metaFile = join(
        subagentDir,
        file.replace(/\.jsonl$/, '.meta.json'),
      );
      if (!existsSync(metaFile))
        process.stderr.write(
          `agent-ledger: ${repo}/${session}: a subagent has no meta file\n`,
        );
      chains.push({
        id: `${repo}/${session}/${agentId.slice(0, ID_PREFIX_LENGTH)}`,
        records,
        row: foldChain(records, true, ruleMap),
        meta: readMeta(metaFile),
      });
    }
  }
  const seenIds = new Set();
  for (const chain of chains) {
    if (seenIds.has(chain.id))
      throw new PolicyError(`chain id ${chain.id} is not unique`);
    seenIds.add(chain.id);
  }
  return chains.map((chain) => buildRow(chain, chains, repo, session));
}

/**
 * The effort a main transcript records: each assistant turn carries a top-level `perTurnEffort`.
 * The value most turns carry wins, a tie goes to the later turn. Null when none is recorded.
 */
function recordedEffort(records) {
  const counts = new Map();
  const seenIds = new Set();
  let winner = null;
  for (const record of records) {
    if (record.type !== 'assistant') continue;
    const id = record.message?.id;
    if (typeof id === 'string') {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    const value = record.perTurnEffort;
    if (!EFFORTS.has(value)) continue;
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (winner === null || count >= counts.get(winner)) winner = value;
  }
  return winner;
}

function buildRow(chain, chains, repo, session) {
  const { row, meta } = chain;
  let parent = null;
  let effort = null;
  if (meta && typeof meta.toolUseId === 'string') {
    const spawner = chains.find((other) =>
      other.row.toolUseIds.has(meta.toolUseId),
    );
    if (spawner) {
      parent = spawner.id;
      const call = findSpawningCall(spawner.records, meta.toolUseId);
      const requested = call?.input?.effort;
      effort = EFFORTS.has(requested) ? requested : null;
    }
  }
  if (!meta) effort = recordedEffort(chain.records);
  const stringOrNull = (value) => (typeof value === 'string' ? value : null);
  return {
    id: chain.id,
    repo,
    session,
    kind: meta ? 'subagent' : 'main',
    agentType: meta ? stringOrNull(meta.agentType) : null,
    spawnDepth: meta && Number.isInteger(meta.spawnDepth) ? meta.spawnDepth : 0,
    parent,
    model: meta ? stringOrNull(meta.model) : null,
    pickedEffortModel: meta ? stringOrNull(meta.pickedEffortModel) : null,
    effort,
    turns: row.turns,
    placeholderTurns: row.placeholderTurns,
    turnsByModel: row.turnsByModel,
    tokens: row.tokens,
    weightedInput: weightedInput(row.tokens),
    firstTs: row.firstTs,
    lastTs: row.lastTs,
    tools: row.tools,
    skills: row.skills,
    ruleLoads: row.ruleLoads,
    series: row.series,
  };
}

/**
 * Walks the output, building each key's schema path, and throws on the first path the key
 * list does not name, the first string that fails its path's policy, or a string at a path
 * with no policy.
 */
function assertConforms(value, path, keyPaths) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return;
  if (typeof value === 'string') {
    const policy = VALUE_POLICY[path];
    if (!policy)
      throw new PolicyError(`a string at ${path}, which has no string policy`);
    if (!policy(value))
      throw new PolicyError(`a string at ${path} fails the string policy`);
    return;
  }
  if (Array.isArray(value)) {
    const elementPath = `${path}[]`;
    if (value.length && !keyPaths.has(elementPath))
      throw new PolicyError(`path ${elementPath} is not in the key list`);
    for (const element of value) assertConforms(element, elementPath, keyPaths);
    return;
  }
  const mapPath = `${path}{}`;
  if (keyPaths.has(mapPath)) {
    const keyPolicy = MAP_KEY_POLICY[mapPath];
    for (const [key, entry] of Object.entries(value)) {
      if (!keyPolicy?.(key))
        throw new PolicyError(
          `a map key at ${mapPath} fails the string policy`,
        );
      assertConforms(entry, mapPath, keyPaths);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const keyPath = path ? `${path}.${key}` : key;
    // The key list names an array or map key by its element path, `a[]` or `a{}`.
    const named = Array.isArray(entry)
      ? keyPaths.has(`${keyPath}[]`)
      : keyPaths.has(keyPath) || keyPaths.has(`${keyPath}{}`);
    if (!named) throw new PolicyError(`path ${keyPath} is not in the key list`);
    assertConforms(entry, keyPath, keyPaths);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const keyPaths = parseKeyPaths(resolveKeysBlock(options.schema));
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const projectsDir = join(base, 'projects');
  const repos = [];
  const rows = [];
  for (const root of options.roots) {
    const walked = walkRepo(root, projectsDir);
    repos.push(walked.summary);
    rows.push(...walked.rows);
  }
  const ledger = {
    schema: SCHEMA_VERSION,
    machine: options.machine,
    generatedAt: new Date().toISOString(),
    repos,
    rows,
  };
  assertConforms(ledger, '', keyPaths);
  const text = JSON.stringify(ledger);
  writeFileSync(options.out, text);
  for (const repo of repos)
    console.log(
      `${repo.repo}: sessions ${repo.sessions} chains ${repo.chains} turns ${repo.turns} weightedInput ${repo.weightedInput} placeholderTurns ${repo.placeholderTurns}`,
    );
  console.log(
    `wrote ${options.out} (${Buffer.byteLength(text, 'utf8')} bytes)`,
  );
}

try {
  main();
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`agent-ledger: ${error.message}\n`);
    process.exit(2);
  }
  if (error instanceof PolicyError) {
    process.stderr.write(`agent-ledger: refused to write: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
