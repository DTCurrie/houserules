/**
 * The contract every token reader targets, and the conversion from raw CSS values into W3C
 * DTCG shapes.
 *
 * This module owns {@link TokenCandidate} because it is the consumer that defines what a valid
 * candidate is. A reader's only job is to find values and label them. Deciding whether
 * `#3b5bdb` is a color the spec can represent, and what its `$value` looks like, happens here
 * once rather than in each reader.
 */

/** The token groups extraction produces. Mirrors the groups in the seeded token file. */
export type TokenGroup =
  'color' | 'spacing' | 'fontFamily' | 'fontSize' | 'fontWeight' | 'radius';

/** One raw value a reader found, before it is known to be representable in DTCG. */
export interface TokenCandidate {
  group: TokenGroup;
  /** Leaf name within the group. Readers pass through the author's own name where one exists. */
  name: string;
  /** The value exactly as written in the source, such as `#3b5bdb`, `1rem`, or `oklch(0.7 0.1 250)`. */
  raw: string;
  /** How many times this value appeared. Drives ranking, so a one-off never outranks a brand color. */
  occurrences: number;
  /** Which reader found it. Becomes the token's `$description` so a reviewer knows what to trust. */
  source: string;
}

const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_PATTERN = /^rgba?\(([^)]+)\)$/i;
const OKLCH_PATTERN = /^oklch\(([^)]+)\)$/i;
const DIMENSION_PATTERN = /^(-?[0-9]*\.?[0-9]+)(px|rem)$/;
const CHANNEL_MAX = 255;
const ROUNDING = 1000;

interface DtcgColor {
  colorSpace: string;
  components: number[];
  alpha?: number;
}

interface DtcgDimension {
  value: number;
  unit: string;
}

function round(value: number): number {
  return Math.round(value * ROUNDING) / ROUNDING;
}

function expandShortHex(digits: string): string {
  return digits
    .split('')
    .map((digit) => digit + digit)
    .join('');
}

function parseHex(raw: string): DtcgColor | undefined {
  const match = HEX_PATTERN.exec(raw);
  if (!match) return undefined;
  const captured = match[1];
  if (captured === undefined) return undefined;
  const digits = captured.length === 3 ? expandShortHex(captured) : captured;
  const channels: number[] = [];
  for (let index = 0; index < 6; index += 2) {
    channels.push(
      round(parseInt(digits.slice(index, index + 2), 16) / CHANNEL_MAX),
    );
  }
  const color: DtcgColor = { colorSpace: 'srgb', components: channels };
  if (digits.length === 8) {
    color.alpha = round(parseInt(digits.slice(6, 8), 16) / CHANNEL_MAX);
  }
  return color;
}

/** Splits an sRGB or oklch argument list on commas or whitespace, dropping a trailing alpha slash. */
function splitArguments(body: string): string[] {
  return body
    .replace('/', ' ')
    .split(/[\s,]+/)
    .filter((part) => part.length > 0);
}

function parseRgb(raw: string): DtcgColor | undefined {
  const match = RGB_PATTERN.exec(raw);
  if (!match) return undefined;
  const body = match[1];
  if (body === undefined) return undefined;
  const parts = splitArguments(body).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN))
    return undefined;
  const color: DtcgColor = {
    colorSpace: 'srgb',
    components: parts.slice(0, 3).map((part) => round(part / CHANNEL_MAX)),
  };
  const alphaPart = parts[3];
  if (alphaPart !== undefined && !Number.isNaN(alphaPart))
    color.alpha = round(alphaPart);
  return color;
}

/** oklch()'s chroma reference range: a chroma of 100% is 0.4 per CSS Color 4. */
const OKLCH_CHROMA_REFERENCE = 0.4;
const PERCENTAGE_PATTERN = /^(-?[0-9]*\.?[0-9]+)%$/;

/**
 * Parses one of oklch()'s three positional components. Lightness's `100%` is `1`. Chroma's
 * `100%` is {@link OKLCH_CHROMA_REFERENCE}. Hue is an angle and has no percentage form, so a
 * percentage there is invalid notation and parses to `NaN`.
 */
function parseOklchComponent(part: string, index: number): number {
  const percentageMatch = PERCENTAGE_PATTERN.exec(part);
  if (!percentageMatch) return Number(part);
  const digits = percentageMatch[1];
  if (digits === undefined) return NaN;
  const percentage = Number(digits);
  if (index === 0) return percentage / 100;
  if (index === 1) return (percentage / 100) * OKLCH_CHROMA_REFERENCE;
  return NaN;
}

