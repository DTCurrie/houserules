import { existsSync, readdirSync } from 'node:fs';

import type { Corpus } from './transcript-events.js';
import { skillFires } from './transcript-events.js';
import { renderTable } from './render-table.js';

interface SkillCount {
  skill: string;
  model: number;
  user: number;
}

export interface SkillAdoptionReport {
  counts: SkillCount[];
  installed: string[];
  dead: string[];
  toolsetActiveSessions: number;
  totalSessions: number;
}

export function computeSkillAdoption(
  corpus: Corpus,
  skillsDir: string,
): SkillAdoptionReport {
  const bySkill = new Map<string, { model: number; user: number }>();
  for (const fire of skillFires(corpus)) {
    const row = bySkill.get(fire.skill) ?? { model: 0, user: 0 };
    row[fire.source] += 1;
    bySkill.set(fire.skill, row);
  }
  const counts: SkillCount[] = [...bySkill.entries()]
    .map(([skill, row]) => ({ skill, model: row.model, user: row.user }))
    .sort((a, b) => b.model + b.user - (a.model + a.user));

  const installed = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  const dead = installed.filter((name) => !bySkill.has(name));

  let toolsetActiveSessions = 0;
  for (const session of corpus.sessions.values())
    if (session.hookFires.length > 0) toolsetActiveSessions += 1;

  return {
    counts,
    installed,
    dead,
    toolsetActiveSessions,
    totalSessions: corpus.sessions.size,
  };
}

export function renderSkillAdoption(report: SkillAdoptionReport): string[] {
  const lines = ['-- skills --', ''];
  if (report.counts.length) {
    lines.push(
      ...renderTable(
        ['skill', 'model', 'user', 'total'],
        report.counts.map((row) => [
          row.skill,
          row.model,
          row.user,
          row.model + row.user,
        ]),
      ),
      '',
      '  (model = Skill tool invocations; user = typed slash commands, built-ins included)',
    );
  } else {
    lines.push('  no skill fires in this corpus');
  }
  lines.push(
    `  toolset-active sessions: ${report.toolsetActiveSessions} of ${report.totalSessions} (any hook fire; adoption reads against these)`,
  );
  if (report.installed.length)
    lines.push(
      '',
      `  dead skills (installed, zero fires): ${report.dead.join(', ') || 'none'}`,
      '  (an unfired skill leaves no transcript trace, so dead cannot tell ignored from newly installed)',
    );
  return lines;
}
