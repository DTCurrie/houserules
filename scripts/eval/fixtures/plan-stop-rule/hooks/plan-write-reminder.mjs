#!/usr/bin/env node
/**
 * PostToolUse hook for the `fix3-p3` arm: the plan-project stop rule made mechanical. Reads the
 * session transcript the payload's `transcript_path` names, counts the main thread's non-writing
 * tool calls after `plan-project` fires and before the first Write or Edit under `.claude/plans/`,
 * and at the tenth prints one `additionalContext` reminder to write the plan files now. The count
 * mirrors the waste audit's `plan-read-before-write` rule in `scripts/health-kit/gather/`.
 *
 *   node plan-write-reminder.mjs < payload.json
 *
 * The payload's own call joins the count when the transcript does not hold its id yet. Prints
 * nothing on any other call. Exits 0 and prints nothing on any failure, so it never blocks a call.
 */
import { readFileSync } from 'node:fs';

const REMINDER_AT_CALL = 10;
const PLANS_PATH = '.claude/plans/';
const PLAN_COMMAND = /<command-name>\/plan-project<\/command-name>/;
const PLAN_SKILL = /(?:^|:)plan-project$/;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const PLAN_WRITE_TOOLS = new Set(['Write', 'Edit']);
const REMINDER =
  'plan-project: ten calls since the skill fired and no plan file written. Write the plan files now and turn open questions into phase steps.';

/** The text of a user record, joined from its string or text blocks. */
function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * The session's events in order: `fire` for a `/plan-project` prompt and `call` for each main
 * thread tool_use, each id once. Other record types, such as `api-request-blob`, repeat earlier
 * tool_use blocks and are skipped.
 */
function readEvents(transcript) {
  const events = [];
  const seen = new Set();
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    const record = JSON.parse(line);
    if (record.isSidechain === true) continue;
    const content = record.message?.content;
    if (record.type === 'user' && record.isMeta !== true) {
      if (PLAN_COMMAND.test(userText(content))) events.push({ type: 'fire' });
      continue;
    }
    if (record.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use' || seen.has(block.id)) continue;
      seen.add(block.id);
      events.push({
        type: 'call',
        id: block.id,
        name: block.name ?? '',
        input: block.input ?? {},
      });
    }
  }
  return events;
}

const isFire = (event) =>
  event.type === 'fire' ||
  (event.name === 'Skill' && PLAN_SKILL.test(String(event.input.skill ?? '')));

function isPlanWrite(call) {
  const path = call.input.file_path;
  return (
    PLAN_WRITE_TOOLS.has(call.name) &&
    typeof path === 'string' &&
    path.includes(PLANS_PATH)
  );
}

/**
 * The non-writing calls between the first plan-project fire and the first plan write, with
 * `hasWrittenPlan` true once that write happened. Null before any fire.
 */
function countBeforePlanWrite(events) {
  let hasFired = false;
  let calls = 0;
  for (const event of events) {
    if (!hasFired) {
      hasFired = isFire(event);
      continue;
    }
    if (event.type !== 'call') continue;
    if (isPlanWrite(event)) return { calls, hasWrittenPlan: true };
    if (!WRITE_TOOLS.has(event.name)) calls += 1;
  }
  return hasFired ? { calls, hasWrittenPlan: false } : null;
}

/**
 * The events up to and including the payload's call. A parallel batch writes every tool_use to
 * the transcript before the first runs, so calls after the current one are cut.
 */
function eventsThroughCurrent(events, payload) {
  const id = payload.tool_use_id;
  const at = events.findIndex(
    (event) => event.type === 'call' && event.id === id,
  );
  if (at >= 0) return events.slice(0, at + 1);
  return [
    ...events,
    {
      type: 'call',
      id,
      name: String(payload.tool_name ?? ''),
      input: payload.tool_input ?? {},
    },
  ];
}

/** The reminder for this payload, or null unless its call is the tenth non-writing one. */
function reminderFor(payload) {
  const all = readEvents(readFileSync(payload.transcript_path, 'utf8'));
  const events = eventsThroughCurrent(all, payload);
  if (WRITE_TOOLS.has(events.at(-1).name)) return null;
  const count = countBeforePlanWrite(events);
  if (!count || count.hasWrittenPlan || count.calls !== REMINDER_AT_CALL)
    return null;
  return REMINDER;
}

function main() {
  try {
    const reminder = reminderFor(JSON.parse(readFileSync(0, 'utf8')));
    if (!reminder) return;
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: reminder,
        },
      })}\n`,
    );
  } catch {
    // A hook failure must never block the call it rides on, so any error prints nothing.
  }
}

main();
process.exitCode = 0;
