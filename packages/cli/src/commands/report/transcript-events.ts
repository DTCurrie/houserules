import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Stored head of a Bash command. Similarity and denial rendering compare heads only. */
const COMMAND_PREVIEW_LENGTH = 200;

// How a user-typed slash command appears inside a user message.
const COMMAND_NAME_PATTERN = /<command-name>\/([a-z0-9-]+)<\/command-name>/g;

// How the harness encodes a user's permission denial and an interrupt inside a tool_result.
const DENIAL_PREFIX = "The user doesn't want to proceed with this tool use";
const INTERRUPT_PREFIX = '[Request interrupted by user';

/** One hook attachment. Attachments exist only when the hook emitted output. */
export interface HookFire {
  hookName: string;
  exitCode?: number;
  stderr: string;
  content: string;
  durationMs?: number;
  toolUseID?: string;
  /** Tool_use count the session had seen at this fire, anchoring one with no toolUseID. */
  afterToolUseCount: number;
}

interface ToolUse {
  id: string;
  name: string;
  /** First {@link COMMAND_PREVIEW_LENGTH} chars of a Bash command, empty for other tools. */
  command: string;
  /** Set only for a model-initiated Skill tool call. */
  skill?: string;
  ts?: number;
  isSidechain: boolean;
}

interface ToolResultMeta {
  toolUseId?: string;
  bytes: number;
  denied: boolean;
  interrupted: boolean;
}

/** A slash command the user typed. It injects the skill with no Skill tool call. */
interface CommandFire {
  skill: string;
  ts?: number;
}

interface SessionEvents {
  hookFires: HookFire[];
  toolUses: ToolUse[];
  toolUseIndexById: Map<string, number>;
  toolResults: ToolResultMeta[];
  commandFires: CommandFire[];
  /** Interrupts that landed as text blocks in a user message rather than tool_results. */
  interrupts: number;
}

/** Token telemetry for one transcript file, the shape the token section renders. */
export interface FileUsage {
  file: string;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  toolResults: number;
  models: Set<string>;
  sidechainTurns: number;
  skippedLines: number;
}

/**
 * The always-loaded context a session started with, read from the attachments Claude Code
 * writes at session start: the `prompt_snapshot` system prompt, the `instructions` files
 * (CLAUDE.md and auto memory), the `skill_listing`, the initial `agent_listing_delta`, and the
 * `output_style_instructions` prompt. Sizes only, never text or paths, so an export built from
 * this carries nothing to redact. `nested_memory` loads accumulate over the whole session,
 * since a nested CLAUDE.md enters context on demand rather than at start.
 */
interface ResidentCapture {
  sessionId: string;
  ts?: number;
  systemPromptBytes?: number;
  /** One entry per file in the first `instructions` attachment, e.g. `Project`, `AutoMem`. */
  instructionFiles: { type: string; bytes: number }[];
  skillListingBytes?: number;
  skillCount?: number;
  agentListingBytes?: number;
  agentCount?: number;
  outputStyleBytes?: number;
  nestedMemoryLoads: number;
  nestedMemoryBytes: number;
}

export interface Corpus {
  slugs: string[];
  files: FileUsage[];
  unreadableFiles: { file: string; message: string }[];
  missingDirs: string[];
  lines: number;
  skippedLines: number;
  /** Session files left out because they predate {@link CorpusOptions.since}. */
  skippedBySince: number;
  sessions: Map<string, SessionEvents>;
  seenCommandUuids: Set<string>;
  /** Keyed by session id. Start-of-session fields take the first attachment seen. */
  residentCaptures: Map<string, ResidentCapture>;
  /** Every `version` stamp seen on a record, so a report can say which CLI wrote it. */
  claudeVersions: Set<string>;
  /** Earliest and latest timestamped record across the corpus, epoch ms. */
  firstTs?: number;
  lastTs?: number;
}

