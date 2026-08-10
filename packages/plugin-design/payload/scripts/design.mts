#!/usr/bin/env node
/**
 * DTCG design token query.
 *
 * Usage:
 *   design.mjs token <dot.path>   resolve one token, following alias chains
 *   design.mjs list [group]       list every token dot-path, optionally filtered to a group
 *   design.mjs scales             print the spacing, fontSize, and radius scales in order
 *   design.mjs extract            scan the repo for design tokens and print a DTCG document
 *   design.mjs theme [--all]      print the repo's resolved Tailwind theme, grouped by namespace
 *   design.mjs scaffold           print a starter @theme block of named color roles to stdout
 *   design.mjs check <files...>   report deterministic design-system findings for each file
 *   design.mjs render <target>    render a URL or local HTML file in Chrome and report findings
 *
 * Reads tokens for every subcommand that needs them, `check`, `render`, `token`, `list`,
 * `scales`, from one of two sources. With `--tokens <path>`, or with neither flag and no
 * Tailwind theme found, from the DTCG token set at `.claude/design/tokens.json`, resolved
 * relative to the current working directory, or at `--tokens`'s path (also resolved relative
 * to cwd). With `--theme <path>`, or with neither flag when the `design-tailwind` module's
 * libs are installed and an entry stylesheet is found among the repo's CSS files, from the
 * repo's own resolved Tailwind theme, projected into the same DTCG shape. Once Tailwind mode
 * is selected, by either path, it never falls back to the token file: a missing `tailwindcss`
 * or a compile failure exits non-zero naming the fix. Every run prints one stderr line naming
 * which source answered.
 *
 * `token` follows DTCG `{group.token}` alias references and prints the final `$type` and
 * value, plus a hex conversion for colors. `$type` is inherited from the nearest ancestor
 * group when a token has none of its own, per the DTCG spec.
 *
 * Warns on stderr, without failing, when the loaded token FILE is still byte-identical to the
 * kit's seeded placeholders, since every check that follows would measure real code against
 * values nobody chose. Tailwind mode has no seed, so this warning never fires there, and the
 * source line is what tells a reader which mode ran.
 *
 * `extract` never reads the token set. It walks the repo for a Tailwind v4 `@theme` block,
 * `:root` CSS custom properties, and raw style literals, in that priority order, and prints
 * the resulting DTCG document to stdout. Everything else it reports, findings, warnings, and
 * the next-step hint, goes to stderr, so `design.mjs extract > tokens.json` yields a clean
 * file. It never writes to disk.
 *
 * `theme` and `scaffold` both require Tailwind mode, since a token file has no notion of which
 * values are Tailwind's defaults. Passing `--tokens`, or running in a repo where Tailwind mode
 * cannot be resolved, exits non-zero naming the problem rather than printing an empty result.
 *
 * `theme` prints every group in the resolved theme (`color`, `fontFamily`, `fontWeight`,
 * `fontSize`, `radius`, `spacing`), each token marked by whether the repo's own `@theme` block
 * declared it or Tailwind's default palette did. By default each group shows only its
 * repo-declared entries plus a count of the Tailwind defaults it is hiding. `--all` prints every
 * entry in every group, each tagged `(repo)` or `(default)`.
 *
 * `scaffold` proposes a starter `@theme inline` block naming semantic color roles, such as
 * `--color-brand` and `--color-brand-raised`, aliased with `var()` to the repo's own declared
 * colors rather than inventing new palette numbers. It prints to stdout and never writes to
 * disk, matching `extract`, so `design.mjs scaffold >> src/app.css` stays the user's explicit
 * act.
 *
 * `render` accepts an `http(s)://` URL or a path to a local `.html` file, resolved against the
 * current working directory and converted to a `file://` URL. It launches a locally discovered
 * headless Chrome, loads the target, and reports the same rendered findings `check` cannot see
 * from source alone: composited text contrast, rendered hit-target size, and computed-value
 * drift. It never starts a dev server and never runs a package-manager command. Findings go to
 * stdout, everything else to stderr, and the Chrome session is always closed, even on failure.
 *
 * Exits 0 on success, 1 when the token set is missing or invalid, the requested token or
 * group does not exist, an alias chain cycles back on itself, (for `extract`) no candidate
 * files exist in the repo, (for `theme` and `scaffold`) Tailwind mode cannot be resolved or (for
 * `scaffold`) the repo has declared no colors of its own to name, or (for `render`) the target
 * is missing, no Chrome is available, or findings were reported.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TokenCandidate } from './lib/dtcg-normalize.mjs';
import { normalizeToDtcg } from './lib/dtcg-normalize.mjs';
import {
  hasTailwindV3Config,
  readTailwindThemeCandidates,
} from './lib/tailwind-theme.mjs';
import { readCssCustomProperties } from './lib/css-custom-properties.mjs';
import { collectStyleTokenCandidates } from './lib/style-literals.mjs';
import { checkDesign, ACCESSIBILITY_SCOPE_NOTE } from './lib/design-checks.mjs';
import type { Finding } from './lib/design-checks.mjs';
import { launchSession } from './lib/cdp-session.mjs';
import { checkRenderedPage } from './lib/rendered-checks.mjs';
import type { RenderedFinding } from './lib/rendered-checks.mjs';
import type { LoadedDesignSystem } from './lib/tailwind-design-system.mjs';

const TOKENS_PATH = '.claude/design/tokens.json';
// Sha256 of the seed's trimmed serialized form, kept in sync with `renderTokenSeed()` in
// packages/plugin-design/src/tokens-seed.ts by src/__test__/design-script.test.ts. A payload
// script cannot import that module, since payload scripts are node-builtins-only.
const SEED_TOKENS_SHA256 =
  'bf974edf7ee0033bc5a9f572ababde403107396a36e7e9aed5c2eaf241ca9b83';
const COLOR_CHANNEL_MAX = 255;
const ALIAS_PATTERN = /^\{([^{}]+)\}$/;
const SCALE_GROUPS = ['spacing', 'fontSize', 'radius'];

const CSS_EXTENSION = '.css';
const LITERAL_SCAN_EXTENSIONS = [
  '.css',
  '.jsx',
  '.tsx',
  '.svelte',
  '.vue',
  '.astro',
  '.html',
];
const TAILWIND_CONFIG_FILE_NAMES = new Set([
  'tailwind.config.js',
  'tailwind.config.ts',
  'tailwind.config.cjs',
  'tailwind.config.mjs',
]);
const SKIPPED_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.svelte-kit',
  'coverage',
]);
const MAX_FILES_TO_WALK = 5000;

interface Dimension {
  value: number;
  unit: string;
}

interface Color {
  colorSpace: string;
  components: number[];
  alpha?: number;
}

interface ResolvedToken {
  value: unknown;
  type: string | undefined;
  chain: string[];
}

interface ResolveError {
  error: string;
}

type ResolveOutcome = ResolvedToken | ResolveError;

interface LocatedNode {
  node: Record<string, unknown>;
  type: string | undefined;
}

interface ScaleEntry {
  path: string;
  dimension: Dimension;
}

function usage(): void {
  console.error(
    [
      'Usage:',
      '  design.mjs token <dot.path>   resolve one token, following alias chains',
      '  design.mjs list [group]       list every token dot-path, optionally filtered to a group',
      '  design.mjs scales             print the spacing, fontSize, and radius scales in order',
      '  design.mjs extract            scan the repo for design tokens and print a DTCG document',
      "  design.mjs theme [--all]      print the repo's resolved Tailwind theme, grouped by namespace",
      '  design.mjs scaffold           print a starter @theme block of named color roles to stdout',
      '  design.mjs check <files...>   report deterministic design-system findings for each file',
      '  design.mjs render <target>    render a URL or local HTML file in Chrome and report findings',
      '',
      '  --tokens <path>               read the token set from <path> instead of .claude/design/tokens.json',
      '  --theme <path>                read tokens from the Tailwind theme compiled from <path>',
    ].join('\n'),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToken(node: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(node, '$value');
}

function ownType(node: Record<string, unknown>): string | undefined {
  return typeof node.$type === 'string' ? node.$type : undefined;
}

function isDimension(value: unknown): value is Dimension {
  return (
    isRecord(value) &&
    typeof value.value === 'number' &&
    typeof value.unit === 'string'
  );
}

function isColor(value: unknown): value is Color {
  if (!isRecord(value)) return false;
  if (typeof value.colorSpace !== 'string') return false;
  if (!Array.isArray(value.components)) return false;
  return value.components.every((component) => typeof component === 'number');
}

function isFontFamily(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function tokensPath(override: string | undefined): string {
  return resolve(process.cwd(), override ?? TOKENS_PATH);
}

function isUntouchedSeed(contents: string): boolean {
  return (
    createHash('sha256').update(contents.trimEnd(), 'utf8').digest('hex') ===
    SEED_TOKENS_SHA256
  );
}

function loadTokensFromFile(
  override: string | undefined,
): Record<string, unknown> | undefined {
  const path = tokensPath(override);
  if (!existsSync(path)) {
    console.error(
      `No design tokens at ${path}. Run \`npx agent-kit init\` to seed one, or write it by hand.`,
    );
    return undefined;
  }
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    console.error(`Could not read ${path}.`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    console.error(`${path} is not valid JSON.`);
    return undefined;
  }
  if (!isRecord(parsed)) {
    console.error(`${path} does not contain a token object.`);
    return undefined;
  }
  console.error(`Tokens from ${path}.`);
  if (isUntouchedSeed(contents)) {
    console.error(
      `${path} is still the kit's placeholder seed. Every check below measures against placeholders, not this repo's design. Bootstrap real values from existing code with \`node .claude/scripts/design.mjs extract\`.`,
    );
  }
  return parsed;
}

/** Absolute path to the Tailwind bridge lib, resolved beside this script rather than cwd. */
function tailwindDesignSystemLibPath(): string {
  return fileURLToPath(
    new URL('./lib/tailwind-design-system.mjs', import.meta.url),
  );
}

