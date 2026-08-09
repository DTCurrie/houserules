import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { frontmatterBlock, splitFrontmatter } from '../../core/frontmatter.js';
import type { CheckResult, Finding } from './finding.js';

/**
 * The tools an agent's frontmatter grants, or null when it names none.
 *
 * Null is not the empty set. An agent with no `tools:` line inherits every tool the session
 * has, `Bash` included, so a caller asking "is Bash granted here" has to read null as yes.
 */
export function grantedTools(text: string): string[] | null {
  const frontmatter = frontmatterBlock(text);
  if (frontmatter === null) return null;
  const lines = frontmatter.split('\n');
  const at = lines.findIndex((line) => /^tools:/.test(line));
  if (at === -1) return null;
  const unquote = (value: string) => value.trim().replace(/^['"]|['"]$/g, '');
  const inline = lines[at].slice('tools:'.length).trim();
  if (inline)
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(unquote)
      .filter(Boolean);
  const entries: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const entry = /^\s*-\s*(.+)$/.exec(lines[i]);
    if (!entry) break;
    entries.push(unquote(entry[1]));
  }
  return entries;
}

export function grantsBash(text: string): boolean {
  const tools = grantedTools(text);
  if (tools === null) return true;
  return tools.some((tool) => tool === 'Bash' || tool === '*');
}

/**
 * The two shapes that bound what `Bash` may run, as the shipped reviewers spell them.
 *
 * A denylist names the commands that are off limits, "never run `add`, `remove`". An
 * allowlist names the ones that are not and closes the set with "only". Either answers the
 * question a reader has, which is what `Bash` is for here.
 *
 * Deliberately permissive. A missed violation costs one un-caught agent, while a warning on
 * a compliant one teaches everybody to ignore the check.
 */
const BASH_LIMIT_SHAPES = [
  /never\s+run\b/i,
  /never\s+use\s+`?bash`?/i,
  /`?\bbash\b`?[\s\S]{0,80}?\bonly\b/i,
];

const claimsReadOnly = (text: string) => /read[- ]only/i.test(text);

const boundsBash = (text: string) =>
  BASH_LIMIT_SHAPES.some((shape) => shape.test(text));

/**
 * Whether every agent that calls itself read-only while holding `Bash` says what `Bash` may
 * not run.
 *
 * `tools: Read, Grep, Bash` plus the words "read-only" is a contradiction the model resolves
 * however it likes, and `Bash` is the one granted tool that can write. The four shipped
 * reviewers all close it in prose, and the check exists so the fifth one does too. It reads
 * user-authored agents the same way, which is where the mistake is likelier.
 *
 * A WARN, never an ERROR. This is a heuristic over prose, and a heuristic does not get to
 * fail a run.
 */
export function checkAgentToolScope(root: string): CheckResult {
  const findings: Finding[] = [];
  let inspected = 0;
  let names: string[];
  try {
    names = readdirSync(join(root, '.claude', 'agents')).filter((file) =>
      file.endsWith('.md'),
    );
  } catch {
    return { findings, readouts: [] };
  }
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(root, '.claude', 'agents', name), 'utf8');
    } catch {
      continue;
    }
    inspected += 1;
    if (!grantsBash(text)) continue;
    const { body } = splitFrontmatter(text);
    if (!claimsReadOnly(text)) continue;
    if (boundsBash(body)) continue;
    findings.push({
      level: 'WARN',
      msg: `.claude/agents/${name}: calls itself read-only and grants Bash, but never says what Bash may not run. Name the commands it may run and close the set with "only", or list the ones it must never run.`,
    });
  }
  const readouts = inspected
    ? [`agent tool scope: ${inspected} agent(s) inspected`]
    : [];
  return { findings, readouts };
}
