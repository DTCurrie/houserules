import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { CheckResult, Finding } from '@houserules/api';
import { splitFrontmatter } from '../../core/frontmatter.js';

// Claude Code re-injects an invoked skill after compaction capped at 5,000 tokens per skill,
// keeping the start of the file and dropping the tail
// (https://code.claude.com/docs/en/context-window.md). At chars/4 that is 20,000 bytes.
const SKILL_BODY_CAP_BYTES = 20_000;

function listSkills(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function readBodyBytes(path: string): number | null {
  try {
    const { body } = splitFrontmatter(readFileSync(path, 'utf8'));
    return Buffer.byteLength(body);
  } catch {
    return null;
  }
}

/**
 * Warns for each installed skill whose SKILL.md body, the bytes after the frontmatter, is
 * over the re-injection cap, since compaction then loses the tail of the skill.
 */
export function checkSkillBodySize(root: string): CheckResult {
  const skillsDir = join(root, '.claude', 'skills');
  const sizes = listSkills(skillsDir).flatMap((name) => {
    const bytes = readBodyBytes(join(skillsDir, name, 'SKILL.md'));
    return bytes === null ? [] : [{ name, bytes }];
  });
  if (sizes.length === 0) return { findings: [], readouts: [] };

  const findings: Finding[] = sizes
    .filter(({ bytes }) => bytes > SKILL_BODY_CAP_BYTES)
    .map(({ name, bytes }) => ({
      level: 'WARN',
      msg: `.claude/skills/${name}/SKILL.md body is ${bytes} bytes, over the ${SKILL_BODY_CAP_BYTES}-byte cap. Compaction re-injects only the first 5,000 tokens of a skill, so the tail is lost. Move detail into the skill's references.`,
    }));
  const largest = Math.max(...sizes.map(({ bytes }) => bytes));
  return {
    findings,
    readouts: [
      `${sizes.length} installed ${sizes.length === 1 ? 'skill' : 'skills'} measured, largest body ${largest} bytes`,
    ],
  };
}
