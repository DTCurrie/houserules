#!/usr/bin/env node
/**
 * Dev-only tool, never published. Finds first-party shipped prose that names another module's
 * skill, agent, script, rule, reference, or output style without a declaration covering that
 * module. A module covers another by naming its bare id in `requires`, in `uses`, or in an
 * option choice's `requires`. An undeclared mention reads fine in this repo, where every module
 * is installed, and points at nothing in a user's repo that skipped the named module.
 *
 * What counts as a name, keyed by the installed destination:
 * - `.claude/skills/<name>/SKILL.md` installs the token `/<name>`.
 * - `.claude/agents/<name>.md` installs `<name>`, except the `reviewers` module's agents, which
 *   it writes through a `seed` action per repo, so their names are not fixed. A fixed agent that
 *   module copies installs its name like any other.
 * - `.claude/scripts/<name>.mjs` installs `<name>.mjs`. Shared libs under `scripts/lib/` do not.
 * - `.claude/rules/`, `.claude/reference/`, and `.claude/output-styles/` install their basename.
 * Agent templates under `.claude/templates/` install no token.
 *
 * Prose scanned is every `.md` and `.template` source a module installs, read from the package's
 * `payload/` source rather than `payload-dist/`, so a finding names the file to edit. Skipped:
 * fenced code blocks, YAML comment lines inside frontmatter (no agent reads them as an
 * instruction), and a block quote following a `**Bad` label, which quotes the wrong form on
 * purpose. The frontmatter `description:` line is scanned, since it is what an agent reads first.
 * A module naming its own files needs no declaration. A sibling module in the same package does.
 *
 * Covers first-party packages only. It loads every `packages/plugin-*` by relative path and calls
 * each module's `plan()` with every module selected and every option value chosen. A third-party
 * plugin's prose is its author's to declare.
 *
 * Usage: `node scripts/verify-module-references.mjs`
 *
 * Requires a prior build (`pnpm build` at the workspace root), since it imports the CLI's and each
 * plugin's `dist/`. Exits 1 on any finding.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(import.meta.dirname, '..');

/** The module whose `.claude/agents/` output is generated per repo, so it installs no token. */
const GENERATED_AGENTS_MODULE = 'reviewers';

/**
 * The token an installed destination contributes, or `null` when it contributes none.
 *
 * @param {string} dest Repo-relative install destination, such as `.claude/rules/x.md`.
 * @returns {string | null}
 */
export function tokenForDest(dest) {
  for (const { pattern, toToken } of DEST_TOKENS) {
    const name = dest.match(pattern)?.groups?.name;
    if (name) return toToken(name);
  }
  return null;
}

/** Each installed kind that contributes a token, and how its captured `name` becomes one. */
const DEST_TOKENS = [
  {
    pattern: /^\.claude\/skills\/(?<name>[^/]+)\/SKILL\.md$/,
    toToken: (name) => `/${name}`,
  },
  {
    pattern: /^\.claude\/agents\/(?<name>[^/]+)\.md$/,
    toToken: (name) => name,
  },
  {
    pattern: /^\.claude\/scripts\/(?<name>[^/]+\.mjs)$/,
    toToken: (name) => name,
  },
  {
    pattern:
      /^\.claude\/(?:rules|reference|output-styles)\/(?<name>[^/]+\.md)$/,
    toToken: (name) => name,
  },
];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A matcher for one token with word-boundary guards. A skill token must not follow a word
 * character, dot, slash, or hyphen, so `.claude/skills/ready` and `a/ready` do not match
 * `/ready`. Any other token must not follow a word character or hyphen, so
 * `accessibility-testing.md` does not match `testing.md`. Neither may run on into a word
 * character or hyphen.
 */
function tokenPattern(token) {
  const before = token.startsWith('/') ? '(?<![\\w./-])' : '(?<![\\w-])';
  return new RegExp(`${before}${escapeRegExp(token)}(?![\\w-])`);
}

