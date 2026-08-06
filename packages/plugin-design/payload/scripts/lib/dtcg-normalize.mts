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
  const digits = match[1].length === 3 ? expandShortHex(match[1]) : match[1];
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
  const parts = splitArguments(match[1]).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN))
    return undefined;
  const color: DtcgColor = {
    colorSpace: 'srgb',
    components: parts.slice(0, 3).map((part) => round(part / CHANNEL_MAX)),
  };
  if (parts.length > 3 && !Number.isNaN(parts[3]))
    color.alpha = round(parts[3]);
  return color;
}

/**
 * Kept in the oklch color space rather than converted to sRGB. Tailwind v4's default palette is
 * authored in oklch, and DTCG carries the color space, so converting would lose gamut for no gain.
 */
function parseOklch(raw: string): DtcgColor | undefined {
  const match = OKLCH_PATTERN.exec(raw);
  if (!match) return undefined;
  const parts = splitArguments(match[1]).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN))
    return undefined;
  const color: DtcgColor = {
    colorSpace: 'oklch',
    components: parts.slice(0, 3).map(round),
  };
  if (parts.length > 3 && !Number.isNaN(parts[3]))
    color.alpha = round(parts[3]);
  return color;
}

/** A DTCG color `$value`, or undefined when the notation is one the spec cannot carry. */
export function parseColor(raw: string): DtcgColor | undefined {
  const trimmed = raw.trim();
  return parseHex(trimmed) ?? parseRgb(trimmed) ?? parseOklch(trimmed);
}

/** A DTCG dimension `$value`. Only `px` and `rem` are representable, so anything else is dropped. */
export function parseDimension(raw: string): DtcgDimension | undefined {
  const match = DIMENSION_PATTERN.exec(raw.trim());
  if (!match) return undefined;
  return { value: Number(match[1]), unit: match[2] };
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