/** The tokens `check` and every other subcommand read, plus the class-checking half only `check` uses. */
interface TokenSource {
  tokens: Record<string, unknown>;
  /** Set only when Tailwind mode answered this run, so `check` knows class checking applies. */
  tailwindDesignSystem: LoadedDesignSystem | undefined;
}

/** `loadTailwindTokens`'s result: the projected token document, plus the system that produced it. */
interface TailwindTokenLoad {
  tokens: Record<string, unknown>;
  designSystem: LoadedDesignSystem;
}

function tokenSourceFromFile(
  tokens: Record<string, unknown> | undefined,
): TokenSource | undefined {
  return tokens ? { tokens, tailwindDesignSystem: undefined } : undefined;
}

function tokenSourceFromTailwind(
  loaded: TailwindTokenLoad | undefined,
): TokenSource | undefined {
  return loaded
    ? { tokens: loaded.tokens, tailwindDesignSystem: loaded.designSystem }
    : undefined;
}

/**
 * Compiles the repo's Tailwind theme at `entryCssPath` and projects it into a DTCG document.
 *
 * Never falls back to the token file: once Tailwind mode is chosen, a missing `tailwindcss`
 * or a compile failure is reported and the command exits non-zero, per decision 4 in
 * `.claude/plans/design-tailwind/PLAN.md`.
 */