/** Options for {@link readCorpus}. */
export interface CorpusOptions {
  /**
   * Epoch ms. A session file whose first timestamped record predates it is skipped, along
   * with its subagent transcripts. A file with no timestamps falls back to its mtime.
   */
  since?: number;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ContentBlock {
  type?: string;
  text?: string;
  content?: unknown;
  tool_use_id?: string;
  id?: string;
  name?: string;
  input?: { command?: unknown; skill?: unknown };
}

interface TranscriptMessage {
  role?: string;
  model?: string;
  usage?: Usage;
  content?: unknown;
}

interface HookAttachment {
  type?: string;
  hookName?: string;
  exitCode?: number;
  stderr?: string;
  content?: unknown;
  durationMs?: number;
  toolUseID?: string;
  /** Session-start attachments: `prompt_snapshot`, `instructions`, `skill_listing`, and so on. */
  systemPrompt?: unknown;
  files?: unknown;
  skillCount?: unknown;
  addedLines?: unknown;
  addedTypes?: unknown;
  isInitial?: unknown;
  style?: unknown;
}

/**
 * One transcript line, only the fields the reader consumes. The format is Claude Code
 * internal and unversioned, so every field is optional and read defensively.
 */
interface TranscriptRecord {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  version?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  attachment?: HookAttachment;
  message?: TranscriptMessage;
}

export function emptyCorpus(slugs: string[]): Corpus {
  return {
    slugs,
    files: [],
    unreadableFiles: [],
    missingDirs: [],
    lines: 0,
    skippedLines: 0,
    skippedBySince: 0,
    sessions: new Map(),
    seenCommandUuids: new Set(),
    residentCaptures: new Map(),
    claudeVersions: new Set(),
  };
}

/**
 * Reads every `.jsonl` transcript under each slug's directory into one corpus. A missing
 * directory is recorded, an unreadable file is recorded and skipped, a bad line is counted
 * and skipped. Nothing here throws on transcript content.
 */
export function readCorpus(
  projectsBase: string,
  slugs: string[],
  options: CorpusOptions = {},
): Corpus {
  const corpus = emptyCorpus(slugs);
  for (const slug of slugs) {
    const dir = join(projectsBase, slug);
    if (!existsSync(dir)) {
      corpus.missingDirs.push(dir);
      continue;
    }
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(join(dir, file), 'utf8');
        if (
          options.since !== undefined &&
          startedAt(text, join(dir, file)) < options.since
        ) {
          corpus.skippedBySince += 1;
          continue;
        }
      } catch (error) {
        corpus.unreadableFiles.push({
          file,
          message: (error as Error).message,
        });
        continue;
      }
      const usage = createFileUsage(file);
      corpus.files.push(usage);
      ingestTranscript(corpus, file, text, usage);
      // Subagent transcripts live in `<session>/subagents/*.jsonl` and carry the parent's
      // sessionId, so their tokens and skill invocations fold into the parent session row.
      const subDir = join(dir, file.replace(/\.jsonl$/, ''), 'subagents');
      if (!existsSync(subDir)) continue;
      for (const subFile of readdirSync(subDir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()) {
        try {
          ingestTranscript(
            corpus,
            subFile,
            readFileSync(join(subDir, subFile), 'utf8'),
            usage,
          );
        } catch (error) {
          corpus.unreadableFiles.push({
            file: join(file.replace(/\.jsonl$/, ''), 'subagents', subFile),
            message: (error as Error).message,
          });
        }
      }
    }
  }
  return corpus;
}

function firstTimestamp(text: string): number | undefined {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    const ts = Date.parse(record.timestamp ?? '');
    if (ts) return ts;
  }
  return undefined;
}

function startedAt(text: string, path: string): number {
  return firstTimestamp(text) ?? statSync(path).mtimeMs;
}

function createFileUsage(file: string): FileUsage {
  return {
    file,
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolResults: 0,
    models: new Set(),
    sidechainTurns: 0,
    skippedLines: 0,
  };
}

