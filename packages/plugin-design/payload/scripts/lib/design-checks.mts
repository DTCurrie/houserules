import {
  parseColor,
  parseDimension,
  toMeasurableSrgb,
} from './dtcg-normalize.mjs';

/** One deterministic design-system violation, tied to the line that caused it. */
export interface Finding {
  line: number;
  message: string;
}

/** The findings for one file, plus its token-coverage trend line. */
export interface CheckResult {
  findings: Finding[];
  coverageSummary: string;
  /** Chunks the declaration splitter could not parse into a selector/property/value triple. */
  unparsedCount: number;
  /**
   * Declarations the splitter did read. Zero on a component file whose styling is entirely
   * class names, which is what lets a caller tell "nothing to report here" apart from
   * "nothing was checked here".
   */
  declarationCount: number;
}

/** Printed once per run. Names the plugin that owns everything `check` deliberately skips. */
export const ACCESSIBILITY_SCOPE_NOTE =
  'Focus states, ARIA, landmarks, and every other WCAG concern beyond declared-pair contrast and declared hit-target size are owned by @houserules/plugin-accessibility, not this check.';

interface CssDeclaration {
  selector: string;
  property: string;
  value: string;
  line: number;
}

interface TokenEntry {
  path: string;
  value: unknown;
}

/**
 * A DTCG color `$value`. Exported because `rendered-checks.mts` computes contrast against
 * colors read from a live DOM and must use this module's formula, not a second copy of it.
 */
export interface DtcgColorValue {
  colorSpace: string;
  components: number[];
  alpha?: number;
}

interface DtcgDimensionValue {
  value: number;
  unit: string;
}

const SPACING_PROPERTY_PATTERN =
  /^(margin|padding|gap|inset|top|right|bottom|left)(-[a-z]+)?$/i;
const COLOR_PROPERTY_PATTERN =
  /^(color|background|background-color|border|border-color|fill|stroke)$/i;
const CSS_VAR_PATTERN = /^var\(\s*(--[\w-]+)\s*\)$/;
const HEX_LITERAL_PATTERN = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_LITERAL_PATTERN = /rgba?\([^)]*\)/gi;
const OKLCH_LITERAL_PATTERN = /oklch\([^)]*\)/gi;
const ALIAS_PATTERN = /^\{([^{}]+)\}$/;

const SRGB_LINEAR_THRESHOLD = 0.03928;
const SRGB_LINEAR_DIVISOR = 12.92;
const SRGB_GAMMA_OFFSET = 0.055;
const SRGB_GAMMA_SCALE = 1.055;
const SRGB_GAMMA_EXPONENT = 2.4;
const LUMINANCE_WEIGHT_R = 0.2126;
const LUMINANCE_WEIGHT_G = 0.7152;
const LUMINANCE_WEIGHT_B = 0.0722;
const CONTRAST_OFFSET = 0.05;
const CONTRAST_MINIMUM = 4.5;

const HIT_TARGET_MINIMUM_PX = 24;
const REM_BASE_PX = 16;
const INTERACTIVE_SELECTOR_KEYWORDS = [
  'button',
  'btn',
  'action',
  'control',
  'toggle',
  'switch',
  'checkbox',
  'radio',
  'tab',
  'link',
  'icon',
];

const PERCENTAGE_MULTIPLIER = 100;
// A token authored by hand can round a channel to two decimals while a literal converted
// from hex rounds to three, so an exact match would miss a value that is the same color.
const COLOR_COMPONENT_EPSILON = 0.006;

