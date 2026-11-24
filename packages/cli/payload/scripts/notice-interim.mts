#!/usr/bin/env node
/**
 * UserPromptSubmit hook. When the prompt is a background agent's interim notice, the one saying
 * the agent waits on its own background work and has not reported, prints one instruction line,
 * which the hook runner adds to the turn's context. Any other prompt prints nothing.
 *
 * Every failure path exits 0 and prints nothing, because a hook must never block a prompt.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readStdinJson } from '@houserules/payload/proc';

interface PromptPayload {
  prompt?: string;
  prompt_text?: string;
}

const NOTICE_OPENING = /^<task-notification>/;
const NOTICE_BLOCK = /<task-notification>[\s\S]*?<\/task-notification>/g;
const INTERIM_SUMMARY =
  /<summary>\s*Agent .* is waiting on its own background work\s*<\/summary>/;
const TASK_ID = /<task-id>\s*([^<\s]+)\s*<\/task-id>/;

/**
 * The task ids of the interim notices `prompt` carries, or an empty list when the prompt is
 * anything else. A prompt that batches an interim notice with any other kind, such as a
 * `finished` notice or a hand-back, returns an empty list, since that turn has work to do.
 */
export function interimTaskIds(prompt: string): string[] {
  if (!NOTICE_OPENING.test(prompt)) return [];
  const blocks = prompt.match(NOTICE_BLOCK) ?? [];
  if (blocks.length === 0) return [];
  if (prompt.replace(NOTICE_BLOCK, '').trim() !== '') return [];
  const ids: string[] = [];
  for (const block of blocks) {
    if (!INTERIM_SUMMARY.test(block)) return [];
    ids.push(block.match(TASK_ID)?.[1] ?? 'unknown');
  }
  return ids;
}

/** The instruction line for a turn opened by the interim notices of `taskIds`. */
function interimInstruction(taskIds: readonly string[]): string {
  return `[houserules] Interim notice, agent ${taskIds.join(', ')} has not reported. Do not review its work. Send each message owed to an orchestrator whose \`finished\` notice has arrived. Otherwise reply with one line naming what is still running, and make no tool call.\n`;
}

function main(): void {
  try {
    const input = readStdinJson<PromptPayload>();
    // Claude Code has used both `prompt` and `prompt_text` for this event across versions.
    const prompt = String(input?.prompt ?? input?.prompt_text ?? '');
    const ids = interimTaskIds(prompt);
    if (ids.length > 0) process.stdout.write(interimInstruction(ids));
  } catch {
    /* never block a prompt */
  }
  process.exit(0);
}

function isMainModule(): boolean {
  try {
    return (
      !!process.argv[1] &&
      fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
}

if (isMainModule()) main();