/**
 * The 1-based line numbers of `text` that count as prose: outside fenced code blocks, not a
 * YAML comment inside frontmatter, and not a block quote following a `**Bad` label.
 *
 * @param {string} text
 * @returns {Array<{ line: number, content: string }>}
 */
function proseLines(text) {
  const lines = text.split('\n');
  const { kept, bodyStart } = frontmatterProse(lines);
  let openFenceMarker = null;
  let isAfterBadLabel = false;
  let isInBadQuote = false;

  for (let index = bodyStart; index < lines.length; index++) {
    const content = lines[index];
    const fenceMarker = content.match(/^\s*(`{3,}|~{3,})/)?.[1] ?? null;
    if (openFenceMarker !== null) {
      if (closesFence(fenceMarker, openFenceMarker)) openFenceMarker = null;
      continue;
    }
    if (fenceMarker) {
      openFenceMarker = fenceMarker;
      isAfterBadLabel = false;
      isInBadQuote = false;
      continue;
    }

    const isQuote = /^\s*>/.test(content);
    if (isInBadQuote && isQuote) continue;
    isInBadQuote = false;
    if (isAfterBadLabel) {
      if (content.trim() === '') continue;
      isAfterBadLabel = false;
      if (isQuote) {
        isInBadQuote = true;
        continue;
      }
    }
    if (/^\s*\*\*Bad\b/.test(content)) isAfterBadLabel = true;

    kept.push({ line: index + 1, content });
  }
  return kept;
}

/**
 * The frontmatter lines that count as prose, which is every one but a YAML comment, and the
 * index of the first body line. A file with no frontmatter keeps nothing and starts at 0.
 */
function frontmatterProse(lines) {
  const kept = [];
  if (lines[0]?.trim() !== '---') return { kept, bodyStart: 0 };
  for (let index = 1; index < lines.length; index++) {
    const content = lines[index];
    if (content.trim() === '---') return { kept, bodyStart: index + 1 };
    if (!/^\s*#/.test(content)) kept.push({ line: index + 1, content });
  }
  return { kept, bodyStart: lines.length };
}

/** A fence closes on a run of the same character at least as long as the one that opened it. */
function closesFence(fenceMarker, openFenceMarker) {
  return (
    fenceMarker !== null &&
    fenceMarker[0] === openFenceMarker[0] &&
    fenceMarker.length >= openFenceMarker.length
  );
}

/**
 * @typedef {object} ModuleInput
 * @property {string} id The module's bare id.
 * @property {string[]} covers Bare ids its `requires`, `uses`, and option `requires` name.
 * @property {string[]} tokens Tokens the module installs, per {@link tokenForDest}.
 * @property {Array<{ path: string, text: string }>} files Prose the module installs.
 */

/**
 * @typedef {object} Finding
 * @property {string} path The prose file, as given in the input.
 * @property {number} line 1-based.
 * @property {string} token The name found.
 * @property {string} owner Bare id of the module that installs it.
 * @property {string} module Bare id of the module whose prose names it.
 */

/**
 * Every mention of another module's token that no declaration on the scanning module covers.
 * Pure: reads only its argument.
 *
 * @param {ModuleInput[]} modules
 * @returns {Finding[]}
 */
export function findUndeclaredReferences(modules) {
  /** @type {Map<string, Set<string>>} */
  const ownersByToken = new Map();
  for (const mod of modules) {
    for (const token of mod.tokens) {
      if (!ownersByToken.has(token)) ownersByToken.set(token, new Set());
      ownersByToken.get(token).add(mod.id);
    }
  }
  const matchers = [...ownersByToken].map(([token, owners]) => ({
    token,
    owners: [...owners].sort(),
    pattern: tokenPattern(token),
  }));

  const findings = [];
  for (const mod of modules) {
    const covered = new Set([mod.id, ...mod.covers]);
    for (const file of mod.files) {
      for (const { line, content } of proseLines(file.text)) {
        for (const { token, owners, pattern } of matchers) {
          if (owners.some((owner) => covered.has(owner))) continue;
          if (!pattern.test(content)) continue;
          findings.push({
            path: file.path,
            line,
            token,
            owner: owners.join(' or '),
            module: mod.id,
          });
        }
      }
    }
  }
  return findings.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.token.localeCompare(b.token),
  );
}

const bareId = (registryId) => registryId.split('/').pop();

/** `packages/<pkg>/payload-dist/x` becomes `packages/<pkg>/payload/x` when that source exists. */
function sourcePathOf(src) {
  const marker = `${sep}payload-dist${sep}`;
  const index = src.lastIndexOf(marker);
  if (index === -1) return src;
  const candidate = `${src.slice(0, index)}${sep}payload${sep}${src.slice(index + marker.length)}`;
  return existsSync(candidate) ? candidate : src;
}

function firstPartyPlugins() {
  return readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('plugin-'))
    .map((entry) => ({
      name: `./packages/${entry.name}`,
      alias: entry.name.slice('plugin-'.length),
    }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

async function gatherModules() {
  const dist = (file) =>
    pathToFileURL(join(repoRoot, 'packages/cli/dist', file)).href;
  const { MODULES } = await import(dist('plan.js'));
  const { buildRegistry } = await import(dist('plugin-resolver.js'));
  const { detect } = await import(dist('detect.js'));

  const registry = buildRegistry(
    repoRoot,
    { plugins: firstPartyPlugins() },
    MODULES,
  );
  const ctx = detect(repoRoot);
  const answers = everythingSelected(registry, ctx);
  return registry.modules.map((registered) =>
    describeModule(registered, ctx, answers),
  );
}

/** Answers selecting every registered module and every option value, so each plans in full. */
function everythingSelected(registry, ctx) {
  const moduleOptions = {};
  for (const registered of registry.modules) {
    const choices = registered.def.options?.choices;
    if (choices) {
      moduleOptions[registered.id] = choices.map((choice) => choice.value);
    }
  }
  return {
    moduleIds: registry.modules.map((registered) => registered.id),
    targets: ctx.targets ?? [],
    seedChangesetConfig: false,
    moduleOptions,
    contributedSkillTriggers: [],
  };
}

/**
 * Whether `action` installs a fixed path, rather than one of the per-repo reviewer agents. Only
 * an agent the generated-agents module writes through a `seed` action has no fixed name.
 */
export function isFixedInstallPath(moduleId, action) {
  const dest = action.dest ?? action.path ?? '';
  return !(
    moduleId === GENERATED_AGENTS_MODULE &&
    action.kind === 'seed' &&
    dest.startsWith('.claude/agents/')
  );
}

/** One registered module as {@link findUndeclaredReferences} reads it. */
function describeModule(registered, ctx, answers) {
  const { def } = registered;
  const covers = [
    ...(def.requires ?? []),
    ...(def.uses ?? []),
    ...(def.options?.choices ?? []).flatMap((choice) => choice.requires ?? []),
  ].map((requirement) => requirement.id);

  const tokens = new Set();
  const files = new Map();
  for (const action of def.plan(ctx, answers)) {
    const dest = action.dest ?? action.path ?? null;
    const token =
      dest && isFixedInstallPath(registered.id, action)
        ? tokenForDest(dest)
        : null;
    if (token) tokens.add(token);
    if (typeof action.src !== 'string' || !/\.(md|template)$/.test(action.src))
      continue;
    const source = sourcePathOf(action.src);
    if (files.has(source)) continue;
    files.set(source, {
      path: relative(repoRoot, source),
      text: readFileSync(source, 'utf8'),
    });
  }
  return {
    id: bareId(registered.id),
    covers,
    tokens: [...tokens],
    files: [...files.values()],
  };
}

async function main() {
  const modules = await gatherModules();
  const findings = findUndeclaredReferences(modules);
  for (const finding of findings) {
    console.log(
      `${finding.path}:${finding.line}  ${finding.token} belongs to ${finding.owner}, which ${finding.module} does not declare in requires or uses`,
    );
  }
  console.log('');
  console.log(
    `${modules.length} modules scanned, ${findings.length} undeclared module reference(s)`,
  );
  if (findings.length > 0) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