const CSS_VAR_GROUP_PREFIXES: Array<{ segments: string[]; group: string }> = [
  { segments: ['font', 'size'], group: 'fontSize' },
  { segments: ['font', 'family'], group: 'fontFamily' },
  { segments: ['font', 'weight'], group: 'fontWeight' },
  { segments: ['color'], group: 'color' },
  { segments: ['spacing'], group: 'spacing' },
  { segments: ['radius'], group: 'radius' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isColorValue(value: unknown): value is DtcgColorValue {
  return (
    isRecord(value) &&
    typeof value.colorSpace === 'string' &&
    Array.isArray(value.components) &&
    value.components.every((component) => typeof component === 'number')
  );
}

function isDimensionValue(value: unknown): value is DtcgDimensionValue {
  return (
    isRecord(value) &&
    typeof value.value === 'number' &&
    typeof value.unit === 'string'
  );
}

function colorsEqual(a: DtcgColorValue, b: unknown): boolean {
  return (
    isColorValue(b) &&
    a.colorSpace === b.colorSpace &&
    a.components.length === b.components.length &&
    a.components.every((component, index) => {
      const other = b.components[index];
      return (
        other !== undefined &&
        Math.abs(component - other) <= COLOR_COMPONENT_EPSILON
      );
    })
  );
}

function dimensionsEqual(a: DtcgDimensionValue, b: unknown): boolean {
  return isDimensionValue(b) && a.value === b.value && a.unit === b.unit;
}

function formatDimensionValue(value: number, unit: string): string {
  return `${value}${unit}`;
}

const DECLARATION_PATTERN = /^([a-zA-Z-]+)\s*:\s*(.+)$/;

/** `parseDeclarations`'s result, plus a count of chunks it could not turn into a declaration. */
interface ParsedDeclarations {
  declarations: CssDeclaration[];
  /** Non-empty chunks dropped because they were not a `property: value` pair inside a rule. */
  unparsedCount: number;
}

/**
 * Not a full CSS parser: splits rules on `}` and declarations on `;` rather than assuming
 * one per line, so compactly formatted CSS scans the same as conventionally formatted CSS.
 * Line numbers are tracked as characters are consumed rather than read off the split, since
 * a chunk may start partway through a line or span several.
 */
function parseDeclarations(source: string): ParsedDeclarations {
  const declarations: CssDeclaration[] = [];
  let unparsedCount = 0;
  let currentSelector: string | undefined;
  let line = 1;
  let buffer = '';
  let bufferStartLine = line;

  const flushDeclaration = (): void => {
    const text = buffer.trim();
    buffer = '';
    if (text.length === 0) return;
    const match = currentSelector ? DECLARATION_PATTERN.exec(text) : null;
    const property = match?.[1];
    const value = match?.[2];
    if (match && property !== undefined && value !== undefined) {
      declarations.push({
        selector: currentSelector as string,
        property,
        value: value.trim(),
        line: bufferStartLine,
      });
    } else {
      unparsedCount += 1;
    }
  };

  for (const char of source.replace(/\r/g, '')) {
    if (char === '\n') {
      line += 1;
      if (buffer.length === 0) bufferStartLine = line;
      else buffer += ' ';
      continue;
    }
    if (char === '{') {
      currentSelector = buffer.trim();
      buffer = '';
      bufferStartLine = line;
      continue;
    }
    if (char === '}') {
      flushDeclaration();
      currentSelector = undefined;
      bufferStartLine = line;
      continue;
    }
    if (char === ';') {
      flushDeclaration();
      bufferStartLine = line;
      continue;
    }
    if (buffer.length === 0 && /\s/.test(char)) continue;
    buffer += char;
  }
  // A chunk left in the buffer with no closing `;` or `}` was never attempted, and is
  // counted as unparsed rather than silently discarded, same as a chunk that failed to match.
  if (buffer.trim().length > 0) unparsedCount += 1;
  return { declarations, unparsedCount };
}

function groupBySelector(declarations: CssDeclaration[]): CssDeclaration[][] {
  const groups: CssDeclaration[][] = [];
  let current: CssDeclaration[] = [];
  for (const declaration of declarations) {
    const first = current[0];
    if (first !== undefined && first.selector !== declaration.selector) {
      groups.push(current);
      current = [];
    }
    current.push(declaration);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function parseCssVarReference(value: string): string | undefined {
  const match = CSS_VAR_PATTERN.exec(value.trim());
  return match ? match[1] : undefined;
}

/**
 * The token paths a CSS custom property name could name, most specific first.
 *
 * Two token sources shape their names differently and both are legitimate. A hand-authored DTCG
 * file nests, so `--color-brand-primary` is `color.brand.primary`. A Tailwind theme does not,
 * because `brand-500` is one key in Tailwind's own `--color` namespace and splitting it would
 * invent structure the theme does not have. Returning both readings is what lets one checker
 * serve a repo on either source, and the flat one is tried first because a theme key that
 * happens to contain a hyphen is the more specific match.
 */
function cssVarNameToTokenPaths(varName: string): string[] {
  const segments = varName.replace(/^--/, '').split('-');
  for (const prefix of CSS_VAR_GROUP_PREFIXES) {
    const matchesPrefix = prefix.segments.every(
      (segment, index) => segments[index] === segment,
    );
    if (!matchesPrefix) continue;
    const rest = segments.slice(prefix.segments.length);
    if (rest.length === 0) continue;
    const flat = `${prefix.group}.${rest.join('-')}`;
    const nested = `${prefix.group}.${rest.join('.')}`;
    return flat === nested ? [flat] : [flat, nested];
  }
  return [];
}

function resolveTokenByVarName(
  root: Record<string, unknown>,
  varName: string,
): unknown {
  for (const path of cssVarNameToTokenPaths(varName)) {
    const value = resolveTokenValue(root, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

function resolveTokenValue(
  root: Record<string, unknown>,
  path: string,
): unknown {
  let current: Record<string, unknown> = root;
  for (const segment of path.split('.')) {
    const next = current[segment];
    if (!isRecord(next)) return undefined;
    current = next;
  }
  if (!Object.prototype.hasOwnProperty.call(current, '$value'))
    return undefined;
  const value = current.$value;
  if (typeof value === 'string') {
    const alias = ALIAS_PATTERN.exec(value);
    const target = alias?.[1];
    if (target !== undefined) return resolveTokenValue(root, target);
  }
  return value;
}

function collectGroupEntries(
  root: Record<string, unknown>,
  group: string,
): TokenEntry[] {
  const groupNode = root[group];
  if (!isRecord(groupNode)) return [];
  const entries: TokenEntry[] = [];
  const walk = (node: Record<string, unknown>, path: string): void => {
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$') || !isRecord(child)) continue;
      const childPath = `${path}.${key}`;
      if (Object.prototype.hasOwnProperty.call(child, '$value')) {
        entries.push({
          path: childPath,
          value: resolveTokenValue(root, childPath),
        });
      } else {
        walk(child, childPath);
      }
    }
  };
  walk(groupNode, group);
  return entries;
}

function extractColorLiterals(value: string): string[] {
  const matches: string[] = [];
  for (const pattern of [
    HEX_LITERAL_PATTERN,
    RGB_LITERAL_PATTERN,
    OKLCH_LITERAL_PATTERN,
  ]) {
    for (const match of value.matchAll(pattern)) matches.push(match[0]);
  }
  return matches;
}

function isSpacingProperty(property: string): boolean {
  return SPACING_PROPERTY_PATTERN.test(property);
}

function isFontSizeProperty(property: string): boolean {
  return property === 'font-size';
}

function isRadiusProperty(property: string): boolean {
  return property === 'border-radius';
}

/**
 * Every scale value, in pixels regardless of the unit it was authored in, so a `px`
 * declaration can be checked against a `rem`-authored scale instead of being dropped.
 */
function scaleValuesInPixels(entries: TokenEntry[]): number[] {
  const values = entries
    .map((entry) => entry.value)
    .filter(isDimensionValue)
    .map(toPixels)
    .filter((value): value is number => value !== undefined);
  return [...new Set(values)].sort((left, right) => left - right);
}

function pixelsToUnit(pixels: number, unit: string): number {
  return unit === 'rem' ? pixels / REM_BASE_PX : pixels;
}

function findNearestValue(target: number, candidates: number[]): number {
  return candidates.reduce((closest, candidate) =>
    Math.abs(candidate - target) < Math.abs(closest - target)
      ? candidate
      : closest,
  );
}

function checkUntokenizedColors(
  declarations: CssDeclaration[],
  colorEntries: TokenEntry[],
): Finding[] {
  const findings: Finding[] = [];
  for (const declaration of declarations) {
    if (parseCssVarReference(declaration.value)) continue;
    for (const literal of extractColorLiterals(declaration.value)) {
      const parsed = parseColor(literal);
      if (!parsed) continue;
      const match = colorEntries.find((entry) =>
        colorsEqual(parsed, entry.value),
      );
      findings.push({
        line: declaration.line,
        message: match
          ? `${literal} is exactly \`${match.path}\`. Use \`${match.path}\` instead of the literal.`
          : `${literal} matches no token. This is a new value and needs a design decision before it joins the token set.`,
      });
    }
  }
  return findings;
}

function checkOffScaleDimension(
  declarations: CssDeclaration[],
  isTargetProperty: (property: string) => boolean,
  scaleEntries: TokenEntry[],
  scaleLabel: string,
): Finding[] {
  const findings: Finding[] = [];
  const scalePx = scaleValuesInPixels(scaleEntries);
  if (scalePx.length === 0) return findings;
  for (const declaration of declarations) {
    if (!isTargetProperty(declaration.property)) continue;
    if (parseCssVarReference(declaration.value)) continue;
    for (const token of declaration.value.split(/\s+/)) {
      const dimension = parseDimension(token);
      if (!dimension) continue;
      const targetPx = toPixels(dimension);
      if (targetPx === undefined || scalePx.includes(targetPx)) continue;
      const nearestPx = findNearestValue(targetPx, scalePx);
      findings.push({
        line: declaration.line,
        message: `${token} is off the ${scaleLabel} scale (${scalePx
          .map((pxValue) =>
            formatDimensionValue(
              pixelsToUnit(pxValue, dimension.unit),
              dimension.unit,
            ),
          )
          .join(', ')}). Nearest is ${formatDimensionValue(
          pixelsToUnit(nearestPx, dimension.unit),
          dimension.unit,
        )}.`,
      });
    }
  }
  return findings;
}

/**
 * A sibling to {@link checkOffScaleDimension}, for the opposite miss: a value that already
 * sits on a scale step but was hand-typed instead of referencing the token that owns that
 * step. `checkOffScaleDimension` short-circuits on `scalePx.includes(targetPx)` on purpose,
 * so an on-scale literal passed through unflagged until this.
 */
function checkOnScaleLiteralToken(
  declarations: CssDeclaration[],
  isTargetProperty: (property: string) => boolean,
  scaleEntries: TokenEntry[],
): Finding[] {
  const findings: Finding[] = [];
  const scalePx = scaleValuesInPixels(scaleEntries);
  if (scalePx.length === 0) return findings;
  for (const declaration of declarations) {
    if (!isTargetProperty(declaration.property)) continue;
    if (parseCssVarReference(declaration.value)) continue;
    for (const token of declaration.value.split(/\s+/)) {
      const dimension = parseDimension(token);
      if (!dimension) continue;
      const targetPx = toPixels(dimension);
      if (targetPx === undefined || !scalePx.includes(targetPx)) continue;
      const entry = scaleEntries.find((candidate) => {
        const value = candidate.value;
        return isDimensionValue(value) && toPixels(value) === targetPx;
      });
      if (!entry) continue;
      findings.push({
        line: declaration.line,
        message: `${token} is exactly \`${entry.path}\`. Use \`${entry.path}\` instead of the literal.`,
      });
    }
  }
  return findings;
}

const FONT_WEIGHT_PROPERTY = 'font-weight';

/**
 * The two names `design.mts`' own `parseFontWeight` cannot resolve, since it only reads
 * numeric weights out of a token file. A literal in CSS is fair game to write either way,
 * so a checker over the literal has to know both.
 */
const NAMED_FONT_WEIGHTS: Record<string, number> = {
  normal: 400,
  bold: 700,
};

function parseFontWeightLiteral(value: string): number | undefined {
  const trimmed = value.trim();
  const named = NAMED_FONT_WEIGHTS[trimmed.toLowerCase()];
  if (named !== undefined) return named;
  const numeric = Number(trimmed);
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 1000
    ? numeric
    : undefined;
}

/**
 * The tokens-over-literals clause names "a named font weight typed inline" as its own
 * example, distinct from color and dimension literals, and nothing in this file checked it.
 */
function checkUntokenizedFontWeight(
  declarations: CssDeclaration[],
  fontWeightEntries: TokenEntry[],
): Finding[] {
  const findings: Finding[] = [];
  for (const declaration of declarations) {
    if (declaration.property !== FONT_WEIGHT_PROPERTY) continue;
    if (parseCssVarReference(declaration.value)) continue;
    const weight = parseFontWeightLiteral(declaration.value);
    if (weight === undefined) continue;
    const literal = declaration.value.trim();
    const match = fontWeightEntries.find((entry) => entry.value === weight);
    findings.push({
      line: declaration.line,
      message: match
        ? `${literal} is exactly \`${match.path}\`. Use \`${match.path}\` instead of the literal.`
        : `${literal} matches no token. This is a new value and needs a design decision before it joins the token set.`,
    });
  }
  return findings;
}

function linearizeChannel(channel: number): number {
  return channel <= SRGB_LINEAR_THRESHOLD
    ? channel / SRGB_LINEAR_DIVISOR
    : ((channel + SRGB_GAMMA_OFFSET) / SRGB_GAMMA_SCALE) ** SRGB_GAMMA_EXPONENT;
}

/** WCAG relative luminance. Used only by {@link contrastRatio}, which the rendered tier shares. */
function relativeLuminance(color: DtcgColorValue): number {
  const [r, g, b] = color.components;
  if (r === undefined || g === undefined || b === undefined) return 0;
  return (
    LUMINANCE_WEIGHT_R * linearizeChannel(r) +
    LUMINANCE_WEIGHT_G * linearizeChannel(g) +
    LUMINANCE_WEIGHT_B * linearizeChannel(b)
  );
}

/** WCAG contrast ratio between two colors. Exported so the rendered tier shares one copy. */
export function contrastRatio(a: DtcgColorValue, b: DtcgColorValue): number {
  const luminanceA = relativeLuminance(a);
  const luminanceB = relativeLuminance(b);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + CONTRAST_OFFSET) / (darker + CONTRAST_OFFSET);
}

// The DTCG document already rounds stored colors to three decimals, so measuring more
// precisely here would only manufacture a mismatch against the rendered tier.
function resolveDeclaredColor(
  root: Record<string, unknown>,
  raw: string,
): DtcgColorValue | undefined {
  const varName = parseCssVarReference(raw);
  if (varName) {
    const value = resolveTokenByVarName(root, varName);
    return isColorValue(value) ? value : undefined;
  }
  return parseColor(raw);
}

function findBackgroundDeclaration(
  group: CssDeclaration[],
): CssDeclaration | undefined {
  return group.find(
    (declaration) =>
      declaration.property === 'background' ||
      declaration.property === 'background-color',
  );
}

// A BEM element (`.block__element`) rarely restates its block's background, but the
// cascade still composites them at render time, so the block's background is the
// effective one for this element's declared-pair contrast.
function blockSelector(selector: string): string | undefined {
  const match = /^(\.[a-zA-Z0-9-]+)__[a-zA-Z0-9-]+/.exec(selector.trim());
  return match ? match[1] : undefined;
}

function findBlockBackgroundDeclaration(
  groups: CssDeclaration[][],
  selector: string,
): CssDeclaration | undefined {
  const block = blockSelector(selector);
  if (!block) return undefined;
  const blockGroup = groups.find(
    (candidate) => candidate[0]?.selector === block,
  );
  return blockGroup ? findBackgroundDeclaration(blockGroup) : undefined;
}

function checkTokenPairContrast(
  root: Record<string, unknown>,
  groups: CssDeclaration[][],
): Finding[] {
  const findings: Finding[] = [];
  for (const group of groups) {
    const selector = group[0]?.selector ?? '';
    const colorDeclaration = group.find(
      (declaration) => declaration.property === 'color',
    );
    if (!colorDeclaration) continue;
    const backgroundDeclaration =
      findBackgroundDeclaration(group) ??
      findBlockBackgroundDeclaration(groups, selector);
    if (!backgroundDeclaration) continue;
    const foreground = resolveDeclaredColor(root, colorDeclaration.value);
    const background = resolveDeclaredColor(root, backgroundDeclaration.value);
    if (!foreground || !background) continue;
    const measurableForeground = toMeasurableSrgb(foreground);
    const measurableBackground = toMeasurableSrgb(background);
    if (!measurableForeground || !measurableBackground) {
      const unsupportedSpaces = [
        !measurableForeground ? foreground.colorSpace : undefined,
        !measurableBackground ? background.colorSpace : undefined,
      ].filter((space): space is string => space !== undefined);
      findings.push({
        line: colorDeclaration.line,
        message: `${colorDeclaration.value} on ${backgroundDeclaration.value} could not be checked for contrast: unsupported color space ${unsupportedSpaces.join(', ')}.`,
      });
      continue;
    }
    const ratio = contrastRatio(measurableForeground, measurableBackground);
    if (ratio >= CONTRAST_MINIMUM) continue;
    findings.push({
      line: colorDeclaration.line,
      message: `${colorDeclaration.value} on ${backgroundDeclaration.value} is ${ratio.toFixed(2)}:1, under the 4.5:1 minimum for this declared pair. A rendered page composites more than these two declarations, so this is not what a user necessarily sees.`,
    });
  }
  return findings;
}

function toPixels(dimension: DtcgDimensionValue): number | undefined {
  if (dimension.unit === 'px') return dimension.value;
  if (dimension.unit === 'rem') return dimension.value * REM_BASE_PX;
  return undefined;
}

function looksInteractive(selector: string): boolean {
  const lowered = selector.toLowerCase();
  return INTERACTIVE_SELECTOR_KEYWORDS.some((keyword) =>
    lowered.includes(keyword),
  );
}

interface HitTargetSize {
  widthPx: number;
  heightPx: number;
  line: number;
}

function findDimensionPair(
  group: CssDeclaration[],
  widthProperty: string,
  heightProperty: string,
): HitTargetSize | undefined {
  const widthDeclaration = group.find(
    (declaration) => declaration.property === widthProperty,
  );
  const heightDeclaration = group.find(
    (declaration) => declaration.property === heightProperty,
  );
  if (!widthDeclaration || !heightDeclaration) return undefined;
  const width = parseDimension(widthDeclaration.value);
  const height = parseDimension(heightDeclaration.value);
  if (!width || !height) return undefined;
  const widthPx = toPixels(width);
  const heightPx = toPixels(height);
  if (widthPx === undefined || heightPx === undefined) return undefined;
  return { widthPx, heightPx, line: widthDeclaration.line };
}

function checkHitTarget(groups: CssDeclaration[][]): Finding[] {
  const findings: Finding[] = [];
  for (const group of groups) {
    const selector = group[0]?.selector ?? '';
    if (!looksInteractive(selector)) continue;
    const size =
      findDimensionPair(group, 'width', 'height') ??
      findDimensionPair(group, 'min-width', 'min-height');
    if (!size) continue;
    if (
      size.widthPx >= HIT_TARGET_MINIMUM_PX &&
      size.heightPx >= HIT_TARGET_MINIMUM_PX
    ) {
      continue;
    }
    findings.push({
      line: size.line,
      message: `${selector} is a ${size.widthPx} by ${size.heightPx} CSS pixel target, under the 24 by 24 minimum (WCAG 2.5.8).`,
    });
  }
  return findings;
}

function isColorLikeDeclaration(declaration: CssDeclaration): boolean {
  if (!COLOR_PROPERTY_PATTERN.test(declaration.property)) return false;
  return (
    extractColorLiterals(declaration.value).length > 0 ||
    parseCssVarReference(declaration.value) !== undefined
  );
}

function isDimensionLikeDeclaration(declaration: CssDeclaration): boolean {
  const isScaleProperty =
    isSpacingProperty(declaration.property) ||
    isFontSizeProperty(declaration.property) ||
    isRadiusProperty(declaration.property);
  if (!isScaleProperty) return false;
  if (parseCssVarReference(declaration.value)) return true;
  return declaration.value
    .split(/\s+/)
    .some((token) => parseDimension(token) !== undefined);
}

function isDesignRelevantDeclaration(declaration: CssDeclaration): boolean {
  return (
    isColorLikeDeclaration(declaration) ||
    isDimensionLikeDeclaration(declaration)
  );
}

function scaleEntriesForProperty(
  property: string,
  spacingEntries: TokenEntry[],
  fontSizeEntries: TokenEntry[],
  radiusEntries: TokenEntry[],
): TokenEntry[] | undefined {
  if (isSpacingProperty(property)) return spacingEntries;
  if (isFontSizeProperty(property)) return fontSizeEntries;
  if (isRadiusProperty(property)) return radiusEntries;
  return undefined;
}

function isColorDeclarationTokenBacked(
  declaration: CssDeclaration,
  colorEntries: TokenEntry[],
): boolean {
  return extractColorLiterals(declaration.value).some((literal) => {
    const parsed = parseColor(literal);
    return (
      parsed !== undefined &&
      colorEntries.some((entry) => colorsEqual(parsed, entry.value))
    );
  });
}

function isDimensionDeclarationTokenBacked(
  declaration: CssDeclaration,
  entries: TokenEntry[],
): boolean {
  return declaration.value.split(/\s+/).every((token) => {
    const dimension = parseDimension(token);
    return (
      dimension !== undefined &&
      entries.some((entry) => dimensionsEqual(dimension, entry.value))
    );
  });
}

function isTokenBacked(
  root: Record<string, unknown>,
  declaration: CssDeclaration,
  colorEntries: TokenEntry[],
  spacingEntries: TokenEntry[],
  fontSizeEntries: TokenEntry[],
  radiusEntries: TokenEntry[],
): boolean {
  const varName = parseCssVarReference(declaration.value);
  if (varName) {
    return resolveTokenByVarName(root, varName) !== undefined;
  }
  if (COLOR_PROPERTY_PATTERN.test(declaration.property)) {
    return isColorDeclarationTokenBacked(declaration, colorEntries);
  }
  const entries = scaleEntriesForProperty(
    declaration.property,
    spacingEntries,
    fontSizeEntries,
    radiusEntries,
  );
  return (
    entries !== undefined &&
    isDimensionDeclarationTokenBacked(declaration, entries)
  );
}

function checkTokenCoverage(
  root: Record<string, unknown>,
  declarations: CssDeclaration[],
  colorEntries: TokenEntry[],
  spacingEntries: TokenEntry[],
  fontSizeEntries: TokenEntry[],
  radiusEntries: TokenEntry[],
  unitLabel: string,
): string {
  const relevant = declarations.filter(isDesignRelevantDeclaration);
  const covered = relevant.filter((declaration) =>
    isTokenBacked(
      root,
      declaration,
      colorEntries,
      spacingEntries,
      fontSizeEntries,
      radiusEntries,
    ),
  );
  const percentage =
    relevant.length === 0
      ? 0
      : Math.round((covered.length / relevant.length) * PERCENTAGE_MULTIPLIER);
  return `Token coverage: ${covered.length}/${relevant.length} design-relevant ${unitLabel} use a token (${percentage}%).`;
}

/** What the coverage summary counts when the source is a file's own CSS. */
const DECLARATION_COVERAGE_UNIT = 'declarations';

/**
 * Runs every deterministic design check against one file's CSS text.
 *
 * @param source The file's raw text.
 * @param root The parsed DTCG token document, as read from `.claude/design/tokens.json`.
 * @param coverageUnit What the coverage summary should call the things it counted. A caller that
 * synthesized this CSS from something else, as the Tailwind class path does, has to say so, or a
 * reader sees a count of declarations for a file that has none and trusts the number over the
 * findings printed above it.
 */
export function checkDesign(
  source: string,
  root: Record<string, unknown>,
  coverageUnit: string = DECLARATION_COVERAGE_UNIT,
): CheckResult {
  const { declarations, unparsedCount } = parseDeclarations(source);
  const groups = groupBySelector(declarations);
  const colorEntries = collectGroupEntries(root, 'color');
  const spacingEntries = collectGroupEntries(root, 'spacing');
  const fontSizeEntries = collectGroupEntries(root, 'fontSize');
  const radiusEntries = collectGroupEntries(root, 'radius');
  const fontWeightEntries = collectGroupEntries(root, 'fontWeight');

  const findings = [
    ...checkUntokenizedColors(declarations, colorEntries),
    ...checkOffScaleDimension(
      declarations,
      isSpacingProperty,
      spacingEntries,
      'spacing',
    ),
    ...checkOffScaleDimension(
      declarations,
      isFontSizeProperty,
      fontSizeEntries,
      'font size',
    ),
    ...checkOffScaleDimension(
      declarations,
      isRadiusProperty,
      radiusEntries,
      'radius',
    ),
    ...checkOnScaleLiteralToken(
      declarations,
      isSpacingProperty,
      spacingEntries,
    ),
    ...checkOnScaleLiteralToken(
      declarations,
      isFontSizeProperty,
      fontSizeEntries,
    ),
    ...checkOnScaleLiteralToken(declarations, isRadiusProperty, radiusEntries),
    ...checkUntokenizedFontWeight(declarations, fontWeightEntries),
    ...checkTokenPairContrast(root, groups),
    ...checkHitTarget(groups),
  ].sort((a, b) => a.line - b.line);

  const coverageSummary = checkTokenCoverage(
    root,
    declarations,
    colorEntries,
    spacingEntries,
    fontSizeEntries,
    radiusEntries,
    coverageUnit,
  );

  return {
    findings,
    coverageSummary,
    unparsedCount,
    declarationCount: declarations.length,
  };
}