async function loadTailwindTokens(
  entryCssPath: string,
): Promise<TailwindTokenLoad | undefined> {
  const { loadDesignSystem } = await import('./lib/tailwind-design-system.mjs');
  const loaded = await loadDesignSystem(process.cwd(), entryCssPath);
  if (!loaded.ok) {
    console.error(loaded.error);
    return undefined;
  }
  const { projectThemeToDtcg } =
    await import('./lib/tailwind-theme-to-dtcg.mjs');
  const { document, counts } = projectThemeToDtcg(loaded.value.theme);
  console.error(
    `Tokens from ${entryCssPath}, ${counts.repo} from this repo's @theme block and ${counts.tailwind} from Tailwind's defaults.`,
  );
  return { tokens: document, designSystem: loaded.value };
}

/**
 * Resolves which token source answers this run, per the precedence in the file header, and
 * announces the choice on stderr before returning it.
 */
async function resolveTokens(
  tokensOverride: string | undefined,
  themeOverride: string | undefined,
): Promise<TokenSource | undefined> {
  if (tokensOverride !== undefined) {
    return tokenSourceFromFile(loadTokensFromFile(tokensOverride));
  }
  if (themeOverride !== undefined) {
    return tokenSourceFromTailwind(
      await loadTailwindTokens(resolve(process.cwd(), themeOverride)),
    );
  }

  if (!existsSync(tailwindDesignSystemLibPath())) {
    return tokenSourceFromFile(loadTokensFromFile(undefined));
  }

  const { findThemeEntryCss } =
    await import('./lib/tailwind-design-system.mjs');
  const discovered = discoverFiles(process.cwd());
  const cssFiles = discovered.styleFiles.filter((path) =>
    path.endsWith(CSS_EXTENSION),
  );
  const found = findThemeEntryCss(cssFiles);
  if (!found.ok) {
    // Not a fallback to the token file. The design-tailwind module is installed, so no seed was
    // written, and answering from a leftover tokens.json would be answering from a file this
    // repo stopped maintaining. Say what is actually missing instead.
    console.error(
      `${found.error} The design-tailwind module is installed, so the Tailwind theme is this repo's design system. Add \`@import "tailwindcss";\` to the stylesheet your build compiles, or point at it with \`--theme <path>\`.`,
    );
    return undefined;
  }

  if (found.value.alternates.length > 0) {
    console.error(
      `${found.value.path} imports Tailwind. Using it, and ignoring ${found.value.alternates.length} other file(s) that also import Tailwind.`,
    );
  }

  return tokenSourceFromTailwind(await loadTailwindTokens(found.value.path));
}

function locate(
  root: Record<string, unknown>,
  segments: string[],
): LocatedNode | undefined {
  let current: Record<string, unknown> = root;
  let inheritedType = ownType(current);
  for (const segment of segments) {
    const next = current[segment];
    if (!isRecord(next)) return undefined;
    current = next;
    inheritedType = ownType(current) ?? inheritedType;
  }
  return { node: current, type: inheritedType };
}

