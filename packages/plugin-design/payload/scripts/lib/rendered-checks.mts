/**
 * Design findings from a live, rendered page, over the CDP session in `cdp-session.mts`.
 *
 * `design-checks.mts` scans CSS declarations and has to guess an element's effective
 * background from BEM naming. This module reads computed style from a real DOM, so it can
 * walk an element's ancestors for the background actually composited underneath its text,
 * and it sees values authored by utility classes, inline styles, or CSS-in-JS that a
 * declaration scan never sees at all.
 */

import { contrastRatio } from './design-checks.mjs';
import {
  parseColor,
  parseDimension,
  toMeasurableSrgb,
} from './dtcg-normalize.mjs';
import type { TokenGroup } from './dtcg-normalize.mjs';
import type { RenderSession } from './cdp-session.mjs';

/** One finding from the rendered page, tied to the element it came from. */
export interface RenderedFinding {
  selector: string;
  message: string;
}

export interface RenderedCheckResult {
  findings: RenderedFinding[];
}

const MAX_TEXT_ELEMENTS = 500;
const MAX_INTERACTIVE_ELEMENTS = 500;
const MAX_STYLE_SAMPLE_ELEMENTS = 500;

const CONTRAST_MINIMUM = 4.5;
const HIT_TARGET_MINIMUM_PX = 24;
const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, [role="button"], [onclick]';
const STYLE_SAMPLE_SELECTOR = '[style], [class]';

// getComputedStyle resolves rgb() components to whole 0-255 integers, while a token's
// stored value is rounded to three decimals after dividing by 255, so an exact color match
// needs a wider tolerance than the token-to-token comparison in design-checks.mts uses.
const COLOR_MATCH_EPSILON = 0.01;

interface ColorValue {
  colorSpace: string;
  components: number[];
}

interface DimensionValue {
  value: number;
  unit: string;
}

