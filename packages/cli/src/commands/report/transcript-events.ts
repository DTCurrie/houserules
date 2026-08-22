import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

export interface Corpus {
  slugs: string[];
  files: FileUsage[];
  unreadableFiles: { file: string; message: string }[];
  missingDirs: string[];
  lines: number;
  skippedLines: number;
  sessions: Map<string, SessionEvents>;
  seenCommandUuids: Set<string>;
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
  hookName?: string;
  exitCode?: number;
  stderr?: string;
  content?: string;
  durationMs?: number;
  toolUseID?: string;
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
    sessions: new Map(),
    seenCommandUuids: new Set(),
  };
}

/**
 * Reads every `.jsonl` transcript under each slug's directory into one corpus. A missing
 * directory is recorded, an unreadable file is recorded and skipped, a bad line is counted
 * and skipped. Nothing here throws on transcript content.
 */
export function readCorpus(projectsBase: string, slugs: string[]): Corpus {
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
      } catch (error) {
        corpus.unreadableFiles.push({
          file,
          message: (error as Error).message,
        });
        continue;
      }
      ingestTranscript(corpus, file, text);
    }
  }
  return corpus;
}

/**
 * One pass over a transcript's lines, feeding both the per-file token aggregate and the
 * per-session event lists. Records with no sessionId fall back to the file name as the
 * session key.
 */
export function ingestTranscript(
  corpus: Corpus,
  file: string,
  text: string,
): void {
  const usage: FileUsage = {
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
  corpus.files.push(usage);
  const fallbackSession = file.replace(/\.jsonl$/, '');
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
  const session = sessionOf(corpus, record.sessionId ?? fallbackSession);
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