/** Follows a `{group.token}` alias chain from `startPath` to its final value and type. */
function resolveTokenChain(
  root: Record<string, unknown>,
  startPath: string,
): ResolveOutcome {
  const chain: string[] = [];
  const visited = new Set<string>();
  let path = startPath;
  for (;;) {
    if (visited.has(path)) {
      return {
        error: `Alias cycle detected: ${[...chain, path].join(' -> ')}`,
      };
    }
    visited.add(path);
    const located = locate(root, path.split('.'));
    if (!located) return { error: `No token at "${path}".` };
    if (!isToken(located.node)) {
      return {
        error: `"${path}" is a group, not a token. Try \`design.mjs list ${path}\`.`,
      };
    }
    chain.push(path);
    const value = located.node.$value;
    const alias = typeof value === 'string' ? ALIAS_PATTERN.exec(value) : null;
    if (!alias) return { value, type: located.type, chain };
    path = alias[1];
  }
}

function toHexChannel(component: number): string {
  const clamped = Math.min(1, Math.max(0, component));
  return Math.round(clamped * COLOR_CHANNEL_MAX)
    .toString(16)
    .padStart(2, '0');
}

function formatColorHex(color: Color): string {
  return `#${color.components.map(toHexChannel).join('')}`;
}

function formatColorValue(color: Color): string {
  const alpha = typeof color.alpha === 'number' ? `, alpha ${color.alpha}` : '';
  return `${color.colorSpace}(${color.components.join(', ')}${alpha})`;
}

function formatDimension(dimension: Dimension): string {
  return `${dimension.value}${dimension.unit}`;
}

function formatShadow(value: Record<string, unknown>): string {
  const parts: string[] = [];
  if (isColor(value.color))
    parts.push(`color ${formatColorValue(value.color)}`);
  if (isDimension(value.offsetX))
    parts.push(`offsetX ${formatDimension(value.offsetX)}`);
  if (isDimension(value.offsetY))
    parts.push(`offsetY ${formatDimension(value.offsetY)}`);
  if (isDimension(value.blur))
    parts.push(`blur ${formatDimension(value.blur)}`);
  if (isDimension(value.spread))
    parts.push(`spread ${formatDimension(value.spread)}`);
  return parts.join(', ');
}

function formatValue(type: string | undefined, value: unknown): string {
  if (type === 'dimension' && isDimension(value)) return formatDimension(value);
  if (type === 'color' && isColor(value)) return formatColorValue(value);
  if (type === 'fontFamily' && isFontFamily(value))
    return formatFontFamily(value);
  if (type === 'fontWeight' && typeof value === 'number') return String(value);
  if (type === 'shadow' && isRecord(value)) return formatShadow(value);
  return JSON.stringify(value);
}

function formatFontFamily(value: string[]): string {
  return value.join(', ');
}

function collectTokenPaths(
  node: Record<string, unknown>,
  prefix: string,
  out: string[],
): void {
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('$') || !isRecord(child)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isToken(child)) {
      out.push(path);
    } else {
      collectTokenPaths(child, path, out);
    }
  }
}

function runToken(root: Record<string, unknown>, name: string): number {
  const outcome = resolveTokenChain(root, name);
  if ('error' in outcome) {
    console.error(outcome.error);
    return 1;
  }
  console.log(`$type: ${outcome.type ?? 'unknown'}`);
  if (outcome.chain.length > 1) {
    console.log(`resolved via: ${outcome.chain.join(' -> ')}`);
  }
  console.log(`value: ${formatValue(outcome.type, outcome.value)}`);
  if (outcome.type === 'color' && isColor(outcome.value)) {
    console.log(`hex: ${formatColorHex(outcome.value)}`);
  }
  return 0;
}

function runList(
  root: Record<string, unknown>,
  group: string | undefined,
): number {
  const paths: string[] = [];
  collectTokenPaths(root, '', paths);
  const filtered = group
    ? paths.filter((path) => path === group || path.startsWith(`${group}.`))
    : paths;
  if (filtered.length === 0) {
    console.error(
      group ? `No tokens under group "${group}".` : 'No tokens found.',
    );
    return 1;
  }
  filtered.sort();
  for (const path of filtered) console.log(path);
  return 0;
}

function toScaleEntry(
  path: string,
  outcome: ResolveOutcome,
): ScaleEntry | undefined {
  if ('error' in outcome) return undefined;
  if (!isDimension(outcome.value)) return undefined;
  return { path, dimension: outcome.value };
}

function renderScale(
  root: Record<string, unknown>,
  group: string,
): string[] | undefined {
  if (!isRecord(root[group])) return undefined;
  const paths: string[] = [];
  collectTokenPaths(root, '', paths);
  const entries = paths
    .filter((path) => path.startsWith(`${group}.`))
    .map((path) => toScaleEntry(path, resolveTokenChain(root, path)))
    .filter((entry): entry is ScaleEntry => entry !== undefined)
    .sort((a, b) => a.dimension.value - b.dimension.value);
  return entries.map(
    (entry) => `${entry.path}  ${formatDimension(entry.dimension)}`,
  );
}

