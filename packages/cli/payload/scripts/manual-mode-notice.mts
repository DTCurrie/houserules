#!/usr/bin/env node
/**
 * UserPromptSubmit and PreToolUse (Skill) hook. When the session is in manual mode, where the
 * user approves each edit, and the user types `/orchestrate` or `/sweep` or the model invokes
 * that skill, warns that every edit a subagent makes raises its own permission prompt. A typed
 * command prints plain stdout. A Skill tool call returns `additionalContext` and no decision.
 * Any other prompt, tool call, or mode prints nothing.
 *
 * Every failure path exits 0 and prints nothing, because a hook must never block a prompt.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isManualMode } from '@houserules/payload/permission-mode';
import { readStdinJson } from '@houserules/payload/proc';

interface PromptPayload {
  prompt?: string;
  prompt_text?: string;
  permission_mode?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { skill?: unknown; name?: unknown };
}

const NOTICE =
  '[houserules] Manual mode: every edit a subagent makes raises its own permission prompt in this session.\n';
const LEADING_INVOCATION = /^\s*\/(?:orchestrate|sweep)(?:\s|$)/;
const COMMAND_NAME_TAG =
  /<command-name>\s*\/?(?:orchestrate|sweep)\s*<\/command-name>/;

const SKILL_NAME = /^\/?(?:[^\s:]+:)?(?:orchestrate|sweep)$/;

/** Whether `prompt` invokes the `orchestrate` or `sweep` skill. */
function invokesSubagentSkill(prompt: string): boolean {
  return LEADING_INVOCATION.test(prompt) || COMMAND_NAME_TAG.test(prompt);
}

/** Whether a Skill tool call names `orchestrate` or `sweep`, bare or plugin-namespaced. */
function callsSubagentSkill(input: PromptPayload): boolean {
  if (input.tool_name !== 'Skill') return false;
  const name = String(
    input.tool_input?.skill ?? input.tool_input?.name ?? '',
  ).trim();
  return SKILL_NAME.test(name);
}

function main(): void {
  try {
    const input = readStdinJson<PromptPayload>();
    if (!input || !isManualMode(input)) {
      process.exit(0);
    }
    if (input.hook_event_name === 'PreToolUse') {
      // additionalContext only: no permissionDecision, so this hook never allows or denies the call.
      if (callsSubagentSkill(input)) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: NOTICE.trim(),
            },
          }),
        );
      }
    } else {
      // Claude Code has used both `prompt` and `prompt_text` for this event across versions.
      const prompt = String(input.prompt ?? input.prompt_text ?? '');
      if (invokesSubagentSkill(prompt)) process.stdout.write(NOTICE);
    }
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
