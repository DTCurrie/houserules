import { homedir } from 'node:os';
import { join } from 'node:path';

import { claudeProjectDir } from '@houserules/payload/entry-ledger';

import type { CheckResult } from '@houserules/api';
import {
  describeRetention,
  oldestTranscript,
  resolveRetention,
} from '../../core/transcript-retention.js';
import type { Ctx } from '../../detect.js';

const MS_PER_DAY = 86_400_000;

/**
 * Readouts for how long Claude Code keeps this repo's transcripts and how old the oldest
 * one on disk is. Never produces a finding.
 *
 * @param options.configDir Overrides `CLAUDE_CONFIG_DIR` or `~/.claude`.
 * @param options.now Overrides the clock used for the age of the oldest transcript.
 */
export function checkTranscriptRetention(
  ctx: Ctx,
  options?: { configDir?: string; now?: number },
): CheckResult {
  const top = ctx.git.top ?? ctx.root;
  const configDir =
    options?.configDir ??
    process.env.CLAUDE_CONFIG_DIR ??
    join(homedir(), '.claude');
  const now = options?.now ?? Date.now();
  const projectsDir = join(configDir, 'projects');
  const transcriptDir = join(projectsDir, claudeProjectDir(top, projectsDir));

  const retention = resolveRetention(top, configDir);
  const oldest = oldestTranscript(transcriptDir);
  const oldestLine =
    oldest === null
      ? `no transcripts on disk at ${transcriptDir}`
      : `oldest transcript ${oldest.day} (${Math.floor((now - oldest.mtimeMs) / MS_PER_DAY)} days old)`;
  return {
    findings: [],
    readouts: [describeRetention(retention), oldestLine],
  };
}