function runScales(root: Record<string, unknown>): number {
  let exitCode = 0;
  for (const group of SCALE_GROUPS) {
    const rendered = renderScale(root, group);
    if (!rendered) {
      console.error(`No group "${group}" in the token set.`);
      exitCode = 1;
      continue;
    }
    console.log(`${group}:`);
    for (const line of rendered) console.log(`  ${line}`);
  }
  return exitCode;
}

interface DiscoveredFiles {
  styleFiles: string[];
  tailwindConfigFiles: string[];
  hitCap: boolean;
}

/**
 * Walks `root` recursively, skipping {@link SKIPPED_DIRECTORY_NAMES}, and collects style
 * source files and Tailwind config files. Stops after visiting {@link MAX_FILES_TO_WALK}
 * files so a huge repo cannot hang, and reports whether the cap was hit.
 */
function discoverFiles(root: string): DiscoveredFiles {
  const styleFiles: string[] = [];
  const tailwindConfigFiles: string[] = [];
  let filesVisited = 0;
  let hitCap = false;

  function visitFile(fullPath: string, fileName: string): void {
    filesVisited += 1;
    if (filesVisited > MAX_FILES_TO_WALK) {
      hitCap = true;
      return;
    }
    if (LITERAL_SCAN_EXTENSIONS.includes(extname(fileName))) {
      styleFiles.push(fullPath);
    }
    if (TAILWIND_CONFIG_FILE_NAMES.has(fileName)) {
      tailwindConfigFiles.push(fullPath);
    }
  }

  function walk(dir: string): void {
    if (hitCap) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hitCap) return;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      if (entry.isFile()) visitFile(fullPath, entry.name);
    }
  }

  walk(root);
  return { styleFiles, tailwindConfigFiles, hitCap };
}

function mergeCandidatesByPriority(
  prioritizedSources: TokenCandidate[][],
): TokenCandidate[] {
  const merged = new Map<string, TokenCandidate>();
  for (const candidates of prioritizedSources) {
    for (const candidate of candidates) {
      const key = `${candidate.group}.${candidate.name}`;
      if (!merged.has(key)) merged.set(key, candidate);
    }
  }
  return [...merged.values()];
}

function reportTailwindV3Fallback(
  tailwindConfigFiles: string[],
  tailwindCandidates: TokenCandidate[],
): void {
  if (tailwindCandidates.length > 0) return;
  if (!hasTailwindV3Config(tailwindConfigFiles)) return;
  console.error(
    'Tailwind v3 config detected. This reader supports v4+ only, falling back to the other sources.',
  );
}

function reportExtractionSummary(
  tailwindCandidates: TokenCandidate[],
  cssResult: { candidates: TokenCandidate[]; unreadableFiles: string[] },
  literalResult: {
    candidates: TokenCandidate[];
    droppedCount: number;
    unreadableFiles: string[];
  },
  dropped: string[],
  hitCap: boolean,
): void {
  console.error(
    `Tailwind @theme contributed ${tailwindCandidates.length} candidates.`,
  );
  console.error(
    `CSS custom properties contributed ${cssResult.candidates.length} candidates.`,
  );
  if (cssResult.unreadableFiles.length > 0) {
    console.error(
      `${cssResult.unreadableFiles.length} CSS file(s) could not be read and were skipped: ${cssResult.unreadableFiles.join(', ')}.`,
    );
  }
  console.error(
    `Literal scan contributed ${literalResult.candidates.length} candidates and dropped ${literalResult.droppedCount} below the occurrence floor or over the per-group cap.`,
  );
  if (literalResult.unreadableFiles.length > 0) {
    console.error(
      `${literalResult.unreadableFiles.length} style file(s) could not be read and were skipped: ${literalResult.unreadableFiles.join(', ')}.`,
    );
  }
  console.error(
    `${dropped.length} values were dropped as not representable in DTCG.`,
  );
  if (hitCap) {
    console.error(
      `Stopped after walking ${MAX_FILES_TO_WALK} files. Some files in this repo were not scanned.`,
    );
  }
  console.error(
    'These values are proposed, not authoritative. Review them, then redirect this output to .claude/design/tokens.json when satisfied.',
  );
}

