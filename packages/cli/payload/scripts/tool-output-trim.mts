#!/usr/bin/env node
/**
 * PostToolUse(Bash|Read) trimmer. Shortens an oversized text result to its head and tail
 * with an elision line between them, so a runaway command or whole-file read does not fill
 * the context window.
 *
 * Reads the hook payload from stdin. A Bash result is trimmed at `tool_response.stdout`, a
 * Read result at `tool_response.file.content`. A field at or under the cap writes nothing, so
 * the harness keeps the original. Over the cap, writes `hookSpecificOutput.updatedToolOutput`
 * as the FULL tool_response with only that one field replaced. Claude Code ignores a value
 * that does not match the tool's output shape, so a bare string would be dropped silently.
 * Malformed stdin or any other tool exits 0 with no output, because a hook that crashes
 * must never cost the user a tool result.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { readStdinJson } from '@houserules/payload/proc';

// Claude Code persists results of roughly 30 KB and above to disk by itself, so this hook's band
// sits below that. 16 KiB also leaves room for Read's per-line numbering, which lands after the
// hook. The split is head-heavy because the start of a result carries the command's own framing.
const MAX_BYTES = 16384;
const HEAD_BYTES = 12288;
const TAIL_BYTES = 4096;

const NEWLINE = 0x0a;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION = 0x80;

interface HookPayload {
  tool_name?: unknown;
  tool_response?: unknown;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isContinuationByte(byte: number | undefined): boolean {
  return (
    byte !== undefined && (byte & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION
  );
}

/** The head cut back to its last newline, or to a character boundary when it has none. */
function headOf(bytes: Buffer): Buffer {
  let end = HEAD_BYTES;
  const lastNewline = bytes.subarray(0, end).lastIndexOf(NEWLINE);
  if (lastNewline > 0) return bytes.subarray(0, lastNewline + 1);
  while (end > 0 && isContinuationByte(bytes[end])) end--;
  return bytes.subarray(0, end);
}

/** The tail advanced past its first newline, or to a character boundary when it has none. */
function tailOf(bytes: Buffer): Buffer {
  let start = bytes.length - TAIL_BYTES;
  const firstNewline = bytes.subarray(start).indexOf(NEWLINE);
  if (firstNewline >= 0) return bytes.subarray(start + firstNewline + 1);
  while (start < bytes.length && isContinuationByte(bytes[start])) start++;
  return bytes.subarray(start);
}

/** The text unchanged when it fits the cap, else head, an elision line, and tail. */
export function trimText(text: string): string | null {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_BYTES) return null;

  const head = headOf(bytes);
  const tail = tailOf(bytes);
  const elided = bytes.length - head.length - tail.length;
  const marker =
    `\n[houserules tool-output-trim: elided ${elided} bytes of ${bytes.length}; ` +
    `narrow the command or read the file in ranges]\n`;
  return head.toString('utf8') + marker + tail.toString('utf8');
}

/**
 * The replacement tool_response for an oversized payload, or null when nothing needs
 * trimming. Every field other than the trimmed one is carried over as received.
 */
export function trimmedResponse(payload: HookPayload): Json | null {
  const response = payload.tool_response;
  if (!isRecord(response)) return null;

  if (payload.tool_name === 'Bash') {
    if (typeof response['stdout'] !== 'string') return null;
    const stdout = trimText(response['stdout']);
    return stdout === null ? null : { ...response, stdout };
  }

  if (payload.tool_name === 'Read') {
    const file = response['file'];
    if (!isRecord(file) || typeof file['content'] !== 'string') return null;
    const content = trimText(file['content']);
    return content === null
      ? null
      : { ...response, file: { ...file, content } };
  }

  return null;
}

function main(): void {
  try {
    const updated = trimmedResponse(readStdinJson<HookPayload>());
    if (updated === null) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedToolOutput: updated,
        },
      }),
    );
  } catch {
    /* never fail a tool call over a trim */
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
  process.exit(0);
}
