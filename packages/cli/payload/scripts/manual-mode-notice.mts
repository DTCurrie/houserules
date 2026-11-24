#!/usr/bin/env node
/**
 * UserPromptSubmit hook. When the session is in manual mode, where the user approves each edit,
 * and the prompt invokes `/orchestrate` or `/sweep`, prints one line warning that every edit a
 * subagent makes raises its own permission prompt. Any other prompt or mode prints nothing.
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
}

const NOTICE =
  '[houserules] Manual mode: every edit a subagent makes raises its own permission prompt in this session.\n';
const LEADING_INVOCATION = /^\s*\/(?:orchestrate|sweep)(?:\s|$)/;
const COMMAND_NAME_TAG =
  /<command-name>\s*\/?(?:orchestrate|sweep)\s*<\/command-name>/;

/** Whether `prompt` invokes the `orchestrate` or `sweep` skill. */
function invokesSubagentSkill(prompt: string): boolean {
  return LEADING_INVOCATION.test(prompt) || COMMAND_NAME_TAG.test(prompt);
}

function main(): void {
  try {
    const input = readStdinJson<PromptPayload>();
    // Claude Code has used both `prompt` and `prompt_text` for this event across versions.
    const prompt = String(input?.prompt ?? input?.prompt_text ?? '');
    if (isManualMode(input) && invokesSubagentSkill(prompt)) {
      process.stdout.write(NOTICE);
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