function runExtract(): number {
  const root = process.cwd();
  const discovered = discoverFiles(root);
  if (
    discovered.styleFiles.length === 0 &&
    discovered.tailwindConfigFiles.length === 0
  ) {
    console.error(`No design token candidate files found under ${root}.`);
    return 1;
  }

  const cssFiles = discovered.styleFiles.filter((filePath) =>
    filePath.endsWith(CSS_EXTENSION),
  );
  const tailwindCandidates = readTailwindThemeCandidates(cssFiles);
  reportTailwindV3Fallback(discovered.tailwindConfigFiles, tailwindCandidates);
  const cssResult = readCssCustomProperties(cssFiles);
  const literalResult = collectStyleTokenCandidates(discovered.styleFiles);

  const merged = mergeCandidatesByPriority([
    tailwindCandidates,
    cssResult.candidates,
    literalResult.candidates,
  ]);
  const { document, dropped } = normalizeToDtcg(merged);

  console.log(JSON.stringify(document, null, 2));
  reportExtractionSummary(
    tailwindCandidates,
    cssResult,
    literalResult,
    dropped,
    discovered.hitCap,
  );
  return 0;
}

/** The DTCG groups a projected Tailwind theme can contain, in display order. */
const THEME_GROUP_ORDER = [
  'color',
  'fontFamily',
  'fontWeight',
  'fontSize',
  'radius',
  'spacing',
];

interface ThemeGroupEntry {
  name: string;
  value: unknown;
  origin: 'repo' | 'tailwind';
}

/** Reads a projected Tailwind token's `$extensions['agent-kit'].origin`, tagged by `projectThemeToDtcg`. */
function tokenOrigin(
  node: Record<string, unknown>,
): 'repo' | 'tailwind' | undefined {
  if (!isRecord(node.$extensions)) return undefined;
  const agentKit = node.$extensions['agent-kit'];
  if (!isRecord(agentKit)) return undefined;
  return agentKit.origin === 'repo' || agentKit.origin === 'tailwind'
    ? agentKit.origin
    : undefined;
}

function collectGroupEntries(
  groupNode: Record<string, unknown>,
): ThemeGroupEntry[] {
  const entries: ThemeGroupEntry[] = [];
  for (const [name, value] of Object.entries(groupNode)) {
    if (name.startsWith('$') || !isRecord(value) || !isToken(value)) continue;
    entries.push({
      name,
      value: value.$value,
      origin: tokenOrigin(value) ?? 'tailwind',
    });
  }
  return entries;
}

function reportThemeGroup(
  group: string,
  entries: ThemeGroupEntry[],
  type: string | undefined,
  showAll: boolean,
): void {
  console.log(`${group}:`);
  const repoEntries = entries.filter((entry) => entry.origin === 'repo');
  const defaultCount = entries.length - repoEntries.length;

  if (showAll) {
    for (const entry of entries) {
      const label = entry.origin === 'repo' ? 'repo' : 'default';
      console.log(
        `  ${entry.name}  ${formatValue(type, entry.value)}  (${label})`,
      );
    }
    return;
  }

  // A resolved theme runs past 400 entries and only a handful are usually the repo's own, so
  // the default view hides Tailwind's defaults and shows only what the repo declared.
  if (repoEntries.length === 0) {
    console.log(
      `  No repo-declared values. ${defaultCount} from Tailwind's defaults. Run with --all to see them.`,
    );
    return;
  }

  for (const entry of repoEntries) {
    console.log(`  ${entry.name}  ${formatValue(type, entry.value)}`);
  }
  if (defaultCount > 0) {
    console.log(
      `  ${defaultCount} more from Tailwind's defaults, not shown. Run with --all to see them.`,
    );
  }
}

/** Prints the resolved Tailwind theme grouped by namespace, per the file header's `theme` contract. */
function runTheme(root: Record<string, unknown>, showAll: boolean): number {
  for (const group of THEME_GROUP_ORDER) {
    const groupNode = root[group];
    if (!isRecord(groupNode)) continue;
    reportThemeGroup(
      group,
      collectGroupEntries(groupNode),
      ownType(groupNode),
      showAll,
    );
  }
  return 0;
}

const COLOR_SHADE_SUFFIX_PATTERN = /-(\d+)$/;

interface ColorShade {
  name: string;
  shade: number;
}

function baseColorName(name: string): {
  base: string;
  shade: number | undefined;
} {
  const match = COLOR_SHADE_SUFFIX_PATTERN.exec(name);
  if (!match) return { base: name, shade: undefined };
  return { base: name.slice(0, -match[0].length), shade: Number(match[1]) };
}

interface ColorRole {
  role: string;
  variable: string;
}

/**
 * Groups the repo's own declared colors by base name, stripping a trailing shade number, and
 * proposes one role per base. A base with two or more numbered shades gets a lightest role and a
 * `-raised` role for its darkest shade, so a repo's own palette becomes named, rethemeable roles
 * instead of more numbered entries.
 */