/**
 * One pass over a transcript's lines, feeding both the per-file token aggregate and the
 * per-session event lists. Records with no sessionId fall back to the file name as the
 * session key. Pass `into` to fold a subagent transcript's tokens and events into its
 * parent session's row rather than opening a new one.
 */
export function ingestTranscript(
  corpus: Corpus,
  file: string,
  text: string,
  into?: FileUsage,
): void {
  const usage = into ?? createFileUsage(file);
  if (!into) corpus.files.push(usage);
  // A subagent transcript (folded into `into`) belongs to its parent session, so a record
  // there with no sessionId falls back to the parent's id, never the agent file name.
  const fallbackSession = (into?.file ?? file).replace(/\.jsonl$/, '');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    corpus.lines += 1;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      corpus.skippedLines += 1;
      usage.skippedLines += 1;
      continue;
    }
    trackRecordStamps(record, corpus);
    aggregateUsage(record, usage);
    extractEvents(record, fallbackSession, corpus);
  }
}

/** Every skill invocation: model Skill tool calls plus user-typed slash commands. */
export interface SkillFire {
  skill: string;
  ts?: number;
  sessionId: string;
  source: 'model' | 'user';
}

export function skillFires(corpus: Corpus, skillName?: string): SkillFire[] {
  const fires: SkillFire[] = [];
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

// Token aggregation matches the original report command exactly, keying on type OR role,
// so promoting the metrics families leaves the token section's numbers unchanged.
function aggregateUsage(record: TranscriptRecord, usage: FileUsage): void {
  const msg = record.message ?? {};
  if (record.type === 'assistant' || msg.role === 'assistant') {
    usage.turns += 1;
    if (record.isSidechain) usage.sidechainTurns += 1;
    if (msg.model) usage.models.add(msg.model);
    const u = msg.usage ?? {};
    usage.input += u.input_tokens ?? 0;
    usage.output += u.output_tokens ?? 0;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
  } else if (record.type === 'user' || msg.role === 'user') {
    const content = msg.content;
    if (Array.isArray(content))
      usage.toolResults += content.filter(
        (b) => (b as ContentBlock)?.type === 'tool_result',
      ).length;
  }
}

function sessionOf(corpus: Corpus, id: string): SessionEvents {
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

function extractEvents(
  record: TranscriptRecord,
  fallbackSession: string,
  corpus: Corpus,
): void {
  const sessionId = record.sessionId ?? fallbackSession;
  const session = sessionOf(corpus, sessionId);
  const attachment = record.attachment;
  if (attachment?.type && RESIDENT_ATTACHMENT_TYPES.has(attachment.type)) {
    recordResidentCapture(record, attachment, sessionId, corpus);
    return;
  }
  if (record.type === 'attachment' && attachment?.hookName) {
    session.hookFires.push({
      hookName: attachment.hookName,
      exitCode: attachment.exitCode,
      stderr: attachment.stderr ?? '',
      content: typeof attachment.content === 'string' ? attachment.content : '',
      durationMs: attachment.durationMs,
      toolUseID: attachment.toolUseID,
      afterToolUseCount: session.toolUses.length,
    });
    return;
  }
  const message = record.message;
  if (record.type === 'user') scanUserCommands(record, session, corpus);
  if (record.type === 'user' && Array.isArray(message?.content)) {
    for (const block of message.content as ContentBlock[]) {
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
  for (const block of message.content as ContentBlock[]) {
    if (
      block?.type !== 'tool_use' ||
      typeof block.id !== 'string' ||
      typeof block.name !== 'string'
    )
      continue;
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

function trackRecordStamps(record: TranscriptRecord, corpus: Corpus): void {
  if (typeof record.version === 'string')
    corpus.claudeVersions.add(record.version);
  const ts = Date.parse(record.timestamp ?? '');
  if (!ts) return;
  if (corpus.firstTs === undefined || ts < corpus.firstTs) corpus.firstTs = ts;
  if (corpus.lastTs === undefined || ts > corpus.lastTs) corpus.lastTs = ts;
}

const RESIDENT_ATTACHMENT_TYPES = new Set([
  'prompt_snapshot',
  'instructions',
  'skill_listing',
  'agent_listing_delta',
  'output_style_instructions',
  'nested_memory',
]);

function utf8Bytes(value: unknown): number {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

function joinedBytes(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.reduce<number>((sum, part) => sum + utf8Bytes(part), 0);
}

function captureOf(corpus: Corpus, sessionId: string): ResidentCapture {
  let capture = corpus.residentCaptures.get(sessionId);
  if (!capture) {
    capture = {
      sessionId,
      instructionFiles: [],
      nestedMemoryLoads: 0,
      nestedMemoryBytes: 0,
    };
    corpus.residentCaptures.set(sessionId, capture);
  }
  return capture;
}

// Start-of-session attachments keep the first value seen, so a resumed session that replays
// them does not double count. Nested memory accumulates, since every load costs context.
function recordResidentCapture(
  record: TranscriptRecord,
  attachment: HookAttachment,
  sessionId: string,
  corpus: Corpus,
): void {
  const capture = captureOf(corpus, sessionId);
  capture.ts ??= Date.parse(record.timestamp ?? '') || undefined;
  switch (attachment.type) {
    case 'prompt_snapshot':
      capture.systemPromptBytes ??= joinedBytes(attachment.systemPrompt);
      return;
    case 'instructions':
      if (
        capture.instructionFiles.length === 0 &&
        Array.isArray(attachment.files)
      )
        capture.instructionFiles = attachment.files.map((file) => {
          const entry = (file ?? {}) as { type?: unknown; content?: unknown };
          return {
            type: typeof entry.type === 'string' ? entry.type : 'unknown',
            bytes: utf8Bytes(entry.content),
          };
        });
      return;
    case 'skill_listing':
      capture.skillListingBytes ??= utf8Bytes(attachment.content);
      capture.skillCount ??=
        typeof attachment.skillCount === 'number'
          ? attachment.skillCount
          : undefined;
      return;
    case 'agent_listing_delta':
      if (attachment.isInitial !== true) return;
      capture.agentListingBytes ??= joinedBytes(attachment.addedLines);
      capture.agentCount ??= Array.isArray(attachment.addedTypes)
        ? attachment.addedTypes.length
        : undefined;
      return;
    case 'output_style_instructions': {
      const style = (attachment.style ?? {}) as { prompt?: unknown };
      capture.outputStyleBytes ??= utf8Bytes(style.prompt);
      return;
    }
    case 'nested_memory': {
      const content = (attachment.content ?? {}) as
        { content?: unknown } | string;
      capture.nestedMemoryLoads += 1;
      capture.nestedMemoryBytes += utf8Bytes(
        typeof content === 'string' ? content : content.content,
      );
      return;
    }
    default:
      return;
  }
}

// Resumed sessions copy prior messages forward, so command fires dedupe on the message uuid.
function scanUserCommands(
  record: TranscriptRecord,
  session: SessionEvents,
  corpus: Corpus,
): void {
  if (record.isMeta === true) return;
  if (typeof record.uuid === 'string') {
    if (corpus.seenCommandUuids.has(record.uuid)) return;
    corpus.seenCommandUuids.add(record.uuid);
  }
  for (const text of textParts(record.message?.content))
    for (const match of text.matchAll(COMMAND_NAME_PATTERN))
      if (match[1] !== undefined)
        session.commandFires.push({
          skill: match[1],
          ts: Date.parse(record.timestamp ?? '') || undefined,
        });
}

function textParts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return (content as ContentBlock[])
    .filter(
      (part): part is ContentBlock & { text: string } =>
        part?.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text);
}
