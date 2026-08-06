/**
 * The starting design system the kit seeds, in W3C Design Tokens Format Module 2025.10.
 *
 * Deliberately brand-neutral and small. This is a placeholder the user replaces, the same way
 * the `dataviz` skill ships a neutral palette to be swapped, so the values here are chosen to
 * be obviously generic rather than to look finished. A seed that looks finished never gets
 * edited, and an unedited seed means every design check measures against values nobody chose.
 *
 * Two spec details worth not relearning. A color `$value` is a structured object with a
 * `colorSpace` and `components` in the 0 to 1 range, not a hex string. A dimension `$value` is
 * a `{ value, unit }` pair, not a CSS string. `design.mjs` renders hex for humans by converting
 * components on the way out, which keeps this file spec-pure.
 */

/** An sRGB color's components, in the 0 to 1 range the spec requires. */
function srgb(red: number, green: number, blue: number) {
  return { colorSpace: 'srgb', components: [red, green, blue] };
}

/** A dimension in `rem`, the unit every scale in this seed uses. */
function rem(value: number) {
  return { value, unit: 'rem' };
}

const SEED_TOKENS = {
  color: {
    $type: 'color',
    $description:
      'Replace every value here. These are placeholders, not a palette.',
    brand: {
      primary: { $value: srgb(0.231, 0.357, 0.859) },
      accent: { $value: srgb(0.404, 0.784, 0.647) },
    },
    text: {
      primary: { $value: srgb(0.086, 0.094, 0.114) },
      muted: { $value: srgb(0.361, 0.388, 0.431) },
      onBrand: { $value: srgb(1, 1, 1) },
    },
    surface: {
      base: { $value: srgb(1, 1, 1) },
      raised: { $value: srgb(0.965, 0.969, 0.976) },
    },
    border: {
      subtle: { $value: srgb(0.875, 0.89, 0.91) },
    },
  },

  spacing: {
    $type: 'dimension',
    $description:
      'The spacing scale. A margin, padding, or gap that is not on this scale is a finding.',
    xs: { $value: rem(0.25) },
    sm: { $value: rem(0.5) },
    md: { $value: rem(1) },
    lg: { $value: rem(1.5) },
    xl: { $value: rem(2) },
    '2xl': { $value: rem(3) },
  },

  fontFamily: {
    $type: 'fontFamily',
    sans: { $value: ['Inter', 'system-ui', 'sans-serif'] },
    mono: { $value: ['ui-monospace', 'monospace'] },
  },

  fontSize: {
    $type: 'dimension',
    $description: 'The type scale. A font-size off this scale is a finding.',
    sm: { $value: rem(0.875) },
    md: { $value: rem(1) },
    lg: { $value: rem(1.125) },
    xl: { $value: rem(1.5) },
    '2xl': { $value: rem(2) },
  },

  fontWeight: {
    $type: 'fontWeight',
    regular: { $value: 400 },
    medium: { $value: 500 },
    bold: { $value: 700 },
  },

  radius: {
    $type: 'dimension',
    sm: { $value: rem(0.25) },
    md: { $value: rem(0.5) },
    lg: { $value: rem(1) },
  },

  shadow: {
    $type: 'shadow',
    sm: {
      $value: {
        color: { colorSpace: 'srgb', components: [0, 0, 0], alpha: 0.08 },
        offsetX: rem(0),
        offsetY: rem(0.0625),
        blur: rem(0.125),
        spread: rem(0),
      },
    },
    md: {
      $value: {
        color: { colorSpace: 'srgb', components: [0, 0, 0], alpha: 0.12 },
        offsetX: rem(0),
        offsetY: rem(0.25),
        blur: rem(0.75),
        spread: rem(0),
      },
    },
  },
} as const;

/**
 * The seed's serialized form. This exact string is what `init` writes and what
 * {@link isUntouchedSeed} compares against, so the two can never drift.
 */
export function renderTokenSeed(): string {
  return `${JSON.stringify(SEED_TOKENS, null, 2)}\n`;
}

/**
 * Whether a token file is still byte-identical to what the kit seeded. Trailing whitespace is
 * normalized so that a formatter run does not read as a real edit.
 */
export function isUntouchedSeed(contents: string): boolean {
  return contents.trimEnd() === renderTokenSeed().trimEnd();
}