function collectColorRoles(entries: ThemeGroupEntry[]): ColorRole[] {
  const repoEntries = entries.filter((entry) => entry.origin === 'repo');
  const shadesByBase = new Map<string, ColorShade[]>();
  const unshaded: string[] = [];

  for (const entry of repoEntries) {
    const { base, shade } = baseColorName(entry.name);
    if (shade === undefined) {
      unshaded.push(entry.name);
      continue;
    }
    const shades = shadesByBase.get(base) ?? [];
    shades.push({ name: entry.name, shade });
    shadesByBase.set(base, shades);
  }

  const roles: ColorRole[] = [];
  for (const name of unshaded) {
    roles.push({ role: name, variable: `--color-${name}` });
  }
  for (const [base, shades] of shadesByBase) {
    const sorted = [...shades].sort((a, b) => a.shade - b.shade);
    const lightest = sorted[0];
    const darkest = sorted[sorted.length - 1];
    roles.push({ role: base, variable: `--color-${lightest.name}` });
    if (sorted.length > 1) {
      roles.push({
        role: `${base}-raised`,
        variable: `--color-${darkest.name}`,
      });
    }
  }
  return roles;
}

/** Prints a starter `@theme` block of named color roles, per the file header's `scaffold` contract. */
function runScaffold(root: Record<string, unknown>): number {
  const colorNode = root.color;
  if (!isRecord(colorNode)) {
    console.error('This theme has no color group to scaffold roles from.');
    return 1;
  }

  const roles = collectColorRoles(collectGroupEntries(colorNode));
  if (roles.length === 0) {
    console.error(
      "No repo-declared colors were found in this repo's @theme block. Declare colors there, then re-run `design.mjs scaffold`.",
    );
    return 1;
  }

  // inline, not plain @theme: a plain alias is declared on :root and frozen there, so a deeper
  // override of the underlying variable never reaches it. inline reads the variable directly.
  console.log('@theme inline {');
  console.log(
    '  /* inline, so each role reads its underlying variable directly instead of freezing it at :root. */',
  );
  for (const role of roles) {
    console.log(`  --color-${role.role}: var(${role.variable});`);
  }
  console.log('}');
  console.error(
    "Starter roles derived from this repo's own declared colors. Review the names, then append this block to the stylesheet Tailwind compiles.",
  );
  return 0;
}

function reportFileFindings(filePath: string, findings: Finding[]): void {
  if (findings.length === 0) return;
  console.log(`${filePath}:`);
  for (const finding of findings) {
    console.log(`  ${filePath}:${finding.line}  ${finding.message}`);
  }
}

type ClassCheckOutcome =
  { findings: Finding[]; coverageSummary: string } | { error: string };

/** Runs the Tailwind class-candidate check for one file, isolating the lazy lib import. */
async function checkFileClasses(
  filePath: string,
  designSystem: LoadedDesignSystem,
  tokens: Record<string, unknown>,
): Promise<ClassCheckOutcome> {
  const { checkTailwindClasses } = await import('./lib/tailwind-checks.mjs');
  const result = await checkTailwindClasses(
    process.cwd(),
    filePath,
    designSystem,
    tokens,
  );
  if (!result.ok) return { error: result.error };
  return {
    findings: result.value.findings,
    coverageSummary: result.value.coverageSummary,
  };
}

async function runCheck(source: TokenSource, files: string[]): Promise<number> {
  let hasFailure = false;
  for (const filePath of files) {
    if (!existsSync(filePath)) {
      console.error(`No such file: ${filePath}`);
      hasFailure = true;
      continue;
    }
    const fileText = readFileSync(filePath, 'utf8');
    const styleResult = checkDesign(fileText, source.tokens);

    let classFindings: Finding[] = [];
    let classCoverageSummary: string | undefined;
    if (source.tailwindDesignSystem) {
      const classOutcome = await checkFileClasses(
        filePath,
        source.tailwindDesignSystem,
        source.tokens,
      );
      if ('error' in classOutcome) {
        console.error(
          `${filePath}: Tailwind class checking is unavailable. ${classOutcome.error}`,
        );
        hasFailure = true;
      } else {
        classFindings = classOutcome.findings;
        classCoverageSummary = classOutcome.coverageSummary;
      }
    }

    const combinedFindings = [...styleResult.findings, ...classFindings].sort(
      (a, b) => a.line - b.line,
    );
    if (combinedFindings.length > 0) hasFailure = true;
    reportFileFindings(filePath, combinedFindings);

    // A component styled entirely by class names parses to zero declarations, and its JSX or
    // template markup counts as unparsed chunks. Reporting that as coverage would say violations
    // could be hidden in a file the class path just checked in full, and would print a 0/0
    // declaration count beside a real candidate count. Both lines are only meaningful when this
    // file had declarations, or when no class check ran to cover it.
    const declarationsWorthReporting =
      styleResult.declarationCount > 0 || classCoverageSummary === undefined;
    if (declarationsWorthReporting) {
      if (styleResult.unparsedCount > 0) {
        console.error(
          `Parse coverage: read ${styleResult.declarationCount} declaration(s), could not parse ${styleResult.unparsedCount} chunk(s). Those chunks were skipped, not checked, and could hide violations.`,
        );
      }
      console.log(styleResult.coverageSummary);
    }
    if (classCoverageSummary !== undefined) {
      console.log(classCoverageSummary);
    }
  }
  console.error(ACCESSIBILITY_SCOPE_NOTE);
  return hasFailure ? 1 : 0;
}

