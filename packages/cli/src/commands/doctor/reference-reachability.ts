import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import type { Ctx } from '../../detect.js';
import type { CheckResult, Finding } from '@agent-kit/api';

const REFERENCE_DIR = join('.claude', 'reference');

/**
 * Every `.claude/reference/*.md` path a file points at, in either spelling.
 *
 * A rule reaches the directory as `../reference/x.md`, relative to `.claude/rules/`. A skill
 * reaches it as `.claude/reference/x.md`, relative to the repo root. Both are real, and
 * `accessibility.md` and `accessibility-review/SKILL.md` are one installed pair using one
 * each. The wrapper around the path does not matter: backticks, a markdown link target, or
 * bare prose all mean the same thing to a reader. A trailing `#anchor` falls outside the
 * match and is ignored.
 */
export function referenceLinksIn(text: string): string[] {
  const links = [
    ...text.matchAll(/(?:\.\.|\.claude)\/reference\/[^\s`)"'<>]+\.md/g),
  ];
  return links.map((match) => match[0]);
}

/** Every installed file that could route a reader to a reference doc. */
function linkSources(root: string): string[] {
  const sources: string[] = [];
  const filesIn = (...segments: string[]) => {
    try {
      return readdirSync(join(root, ...segments));
    } catch {
      return [];
    }
  };
  for (const name of filesIn('.claude', 'rules'))
    if (name.endsWith('.md')) sources.push(join('.claude', 'rules', name));
  for (const name of filesIn('.claude', 'agents'))
    if (name.endsWith('.md')) sources.push(join('.claude', 'agents', name));
  for (const name of filesIn('.claude', 'skills'))
    sources.push(join('.claude', 'skills', name, 'SKILL.md'));
  return sources.filter((rel) => existsSync(join(root, rel)));
}

const resolveLink = (root: string, source: string, link: string) =>
  link.startsWith('.claude/')
    ? resolve(root, link)
    : resolve(dirname(join(root, source)), link);

/**
 * Whether the installed reference docs and the links into them agree, in both directions.
 *
 * A DANGLING link is a rule telling the model to read a file that is not installed, which is
 * what an unconditional link to an optional doc produces. An ORPHAN doc is one nothing points
 * at, so the model never learns it exists and the install paid for prose no one reads.
 *
 * Reading the tree as INSTALLED is what makes conditional installation a non-issue. A doc the
 * user did not choose is not on disk and no installed rule links it, so both directions are
 * silent without needing to know anything about options.
 *
 * The two directions are scoped differently, on purpose. A dangling link is wrong whoever
 * wrote either end, so that half reads every file. The orphan half is about docs the KIT
 * installed, so it reads only manifest-tracked ones. A doc you dropped into
 * `.claude/reference/` yourself is yours, and the kit telling you to go link it is
 * presumptuous.
 */
export function checkReferenceReachability(
  root: string,
  ctx: Ctx,
): CheckResult {
  let docs: string[];
  try {
    docs = readdirSync(join(root, REFERENCE_DIR)).filter((name) =>
      name.endsWith('.md'),
    );
  } catch {
    return { findings: [], readouts: [] };
  }

  const findings: Finding[] = [];
  const linked = new Set<string>();
  for (const source of linkSources(root)) {
    let text: string;
    try {
      text = readFileSync(join(root, source), 'utf8');
    } catch {
      continue;
    }
    for (const link of referenceLinksIn(text)) {
      const target = resolveLink(root, source, link);
      if (existsSync(target)) linked.add(relative(root, target));
      else
        findings.push({
          level: 'WARN',
          msg: `${source}: links ${link}, which is not installed. A rule pointing at an optional file dangles wherever that option was not chosen.`,
        });
    }
  }

  const installed = ctx.claude.manifest?.files ?? {};
  for (const doc of docs) {
    const dest = join(REFERENCE_DIR, doc);
    if (linked.has(dest)) continue;
    if (!(dest in installed)) continue;
    findings.push({
      level: 'WARN',
      msg: `${dest}: no installed rule, skill, or agent links it, so nothing will ever route a reader to it. Add a routing line to the rule that owns the topic.`,
    });
  }

  return {
    findings,
    readouts: [`reference reachability: ${docs.length} doc(s) inspected`],
  };
}