/** Parses oklch()'s alpha argument, where `50%` means `0.5`, same as every other CSS alpha. */
function parseAlphaComponent(part: string): number {
  const percentageMatch = PERCENTAGE_PATTERN.exec(part);
  const digits = percentageMatch?.[1];
  return digits !== undefined ? Number(digits) / 100 : Number(part);
}

/**
 * Kept in the oklch color space rather than converted to sRGB. Tailwind v4's default palette is
 * authored in oklch, and DTCG carries the color space, so converting would lose gamut for no gain.
 */
function parseOklch(raw: string): DtcgColor | undefined {
  const match = OKLCH_PATTERN.exec(raw);
  if (!match) return undefined;
  const body = match[1];
  if (body === undefined) return undefined;
  const parts = splitArguments(body);
  if (parts.length < 3) return undefined;
  const components = parts
    .slice(0, 3)
    .map((part, index) => parseOklchComponent(part, index));
  if (components.some(Number.isNaN)) return undefined;
  const color: DtcgColor = {
    colorSpace: 'oklch',
    components: components.map(round),
  };
  const alphaPart = parts[3];
  if (alphaPart !== undefined) {
    const alpha = parseAlphaComponent(alphaPart);
    if (!Number.isNaN(alpha)) color.alpha = round(alpha);
  }
  return color;
}

/** A DTCG color `$value`, or undefined when the notation is one the spec cannot carry. */
export function parseColor(raw: string): DtcgColor | undefined {
  const trimmed = raw.trim();
  return parseHex(trimmed) ?? parseRgb(trimmed) ?? parseOklch(trimmed);
}

const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Oklab to LMS' cube-root coefficients, from Björn Ottosson's oklab derivation (CSS Color 4
 * §10.2). Each row is `[L, a, b]`.
 */
const OKLAB_TO_LMS_PRIME = {
  l: [1, 0.3963377774, 0.2158037573],
  m: [1, -0.1055613458, -0.0638541728],
  s: [1, -0.0894841775, -1.291485548],
} as const;

/** LMS to linear sRGB coefficients, the other half of the same round trip. Rows are `[l, m, s]`. */
const LMS_TO_LINEAR_SRGB = {
  r: [4.0767416621, -3.3077115913, 0.2309699292],
  g: [-1.2684380046, 2.6097574011, -0.3413193965],
  b: [-0.0041960863, -0.7034186147, 1.707614701],
} as const;

/** sRGB gamma-encode transfer function constants (the inverse of the WCAG decode formula). */
const SRGB_ENCODE_LINEAR_THRESHOLD = 0.0031308;
const SRGB_ENCODE_LINEAR_SCALE = 12.92;
const SRGB_ENCODE_GAMMA_SCALE = 1.055;
const SRGB_ENCODE_GAMMA_OFFSET = 0.055;
const SRGB_ENCODE_GAMMA_EXPONENT = 1 / 2.4;

function dotProduct(coefficients: readonly number[], values: number[]): number {
  return coefficients.reduce((sum, coefficient, index) => {
    const value = values[index];
    return value === undefined ? sum : sum + coefficient * value;
  }, 0);
}

// An out-of-gamut oklch color converts to a linear channel outside [0, 1], including
// negative values a fractional gamma exponent cannot accept. Clamping here is what keeps
// the contrast ratio real rather than NaN.
function encodeSrgbChannel(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  return clamped <= SRGB_ENCODE_LINEAR_THRESHOLD
    ? clamped * SRGB_ENCODE_LINEAR_SCALE
    : SRGB_ENCODE_GAMMA_SCALE * clamped ** SRGB_ENCODE_GAMMA_EXPONENT -
        SRGB_ENCODE_GAMMA_OFFSET;
}

/** Converts oklch's `lightness, chroma, hue`, already decimal per {@link parseOklchComponent}, to gamma-encoded sRGB. */
function convertOklchToSrgb(
  lightness: number,
  chroma: number,
  hueDegrees: number,
): number[] {
  const hueRadians = hueDegrees * DEGREES_TO_RADIANS;
  const oklab = [
    lightness,
    chroma * Math.cos(hueRadians),
    chroma * Math.sin(hueRadians),
  ];

  const lmsPrime = [
    dotProduct(OKLAB_TO_LMS_PRIME.l, oklab),
    dotProduct(OKLAB_TO_LMS_PRIME.m, oklab),
    dotProduct(OKLAB_TO_LMS_PRIME.s, oklab),
  ];
  const lms = lmsPrime.map((component) => component ** 3);

  return [
    encodeSrgbChannel(dotProduct(LMS_TO_LINEAR_SRGB.r, lms)),
    encodeSrgbChannel(dotProduct(LMS_TO_LINEAR_SRGB.g, lms)),
    encodeSrgbChannel(dotProduct(LMS_TO_LINEAR_SRGB.b, lms)),
  ];
}