const URL_PREFIX_PATTERN = /^https?:\/\//;

type TargetResolution = { url: string } | { error: string };

/** Converts a render target to a URL. A local path is resolved against cwd and must exist. */
function resolveRenderTarget(target: string): TargetResolution {
  if (URL_PREFIX_PATTERN.test(target)) return { url: target };
  const absolutePath = resolve(process.cwd(), target);
  if (!existsSync(absolutePath)) {
    return { error: `No such file: ${absolutePath}` };
  }
  return { url: `file://${absolutePath}` };
}

function reportRenderFindings(findings: RenderedFinding[]): void {
  for (const finding of findings) {
    console.log(`${finding.selector}  ${finding.message}`);
  }
  console.error(
    findings.length > 0
      ? `${findings.length} finding(s).`
      : 'No rendered findings.',
  );
}

async function runRender(
  root: Record<string, unknown>,
  target: string,
): Promise<number> {
  const resolved = resolveRenderTarget(target);
  if ('error' in resolved) {
    console.error(resolved.error);
    return 1;
  }

  const sessionResult = await launchSession();
  if (!sessionResult.ok) {
    console.error(sessionResult.error);
    return 1;
  }

  const session = sessionResult.value;
  try {
    const navigated = await session.navigate(resolved.url);
    if (!navigated.ok) {
      console.error(navigated.error);
      return 1;
    }
    const result = await checkRenderedPage(session, root);
    reportRenderFindings(result.findings);
    return result.findings.length > 0 ? 1 : 0;
  } finally {
    await session.close();
  }
}

interface ParsedArgv {
  tokensOverride: string | undefined;
  themeOverride: string | undefined;
  rest: string[];
}

/**
 * Pulls `--tokens <path>` and `--theme <path>` out of `argv`, wherever they appear, leaving
 * the rest in order.
 */
function extractSourceFlags(argv: string[]): ParsedArgv {
  const rest: string[] = [];
  let tokensOverride: string | undefined;
  let themeOverride: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--tokens') {
      tokensOverride = argv[i + 1];
      i += 1;
      continue;
    }
    if (argv[i] === '--theme') {
      themeOverride = argv[i + 1];
      i += 1;
      continue;
    }
    rest.push(argv[i]);
  }
  return { tokensOverride, themeOverride, rest };
}

async function main(): Promise<number> {
  const {
    tokensOverride,
    themeOverride,
    rest: argv,
  } = extractSourceFlags(process.argv.slice(2));
  const [command, ...rest] = argv;

  switch (command) {
    case 'token': {
      if (!rest[0]) {
        usage();
        return 1;
      }
      const source = await resolveTokens(tokensOverride, themeOverride);
      if (!source) return 1;
      return runToken(source.tokens, rest[0]);
    }
    case 'list': {
      const source = await resolveTokens(tokensOverride, themeOverride);
      if (!source) return 1;
      return runList(source.tokens, rest[0]);
    }
    case 'scales': {
      const source = await resolveTokens(tokensOverride, themeOverride);
      if (!source) return 1;
      return runScales(source.tokens);
    }
    case 'extract': {
      return runExtract();
    }
    case 'theme': {
      const source = await resolveTokens(tokensOverride, themeOverride);
      if (!source) return 1;
      if (!source.tailwindDesignSystem) {
        console.error(
          'design.mjs theme reads a Tailwind theme, not a token file. Drop --tokens, or point --theme at the stylesheet Tailwind compiles.',
        );
        return 1;
      }
      return runTheme(source.tokens, rest.includes('--all'));
    }
    case 'scaffold': {
      const source = await resolveTokens(tokensOverride, themeOverride);
      if (!source) return 1;
      if (!source.tailwindDesignSystem) {
        console.error(
          'design.mjs scaffold reads a Tailwind theme, not a token file. Drop --tokens, or point --theme at the stylesheet Tailwind compiles.',
        );
        return 1;
      }
      return runScaffold(source.tokens);
    }
    case 'check': {
      if (rest.length === 0) {
        usage();
        return 1;
      }
      const source = await resolveTokens(tokensOverride, themeOverride);
      if (!source) return 1;
      return runCheck(source, rest);
    }
    case 'render': {
      if (!rest[0]) {
        usage();
        return 1;
      }
      const source = await resolveTokens(tokensOverride, themeOverride);
      if (!source) return 1;
      return runRender(source.tokens, rest[0]);
    }
    default:
      usage();
      return 1;
  }
}

process.exit(await main());
