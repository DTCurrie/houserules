import {
  parseColor,
  parseDimension,
  parseFontFamily,
  parseFontWeight,
} from './dtcg-normalize.mjs';
import type { TokenGroup } from './dtcg-normalize.mjs';
import { isRepoDefinedThemeKey } from './tailwind-design-system.mjs';
import type { TailwindTheme } from './tailwind-design-system.mjs';

type ThemeOrigin = 'repo' | 'tailwind';

interface ThemeEntry {
  key: string;
  raw: string;
  name: string;
  group?: TokenGroup;
}

interface CollectedTheme {
  entries: ThemeEntry[];
  multiplier?: { key: string; raw: string };
}

/**
 * Namespace-to-group mapping, in the order namespaces must be claimed. `--font-weight` has to be
 * matched before `--font`, since a Tailwind theme's `--font-weight-*` keys otherwise get
 * re-matched as `--font-*` suffixes and land in fontFamily.
 */
const GROUPED_NAMESPACES: Array<{ prefix: string; group: TokenGroup }> = [
  { prefix: '--color', group: 'color' },
  { prefix: '--font-weight', group: 'fontWeight' },
  { prefix: '--font', group: 'fontFamily' },
  { prefix: '--text', group: 'fontSize' },
  { prefix: '--radius', group: 'radius' },
  { prefix: '--spacing', group: 'spacing' },
];

/**
 * Namespaces Tailwind's theme carries that no DTCG type can represent. `--shadow` does have a
 * DTCG shadow type, but Tailwind writes its value as a raw CSS string that `parseColor` and its
 * siblings cannot carry, so it is dropped here rather than emitted in a shape no DTCG tool
 * accepts.
 */
const UNSUPPORTED_NAMESPACES = [
  '--ease',
  '--animate',
  '--breakpoint',
  '--container',
  '--shadow',
  '--leading',
];

const PARSER_BY_GROUP: Record<TokenGroup, (raw: string) => unknown> = {
  color: parseColor,
  spacing: parseDimension,
  fontSize: parseDimension,
  radius: parseDimension,
  fontFamily: parseFontFamily,
  fontWeight: parseFontWeight,
};

const TYPE_BY_GROUP: Record<TokenGroup, string> = {
  color: 'color',
  spacing: 'dimension',
  fontSize: 'dimension',
  radius: 'dimension',
  fontFamily: 'fontFamily',
  fontWeight: 'fontWeight',
};

/**
 * The named steps Tailwind's own docs list for the default spacing scale, projected here as
 * `<step> * <the repo's --spacing multiplier>`. Tailwind's utilities also accept an arbitrary
 * multiplier such as `p-42`, but that set is unbounded, so this finite list is the one a DTCG
 * document can usefully name.
 */
const SPACING_SCALE_STEPS = [
  0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24,
  28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96,
];

const DECIMAL_PRECISION = 1000;

function round(value: number): number {
  return Math.round(value * DECIMAL_PRECISION) / DECIMAL_PRECISION;
}

function fullKey(prefix: string, suffix: string | null): string {
  return suffix === null ? prefix : `${prefix}-${suffix}`;
}

function collectThemeEntries(theme: TailwindTheme): CollectedTheme {
  const claimed = new Set<string>();
  const entries: ThemeEntry[] = [];
  let multiplier: { key: string; raw: string } | undefined;

  for (const { prefix, group } of GROUPED_NAMESPACES) {
    for (const [suffix, raw] of theme.namespace(prefix)) {
      const key = fullKey(prefix, suffix);
      if (claimed.has(key)) continue;
      claimed.add(key);

      if (prefix === '--spacing' && suffix === null) {
        multiplier = { key, raw };
        continue;
      }

      entries.push({ key, raw, name: suffix ?? 'DEFAULT', group });
    }
  }

  for (const prefix of UNSUPPORTED_NAMESPACES) {
    for (const [suffix, raw] of theme.namespace(prefix)) {
      const key = fullKey(prefix, suffix);
      if (claimed.has(key)) continue;
      claimed.add(key);
      entries.push({ key, raw, name: suffix ?? 'DEFAULT' });
    }
  }

  return { entries, multiplier };
}

function originOf(theme: TailwindTheme, key: string): ThemeOrigin {
  return isRepoDefinedThemeKey(theme, key) ? 'repo' : 'tailwind';
}

function describeToken(
  origin: ThemeOrigin,
  derivedFromMultiplier: boolean,
): string {
  const source =
    origin === 'repo' ? "the repo's @theme block" : "Tailwind's default theme";
  return derivedFromMultiplier
    ? `derived from the --spacing multiplier in ${source}`
    : `declared in ${source}`;
}

function tokenNode(
  value: unknown,
  origin: ThemeOrigin,
  derivedFromMultiplier: boolean,
): Record<string, unknown> {
  return {
    $value: value,
    $description: describeToken(origin, derivedFromMultiplier),
    $extensions: { 'agent-kit': { origin } },
  };
}

/**
 * Projects a resolved Tailwind theme into the same DTCG document shape `normalizeToDtcg`
 * produces, tagging every token with whether the repo's own `@theme` block declared it or
 * Tailwind's default palette did. Unlike `normalizeToDtcg`, this never reorders entries by
 * occurrence and never stamps a generic "extracted from" description, because a theme's own
 * declaration order and its provenance are exactly the information this projection exists to
 * carry forward.
 *
 * @returns The document, the raw values that had no representable DTCG type, and a repo-versus-
 * Tailwind count over every entry considered.
 */
export function projectThemeToDtcg(theme: TailwindTheme): {
  document: Record<string, unknown>;
  dropped: string[];
  counts: { repo: number; tailwind: number };
} {
  const { entries, multiplier } = collectThemeEntries(theme);
  const dropped: string[] = [];
  const nodes = new Map<TokenGroup, Record<string, unknown>>();
  let repo = 0;
  let tailwind = 0;

  for (const entry of entries) {
    const origin = originOf(theme, entry.key);
    if (origin === 'repo') repo += 1;
    else tailwind += 1;

    if (entry.group === undefined) {
      dropped.push(entry.raw);
      continue;
    }

    const value = PARSER_BY_GROUP[entry.group](entry.raw);
    if (value === undefined) {
      dropped.push(entry.raw);
      continue;
    }

    const node = nodes.get(entry.group) ?? {
      $type: TYPE_BY_GROUP[entry.group],
    };
    node[entry.name] = tokenNode(value, origin, false);
    nodes.set(entry.group, node);
  }

  if (multiplier) {
    const origin = originOf(theme, multiplier.key);
    if (origin === 'repo') repo += 1;
    else tailwind += 1;

    const dimension = parseDimension(multiplier.raw);
    if (dimension === undefined) {
      dropped.push(multiplier.raw);
    } else {
      const explicitNames = new Set(
        entries
          .filter((entry) => entry.group === 'spacing')
          .map((entry) => entry.name),
      );
      const node = nodes.get('spacing') ?? { $type: TYPE_BY_GROUP.spacing };
      for (const step of SPACING_SCALE_STEPS) {
        const name = String(step);
        if (explicitNames.has(name)) continue;
        node[name] = tokenNode(
          { value: round(step * dimension.value), unit: dimension.unit },
          origin,
          true,
        );
      }
      nodes.set('spacing', node);
    }
  }

  const document: Record<string, unknown> = {};
  for (const [group, node] of nodes) {
    if (Object.keys(node).length > 1) document[group] = node;
  }

  return { document, dropped, counts: { repo, tailwind } };
}
