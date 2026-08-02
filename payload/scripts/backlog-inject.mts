#!/usr/bin/env node
/**
 * UserPromptSubmit hook. Prints the decoded log record for any backlog ID the prompt
 * mentions, which the hook runner adds to the turn's context.
 *
 * Only IDs that exist in .claude/backlog.log are injected. Every failure path exits 0 and
 * prints nothing, because an injector must never block a prompt.
 */

import { gunzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { repoRoot } from './lib/kit-config.mjs';
import { BACKLOG_ID } from './lib/backlog-id.mjs';
import { readStdinJson } from './lib/proc.mjs';

interface PromptPayload {
  prompt?: string;
  prompt_text?: string;
}

interface BacklogRecord {
  id?: string;
  action?: string;
  title?: string;
  file?: string;
  content?: string;
}

try {
  const input = readStdinJson<PromptPayload>();
  // Claude Code has used both `prompt` and `prompt_text` for this event across
  // versions — accept either so the injector doesn't silently no-op on one build.
  const prompt = String(input?.prompt ?? input?.prompt_text ?? '');
  if (!prompt) process.exit(0);

  const ids = [...new Set(prompt.match(BACKLOG_ID) ?? [])];
  if (!ids.length) process.exit(0);

  const root = repoRoot();
  const logFile = resolve(root, '.claude/backlog.log');
  if (!existsSync(logFile)) process.exit(0);

  // Latest add/update record per id (later lines win); remove tombstones the entry.
  const latest = new Map<string, BacklogRecord>();
  const removed = new Set<string>();
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    if (!line) continue;
    let r: BacklogRecord;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r?.id) continue;
    if (r.action === 'remove') {
      removed.add(r.id);
      latest.delete(r.id);
    } else if (r.action === 'add' || r.action === 'update') {
      removed.delete(r.id);
      latest.set(r.id, r);
    }
  }

  const blocks: string[] = [];
  for (const id of ids) {
    const r = latest.get(id);
    if (!r || removed.has(id)) continue; // unknown/removed ID → inject nothing
    let body = '';
    try {
      body = r.content
        ? gunzipSync(Buffer.from(r.content, 'base64')).toString('utf8')
        : '';
    } catch {
      body = '';
    }
    blocks.push(
      `[kit backlog] ${id} — ${r.title ?? '(untitled)'}${r.file ? ` (${r.file})` : ''}\n${body}`.trim(),
    );
  }

  if (blocks.length)
    process.stdout.write(
      `Referenced backlog item(s), decoded from .claude/backlog.log:\n\n${blocks.join('\n\n')}\n`,
    );
} catch {
  /* never block a prompt */
}
process.exit(0);
