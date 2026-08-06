import { parseColor, parseDimension } from './dtcg-normalize.mjs';

/** One deterministic design-system violation, tied to the line that caused it. */
export interface Finding {
  line: number;
  message: string;
}

/** The findings for one file, plus its token-coverage trend line. */
export interface CheckResult {
  findings: Finding[];
  coverageSummary: string;
}

/** Printed once per run. Names the plugin that owns everything `check` deliberately skips. */
export const ACCESSIBILITY_SCOPE_NOTE =
  'Focus states, ARIA, landmarks, and every other WCAG concern beyond declared-pair contrast and declared hit-target size are owned by @agent-kit/plugin-accessibility, not this check.';

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

interface DtcgColorValue {
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
const REM_TO_PX = 16;
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
    a.components.every(
      (component, index) =>
        Math.abs(component - b.components[index]) <= COLOR_COMPONENT_EPSILON,
    )
  );
}

function dimensionsEqual(a: DtcgDimensionValue, b: unknown): boolean {
  return isDimensionValue(b) && a.value === b.value && a.unit === b.unit;
}

function formatDimensionValue(value: number, unit: string): string {
  return `${value}${unit}`;
}

// Line-based, not a full CSS parser: assumes one selector opener/closer and one
// declaration per line, which every formatted stylesheet this ships against uses.
function parseDeclarations(source: string): CssDeclaration[] {
  const declarations: CssDeclaration[] = [];
  let currentSelector = '';
  source.split('\n').forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line.endsWith('{')) {
      currentSelector = line.slice(0, -1).trim();
      return;
    }
    if (line === '}') {
      currentSelector = '';
      return;
    }
    const match = /^([a-zA-Z-]+)\s*:\s*([^;]+);?$/.exec(line);
    if (!match || !currentSelector) return;
    declarations.push({
      selector: currentSelector,
      property: match[1],
      value: match[2].trim(),
      line: index + 1,
    });
  });
  return declarations;
}

function groupBySelector(declarations: CssDeclaration[]): CssDeclaration[][] {
  const groups: CssDeclaration[][] = [];
  let current: CssDeclaration[] = [];
  for (const declaration of declarations) {
    if (current.length > 0 && current[0].selector !== declaration.selector) {
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

function cssVarNameToTokenPath(varName: string): string | undefined {
  const segments = varName.replace(/^--/, '').split('-');
  for (const prefix of CSS_VAR_GROUP_PREFIXES) {
    const matchesPrefix = prefix.segments.every(
      (segment, index) => segments[index] === segment,
    );
    if (!matchesPrefix) continue;
    const rest = segments.slice(prefix.segments.length);
    if (rest.length === 0) continue;
    return `${prefix.group}.${rest.join('.')}`;
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
    if (alias) return resolveTokenValue(root, alias[1]);
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

function scaleValuesForUnit(entries: TokenEntry[], unit: string): number[] {
  const values = entries
    .map((entry) => entry.value)
    .filter(
      (value): value is DtcgDimensionValue =>
        isDimensionValue(value) && value.unit === unit,
    )
    .map((value) => value.value);
  return [...new Set(values)].sort((left, right) => left - right);
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
  for (const declaration of declarations) {
    if (!isTargetProperty(declaration.property)) continue;
    if (parseCssVarReference(declaration.value)) continue;
    for (const token of declaration.value.split(/\s+/)) {
      const dimension = parseDimension(token);
      if (!dimension) continue;
      const scale = scaleValuesForUnit(scaleEntries, dimension.unit);
      if (scale.length === 0 || scale.includes(dimension.value)) continue;
      const nearest = findNearestValue(dimension.value, scale);
      findings.push({
        line: declaration.line,
        message: `${token} is off the ${scaleLabel} scale (${scale
          .map((value) => formatDimensionValue(value, dimension.unit))
          .join(
            ', ',
          )}). Nearest is ${formatDimensionValue(nearest, dimension.unit)}.`,
      });
    }
  }
  return findings;
}

function linearizeChannel(channel: number): number {
  return channel <= SRGB_LINEAR_THRESHOLD
    ? channel / SRGB_LINEAR_DIVISOR
    : ((channel + SRGB_GAMMA_OFFSET) / SRGB_GAMMA_SCALE) ** SRGB_GAMMA_EXPONENT;
}

function relativeLuminance(color: DtcgColorValue): number {
  const [r, g, b] = color.components;
  return (
    LUMINANCE_WEIGHT_R * linearizeChannel(r) +
    LUMINANCE_WEIGHT_G * linearizeChannel(g) +
    LUMINANCE_WEIGHT_B * linearizeChannel(b)
  );
}

function contrastRatio(a: DtcgColorValue, b: DtcgColorValue): number {
  const luminanceA = relativeLuminance(a);
  const luminanceB = relativeLuminance(b);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + CONTRAST_OFFSET) / (darker + CONTRAST_OFFSET);
}

const HEX6_PATTERN = /^#([0-9a-fA-F]{6})$/;
const HEX_CHANNEL_MAX = 255;

// The ratio math needs full sRGB precision. `parseColor` rounds to three decimals for
// token authoring, which is precise enough for a value comparison but not for a contrast
// ratio, since a fifth-decimal error can flip which side of 4.5:1 the result lands on.
function parseHexPrecise(raw: string): DtcgColorValue | undefined {
  const match = HEX6_PATTERN.exec(raw.trim());
  if (!match) return undefined;
  const digits = match[1];
  const components = [0, 2, 4].map(
    (offset) =>
      parseInt(digits.slice(offset, offset + 2), 16) / HEX_CHANNEL_MAX,
  );
  return { colorSpace: 'srgb', components };
}

function resolveDeclaredColor(
  root: Record<string, unknown>,
  raw: string,
): DtcgColorValue | undefined {
  const varName = parseCssVarReference(raw);
  if (varName) {
    const path = cssVarNameToTokenPath(varName);
    const value = path ? resolveTokenValue(root, path) : undefined;
    return isColorValue(value) ? value : undefined;
  }
  return parseHexPrecise(raw) ?? parseColor(raw);
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
    if (foreground.colorSpace !== 'srgb' || background.colorSpace !== 'srgb')
      continue;
    const ratio = contrastRatio(foreground, background);
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
  if (dimension.unit === 'rem') return dimension.value * REM_TO_PX;
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
    const path = cssVarNameToTokenPath(varName);
    return path !== undefined && resolveTokenValue(root, path) !== undefined;
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
  return `Token coverage: ${covered.length}/${relevant.length} design-relevant declarations use a token (${percentage}%).`;
}

/**
 * Runs every deterministic design check against one file's CSS text.
 *
 * @param source The file's raw text.
 * @param root The parsed DTCG token document, as read from `.claude/design/tokens.json`.
 */
export function checkDesign(
  source: string,
  root: Record<string, unknown>,
): CheckResult {
  const declarations = parseDeclarations(source);
  const groups = groupBySelector(declarations);
  const colorEntries = collectGroupEntries(root, 'color');
  const spacingEntries = collectGroupEntries(root, 'spacing');
  const fontSizeEntries = collectGroupEntries(root, 'fontSize');
  const radiusEntries = collectGroupEntries(root, 'radius');

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
  );

  return { findings, coverageSummary };
}