interface TokenEntry<TValue> {
  path: string;
  value: TValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isColorValue(value: unknown): value is ColorValue {
  return (
    isRecord(value) &&
    typeof value.colorSpace === 'string' &&
    Array.isArray(value.components) &&
    value.components.every((component) => typeof component === 'number')
  );
}

function isDimensionValue(value: unknown): value is DimensionValue {
  return (
    isRecord(value) &&
    typeof value.value === 'number' &&
    typeof value.unit === 'string'
  );
}

function collectTokenEntries<TValue>(
  root: Record<string, unknown>,
  group: TokenGroup,
  isValue: (value: unknown) => value is TValue,
): TokenEntry<TValue>[] {
  const groupNode = root[group];
  if (!isRecord(groupNode)) return [];
  const entries: TokenEntry<TValue>[] = [];
  const walk = (node: Record<string, unknown>, path: string): void => {
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$') || !isRecord(child)) continue;
      if (isValue(child.$value)) {
        entries.push({ path: `${path}.${key}`, value: child.$value });
      } else {
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(groupNode, group);
  return entries;
}

// `color` is a measured value in gamma-encoded sRGB, already converted by the caller. A token
// may still be authored in oklch, so it is converted here at the point of comparison.
function colorMatchesAnyToken(
  color: ColorValue,
  tokens: TokenEntry<ColorValue>[],
): boolean {
  return tokens.some((entry) => {
    const measurableToken = toMeasurableSrgb(entry.value);
    return (
      measurableToken !== undefined &&
      measurableToken.components.length === color.components.length &&
      measurableToken.components.every((component, index) => {
        const other = color.components[index];
        return (
          other !== undefined &&
          Math.abs(component - other) <= COLOR_MATCH_EPSILON
        );
      })
    );
  });
}

function findNearestPixels(target: number, candidates: number[]): number {
  return candidates.reduce((closest, candidate) =>
    Math.abs(candidate - target) < Math.abs(closest - target)
      ? candidate
      : closest,
  );
}

function dimensionScalePixels(entries: TokenEntry<DimensionValue>[]): number[] {
  const values = entries
    .filter((entry) => entry.value.unit === 'px')
    .map((entry) => entry.value.value);
  return [...new Set(values)].sort((left, right) => left - right);
}

function parseAlphaArgument(raw: string): number {
  return raw.trim().endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
}

/**
 * Whether a computed `backgroundColor` is opaque enough to composite text against, decided by
 * alpha rather than by which color function wrote it. `rgb`, `oklch`, `lab`, and `color()` all
 * resolve to one of two computed-style shapes: legacy comma alpha in `rgba(...)`, or a slash
 * alpha in every modern syntax. A background this can't read as either is treated as opaque,
 * matching a plain `rgb()` with no alpha argument at all.
 *
 * Its source, not a second copy, is what runs inside the page: {@link buildTextContrastExpression}
 * inlines it with `Function.prototype.toString`, so this module's own tests exercise the exact
 * text the browser evaluates.
 */
export function backgroundAlpha(background: string): number {
  const trimmed = background.trim();
  if (trimmed === 'transparent') return 0;
  const slashMatch = /\/\s*([\d.]+%?)\s*\)$/.exec(trimmed);
  const slashCaptured = slashMatch?.[1];
  if (slashCaptured !== undefined) return parseAlphaArgument(slashCaptured);
  const commaMatch = /^rgba?\(([^)]+)\)$/i.exec(trimmed);
  const commaBody = commaMatch?.[1];
  if (commaBody !== undefined) {
    const parts = commaBody.split(',').map((part) => part.trim());
    const alphaPart = parts[3];
    if (parts.length > 3 && alphaPart !== undefined && alphaPart.length > 0)
      return parseAlphaArgument(alphaPart);
  }
  return 1;
}

function describeElementScript(): string {
  return `function describeElement(el) {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? '#' + el.id : '';
      const className = typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\\s+/).join('.')
        : '';
      return tag + id + className;
    }`;
}

function buildTextContrastExpression(maxElements: number): string {
  return `(() => {
    const MAX_ELEMENTS = ${JSON.stringify(maxElements)};
    ${describeElementScript()}

    function hasVisibleText(el) {
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 0) return true;
      }
      return false;
    }

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    }

    ${parseAlphaArgument.toString()}

    ${backgroundAlpha.toString()}

    function effectiveBackground(el) {
      let current = el;
      while (current) {
        const background = getComputedStyle(current).backgroundColor;
        if (backgroundAlpha(background) > 0) return background;
        current = current.parentElement;
      }
      return 'rgb(255, 255, 255)';
    }

    const results = [];
    let truncated = false;
    for (const el of document.body.querySelectorAll('*')) {
      if (results.length >= MAX_ELEMENTS) { truncated = true; break; }
      if (!hasVisibleText(el) || !isVisible(el)) continue;
      results.push({
        selector: describeElement(el),
        color: getComputedStyle(el).color,
        background: effectiveBackground(el),
      });
    }
    return { results, truncated };
  })()`;
}

interface TextContrastCandidate {
  selector: string;
  color: string;
  background: string;
}

function buildContrastFinding(
  candidate: TextContrastCandidate,
): RenderedFinding | undefined {
  const foreground = parseColor(candidate.color);
  const background = parseColor(candidate.background);
  if (!foreground || !background) return undefined;
  const measurableForeground = toMeasurableSrgb(foreground);
  const measurableBackground = toMeasurableSrgb(background);
  if (!measurableForeground || !measurableBackground) {
    const unsupportedSpaces = [
      !measurableForeground ? foreground.colorSpace : undefined,
      !measurableBackground ? background.colorSpace : undefined,
    ].filter((space): space is string => space !== undefined);
    return {
      selector: candidate.selector,
      message: `${candidate.color} on effective background ${candidate.background} could not be checked for contrast: unsupported color space ${unsupportedSpaces.join(', ')}.`,
    };
  }
  const ratio = contrastRatio(measurableForeground, measurableBackground);
  if (ratio >= CONTRAST_MINIMUM) return undefined;
  return {
    selector: candidate.selector,
    message: `${candidate.color} on effective background ${candidate.background} is ${ratio.toFixed(2)}:1, under the 4.5:1 minimum.`,
  };
}

/**
 * Flags text whose color falls under 4.5:1 against the background actually composited
 * behind it, found by walking ancestors for the first non-transparent background rather
 * than assuming the page body.
 */
async function checkCompositedContrast(
  session: RenderSession,
): Promise<RenderedFinding[]> {
  const evaluated = await session.evaluate<{
    results: TextContrastCandidate[];
    truncated: boolean;
  }>(buildTextContrastExpression(MAX_TEXT_ELEMENTS));
  if (!evaluated.ok) {
    return [
      {
        selector: '(page)',
        message: `could not read rendered text contrast: ${evaluated.error}`,
      },
    ];
  }
  const findings: RenderedFinding[] = [];
  if (evaluated.value.truncated) {
    findings.push({
      selector: '(scan)',
      message: `stopped scanning text contrast after ${MAX_TEXT_ELEMENTS} elements. The page has more, and they were not checked.`,
    });
  }
  for (const candidate of evaluated.value.results) {
    const finding = buildContrastFinding(candidate);
    if (finding) findings.push(finding);
  }
  return findings;
}

function buildInteractiveRectsExpression(
  maxElements: number,
  selector: string,
): string {
  return `(() => {
    const MAX_ELEMENTS = ${JSON.stringify(maxElements)};
    const SELECTOR = ${JSON.stringify(selector)};
    ${describeElementScript()}

    const results = [];
    let truncated = false;
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (results.length >= MAX_ELEMENTS) { truncated = true; break; }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      results.push({ selector: describeElement(el), width: rect.width, height: rect.height });
    }
    return { results, truncated };
  })()`;
}

/**
 * Flags interactive elements whose rendered rect, not a declared width and height, is
 * under the 24 by 24 CSS pixel minimum (WCAG 2.5.8).
 */
async function checkInteractiveHitTargets(
  session: RenderSession,
): Promise<RenderedFinding[]> {
  const evaluated = await session.evaluate<{
    results: { selector: string; width: number; height: number }[];
    truncated: boolean;
  }>(
    buildInteractiveRectsExpression(
      MAX_INTERACTIVE_ELEMENTS,
      INTERACTIVE_SELECTOR,
    ),
  );
  if (!evaluated.ok) {
    return [
      {
        selector: '(page)',
        message: `could not read rendered hit targets: ${evaluated.error}`,
      },
    ];
  }
  const findings: RenderedFinding[] = [];
  if (evaluated.value.truncated) {
    findings.push({
      selector: '(scan)',
      message: `stopped scanning interactive elements after ${MAX_INTERACTIVE_ELEMENTS}. The page has more, and they were not checked.`,
    });
  }
  for (const rect of evaluated.value.results) {
    if (
      rect.width >= HIT_TARGET_MINIMUM_PX &&
      rect.height >= HIT_TARGET_MINIMUM_PX
    )
      continue;
    findings.push({
      selector: rect.selector,
      message: `rendered at ${Math.round(rect.width)} by ${Math.round(rect.height)} CSS pixels, under the 24 by 24 minimum (WCAG 2.5.8).`,
    });
  }
  return findings;
}

const STYLE_SAMPLE_PROPERTIES = [
  'color',
  'backgroundColor',
  'fontSize',
  'padding',
  'margin',
  'gap',
  'borderRadius',
] as const;

/**
 * Builds the in-page half of the drift check. A tag's user-agent default is read once per
 * tag name, from a detached element of that tag appended to the document and removed again,
 * and only properties that differ from that default are returned. Otherwise every element
 * reports the browser's own styling as if an author had written it.
 */
function buildStyleSampleExpression(
  maxElements: number,
  selector: string,
): string {
  return `(() => {
    const MAX_ELEMENTS = ${JSON.stringify(maxElements)};
    const SELECTOR = ${JSON.stringify(selector)};
    const PROPERTIES = ${JSON.stringify(STYLE_SAMPLE_PROPERTIES)};
    ${describeElementScript()}

    const defaultsByTag = new Map();
    function defaultsForTag(tag) {
      if (defaultsByTag.has(tag)) return defaultsByTag.get(tag);
      const probe = document.createElement(tag);
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      document.body.appendChild(probe);
      const probeStyle = getComputedStyle(probe);
      const snapshot = {};
      for (const property of PROPERTIES) snapshot[property] = probeStyle[property];
      document.body.removeChild(probe);
      defaultsByTag.set(tag, snapshot);
      return snapshot;
    }

    const results = [];
    let truncated = false;
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (results.length >= MAX_ELEMENTS) { truncated = true; break; }
      const style = getComputedStyle(el);
      const defaults = defaultsForTag(el.tagName.toLowerCase());
      const authored = { selector: describeElement(el) };
      for (const property of PROPERTIES) {
        if (style[property] !== defaults[property]) authored[property] = style[property];
      }
      if (Object.keys(authored).length > 1) results.push(authored);
    }
    return { results, truncated };
  })()`;
}

interface StyleSample {
  selector: string;
  color?: string;
  backgroundColor?: string;
  fontSize?: string;
  padding?: string;
  margin?: string;
  gap?: string;
  borderRadius?: string;
}

function checkSampleColor(
  sample: StyleSample,
  property: 'color' | 'backgroundColor',
  colorTokens: TokenEntry<ColorValue>[],
): RenderedFinding | undefined {
  const raw = sample[property];
  if (raw === undefined) return undefined;
  const parsed = parseColor(raw);
  if (!parsed) return undefined;
  if (parsed.alpha === 0) return undefined;
  const measurable = toMeasurableSrgb(parsed);
  if (!measurable) {
    return {
      selector: sample.selector,
      message: `computed ${property} ${raw} could not be checked against the token set: unsupported color space ${parsed.colorSpace}.`,
    };
  }
  if (colorMatchesAnyToken(measurable, colorTokens)) return undefined;
  return {
    selector: sample.selector,
    message: `computed ${property} ${raw} matches no token. This is a new value and needs a design decision before it joins the token set.`,
  };
}

function checkSampleDimensions(
  sample: StyleSample,
  property: 'fontSize' | 'padding' | 'margin' | 'gap' | 'borderRadius',
  scaleLabel: string,
  scalePx: number[],
): RenderedFinding[] {
  const raw = sample[property];
  if (raw === undefined || scalePx.length === 0) return [];
  const findings: RenderedFinding[] = [];
  for (const token of raw.split(/\s+/)) {
    const dimension = parseDimension(token);
    if (!dimension || dimension.unit !== 'px' || dimension.value === 0)
      continue;
    if (scalePx.includes(dimension.value)) continue;
    const nearest = findNearestPixels(dimension.value, scalePx);
    findings.push({
      selector: sample.selector,
      message: `computed ${property} ${token} is off the ${scaleLabel} scale (${scalePx.join('px, ')}px). Nearest is ${nearest}px.`,
    });
  }
  return findings;
}

/**
 * Flags computed color and spacing values that were authored anywhere, a utility class, an
 * inline `style`, or CSS-in-JS, and that a declaration scan over source files never sees.
 */
async function checkComputedValueDrift(
  session: RenderSession,
  tokens: Record<string, unknown>,
): Promise<RenderedFinding[]> {
  const evaluated = await session.evaluate<{
    results: StyleSample[];
    truncated: boolean;
  }>(
    buildStyleSampleExpression(
      MAX_STYLE_SAMPLE_ELEMENTS,
      STYLE_SAMPLE_SELECTOR,
    ),
  );
  if (!evaluated.ok) {
    return [
      {
        selector: '(page)',
        message: `could not read computed styles: ${evaluated.error}`,
      },
    ];
  }

  const colorTokens = collectTokenEntries(tokens, 'color', isColorValue);
  const spacingPx = dimensionScalePixels(
    collectTokenEntries(tokens, 'spacing', isDimensionValue),
  );
  const fontSizePx = dimensionScalePixels(
    collectTokenEntries(tokens, 'fontSize', isDimensionValue),
  );
  const radiusPx = dimensionScalePixels(
    collectTokenEntries(tokens, 'radius', isDimensionValue),
  );

  const findings: RenderedFinding[] = [];
  if (evaluated.value.truncated) {
    findings.push({
      selector: '(scan)',
      message: `stopped sampling computed styles after ${MAX_STYLE_SAMPLE_ELEMENTS} elements. The page has more, and they were not checked.`,
    });
  }
  for (const sample of evaluated.value.results) {
    const colorFinding = checkSampleColor(sample, 'color', colorTokens);
    if (colorFinding) findings.push(colorFinding);
    const backgroundFinding = checkSampleColor(
      sample,
      'backgroundColor',
      colorTokens,
    );
    if (backgroundFinding) findings.push(backgroundFinding);
    findings.push(
      ...checkSampleDimensions(sample, 'fontSize', 'font size', fontSizePx),
    );
    findings.push(
      ...checkSampleDimensions(sample, 'padding', 'spacing', spacingPx),
    );
    findings.push(
      ...checkSampleDimensions(sample, 'margin', 'spacing', spacingPx),
    );
    findings.push(
      ...checkSampleDimensions(sample, 'gap', 'spacing', spacingPx),
    );
    findings.push(
      ...checkSampleDimensions(sample, 'borderRadius', 'radius', radiusPx),
    );
  }
  return findings;
}

/**
 * Runs every rendered-page design check against a live session: composited text contrast,
 * rendered interactive hit-target size, and computed-value drift from the token set.
 *
 * @param tokens The parsed DTCG token document, the same shape `design-checks.mts` reads.
 */
export async function checkRenderedPage(
  session: RenderSession,
  tokens: Record<string, unknown>,
): Promise<RenderedCheckResult> {
  const findings = [
    ...(await checkCompositedContrast(session)),
    ...(await checkInteractiveHitTargets(session)),
    ...(await checkComputedValueDrift(session, tokens)),
  ];
  return { findings };
}
