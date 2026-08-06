#!/usr/bin/env node
/**
 * DTCG design token query.
 *
 * Usage:
 *   design.mjs token <dot.path>   resolve one token, following alias chains
 *   design.mjs list [group]       list every token dot-path, optionally filtered to a group
 *   design.mjs scales             print the spacing, fontSize, and radius scales in order
 *   design.mjs extract            scan the repo for design tokens and print a DTCG document
 *   design.mjs check <files...>   report deterministic design-system findings for each file
 *   design.mjs render <target>    render a URL or local HTML file in Chrome and report findings
 *
 * Reads the token set at `.claude/design/tokens.json`, resolved relative to the current
 * working directory, or at the path given with `--tokens <path>` (also resolved relative to
 * cwd), for every subcommand that reads tokens: `check`, `render`, `token`, `list`, `scales`.
 * `token` follows DTCG `{group.token}` alias references and prints the final `$type` and
 * value, plus a hex conversion for colors. `$type` is inherited from the nearest ancestor
 * group when a token has none of its own, per the DTCG spec.
 *
 * Warns on stderr, without failing, when the loaded token set is still byte-identical to the
 * kit's seeded placeholders, since every check that follows would measure real code against
 * values nobody chose.
 *
 * `extract` never reads the token set. It walks the repo for a Tailwind v4 `@theme` block,
 * `:root` CSS custom properties, and raw style literals, in that priority order, and prints
 * the resulting DTCG document to stdout. Everything else it reports, findings, warnings, and
 * the next-step hint, goes to stderr, so `design.mjs extract > tokens.json` yields a clean
 * file. It never writes to disk.
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
 * files exist in the repo, or (for `render`) the target is missing, no Chrome is available, or
 * findings were reported.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import type { TokenCandidate } from './lib/dtcg-normalize.mjs';
import { normalizeToDtcg } from './lib/dtcg-normalize.mjs';
import {
  hasTailwindV3Config,
  readTailwindThemeCandidates,
} from './lib/tailwind-theme.mjs';
import { readCssCustomProperties } from './lib/css-custom-properties.mjs';
import { collectStyleTokenCandidates } from './lib/style-literals.mjs';
import { checkDesign, ACCESSIBILITY_SCOPE_NOTE } from './lib/design-checks.mjs';
import { launchSession } from './lib/cdp-session.mjs';
import { checkRenderedPage } from './lib/rendered-checks.mjs';
import type { RenderedFinding } from './lib/rendered-checks.mjs';

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
      '  design.mjs check <files...>   report deterministic design-system findings for each file',
      '  design.mjs render <target>    render a URL or local HTML file in Chrome and report findings',
      '',
      '  --tokens <path>               read the token set from <path> instead of .claude/design/tokens.json',
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

function loadTokens(
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
  if (isUntouchedSeed(contents)) {
    console.error(
      `${path} is still the kit's placeholder seed. Every check below measures against placeholders, not this repo's design. Bootstrap real values from existing code with \`node .claude/scripts/design.mjs extract\`.`,
    );
  }
  return parsed;
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
  cssCandidates: TokenCandidate[],
  literalResult: { candidates: TokenCandidate[]; droppedCount: number },
  dropped: string[],
  hitCap: boolean,
): void {
  console.error(
    `Tailwind @theme contributed ${tailwindCandidates.length} candidates.`,
  );
  console.error(
    `CSS custom properties contributed ${cssCandidates.length} candidates.`,
  );
  console.error(
    `Literal scan contributed ${literalResult.candidates.length} candidates and dropped ${literalResult.droppedCount} below the occurrence floor or over the per-group cap.`,
  );
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
  const cssCandidates = readCssCustomProperties(cssFiles);
  const literalResult = collectStyleTokenCandidates(discovered.styleFiles);

  const merged = mergeCandidatesByPriority([
    tailwindCandidates,
    cssCandidates,
    literalResult.candidates,
  ]);
  const { document, dropped } = normalizeToDtcg(merged);

  console.log(JSON.stringify(document, null, 2));
  reportExtractionSummary(
    tailwindCandidates,
    cssCandidates,
    literalResult,
    dropped,
    discovered.hitCap,
  );
  return 0;
}

function reportFileFindings(
  filePath: string,
  result: ReturnType<typeof checkDesign>,
): void {
  if (result.findings.length === 0) return;
  console.log(`${filePath}:`);
  for (const finding of result.findings) {
    console.log(`  ${filePath}:${finding.line}  ${finding.message}`);
  }
}

function runCheck(root: Record<string, unknown>, files: string[]): number {
  let hasFailure = false;
  for (const filePath of files) {
    if (!existsSync(filePath)) {
      console.error(`No such file: ${filePath}`);
      hasFailure = true;
      continue;
    }
    const source = readFileSync(filePath, 'utf8');
    const result = checkDesign(source, root);
    if (result.findings.length > 0) hasFailure = true;
    reportFileFindings(filePath, result);
    console.log(result.coverageSummary);
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
  rest: string[];
}

/** Pulls `--tokens <path>` out of `argv`, wherever it appears, leaving the rest in order. */
function extractTokensFlag(argv: string[]): ParsedArgv {
  const rest: string[] = [];
  let tokensOverride: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--tokens') {
      tokensOverride = argv[i + 1];
      i += 1;
      continue;
    }
    rest.push(argv[i]);
  }
  return { tokensOverride, rest };
}

const { tokensOverride, rest: argv } = extractTokensFlag(process.argv.slice(2));
const [command, ...rest] = argv;

switch (command) {
  case 'token': {
    const root = loadTokens(tokensOverride);
    if (!root) process.exit(1);
    if (!rest[0]) {
      usage();
      process.exit(1);
    }
    process.exit(runToken(root, rest[0]));
    break;
  }
  case 'list': {
    const root = loadTokens(tokensOverride);
    if (!root) process.exit(1);
    process.exit(runList(root, rest[0]));
    break;
  }
  case 'scales': {
    const root = loadTokens(tokensOverride);
    if (!root) process.exit(1);
    process.exit(runScales(root));
    break;
  }
  case 'extract': {
    process.exit(runExtract());
    break;
  }
  case 'check': {
    if (rest.length === 0) {
      usage();
      process.exit(1);
    }
    const root = loadTokens(tokensOverride);
    if (!root) process.exit(1);
    process.exit(runCheck(root, rest));
    break;
  }
  case 'render': {
    if (!rest[0]) {
      usage();
      process.exit(1);
    }
    const root = loadTokens(tokensOverride);
    if (!root) process.exit(1);
    runRender(root, rest[0]).then((exitCode) => process.exit(exitCode));
    break;
  }
  default:
    usage();
    process.exit(1);
}