/** The shape a color needs to be measured for contrast: a color space name and its components. */
export interface MeasurableColor {
  colorSpace: string;
  components: number[];
}

/**
 * Converts a color to gamma-encoded sRGB for a contrast measurement, without touching how the
 * color is stored. A token keeps the color space it was authored in, since `design.mjs token`
 * and `list` print what the repo actually wrote, so this conversion belongs only at the point a
 * check measures luminance.
 *
 * @returns The color unchanged when it is already sRGB, its sRGB conversion when it is oklch,
 *   or undefined for a color space this function has no conversion for, so the caller can
 *   report an explicit skip rather than treating an unknown space as sRGB.
 */
export function toMeasurableSrgb(
  color: MeasurableColor,
): MeasurableColor | undefined {
  if (color.colorSpace === 'srgb') return color;
  if (color.colorSpace === 'oklch') {
    const [lightness, chroma, hueDegrees] = color.components;
    if (
      lightness === undefined ||
      chroma === undefined ||
      hueDegrees === undefined
    )
      return undefined;
    return {
      colorSpace: 'srgb',
      components: convertOklchToSrgb(lightness, chroma, hueDegrees),
    };
  }
  return undefined;
}

/** A DTCG dimension `$value`. Only `px` and `rem` are representable, so anything else is dropped. */
export function parseDimension(raw: string): DtcgDimension | undefined {
  const match = DIMENSION_PATTERN.exec(raw.trim());
  if (!match) return undefined;
  const value = match[1];
  const unit = match[2];
  if (value === undefined || unit === undefined) return undefined;
  return { value: Number(value), unit };
}

/** A DTCG fontFamily `$value`: the stack split on commas with quotes stripped. */
export function parseFontFamily(raw: string): string[] | undefined {
  const families = raw
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter((part) => part.length > 0);
  return families.length > 0 ? families : undefined;
}

/** A DTCG fontWeight `$value`. Numeric weights only, since named weights vary by source. */
export function parseFontWeight(raw: string): number | undefined {
  const weight = Number(raw.trim());
  return Number.isInteger(weight) && weight >= 1 && weight <= 1000
    ? weight
    : undefined;
}

const PARSERS_BY_GROUP: Record<
  TokenGroup,
  (raw: string) => unknown | undefined
> = {
  color: parseColor,
  spacing: parseDimension,
  fontSize: parseDimension,
  radius: parseDimension,
  fontFamily: parseFontFamily,
  fontWeight: parseFontWeight,
};

/** The `$type` each group declares on its group node. */
const TYPE_BY_GROUP: Record<TokenGroup, string> = {
  color: 'color',
  spacing: 'dimension',
  fontSize: 'dimension',
  radius: 'dimension',
  fontFamily: 'fontFamily',
  fontWeight: 'fontWeight',
};

/** Dimension groups sort by magnitude. Everything else sorts by how often the value appeared. */
function sortCandidates(
  group: TokenGroup,
  entries: TokenCandidate[],
): TokenCandidate[] {
  if (TYPE_BY_GROUP[group] !== 'dimension') {
    return [...entries].sort(
      (left, right) => right.occurrences - left.occurrences,
    );
  }
  return [...entries].sort(
    (left, right) =>
      (parseDimension(left.raw)?.value ?? 0) -
      (parseDimension(right.raw)?.value ?? 0),
  );
}

/**
 * Folds candidates into a DTCG document. Candidates whose `raw` value the spec cannot represent
 * are dropped rather than emitted in a shape no DTCG tool would accept.
 *
 * @returns The document, and the raw values that were dropped so the caller can report them.
 */
export function normalizeToDtcg(candidates: TokenCandidate[]): {
  document: Record<string, unknown>;
  dropped: string[];
} {
  const document: Record<string, unknown> = {};
  const dropped: string[] = [];
  const byGroup = new Map<TokenGroup, TokenCandidate[]>();

  for (const candidate of candidates) {
    const existing = byGroup.get(candidate.group) ?? [];
    existing.push(candidate);
    byGroup.set(candidate.group, existing);
  }

  for (const [group, entries] of byGroup) {
    const node: Record<string, unknown> = { $type: TYPE_BY_GROUP[group] };
    let emitted = 0;
    for (const candidate of sortCandidates(group, entries)) {
      const value = PARSERS_BY_GROUP[group](candidate.raw);
      if (value === undefined) {
        dropped.push(candidate.raw);
        continue;
      }
      node[candidate.name] = {
        $value: value,
        $description: `extracted from ${candidate.source}`,
      };
      emitted += 1;
    }
    if (emitted > 0) document[group] = node;
  }

  return { document, dropped };
}
