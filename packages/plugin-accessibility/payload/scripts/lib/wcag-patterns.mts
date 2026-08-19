/** One markup pattern and the criteria a change touching it is subject to. */
export interface MarkupPattern {
  /** Stable kebab-case handle, used in output and in tests. */
  id: string;
  /** What the pattern looks for, phrased as the thing in the markup, not the regex. */
  label: string;
  /** Success criterion numbers, in ascending order, as they appear in wcag22.md. */
  criteria: string[];
  /**
   * Matched against the file's raw source. Must carry the `g` flag so the matcher can count
   * occurrences, and must be stateless between calls, which the matcher guarantees by
   * resetting `lastIndex`.
   */
  test: RegExp;
}

/** One pattern that fired, with how many times it matched. */
export interface PatternHit {
  pattern: MarkupPattern;
  count: number;
}

/**
 * The markup-pattern to success-criterion map, matched by {@link matchPatterns}.
 *
 * This table ROUTES, it does not lint. A pattern's job is to say "this change is subject to
 * 1.1.1, go read it", never to judge whether the markup satisfies it. Deciding whether an
 * `alt` text is any good is `eslint-plugin-jsx-a11y`'s job and it is better at it. Keeping the
 * table on the routing side of that line is what stops this from becoming a worse copy of a
 * tool that already exists.
 *
 * Over-inclusion is the cheap failure. Naming a criterion that turns out not to apply costs one
 * read. Missing one costs a defect. Prefer a loose pattern.
 */
export const MARKUP_PATTERNS: MarkupPattern[] = [
  {
    id: 'image-icon-or-svg',
    label: 'an image, icon, or svg element',
    criteria: ['1.1.1'],
    test: /<img\b|<Image\b|<svg\b/g,
  },
  {
    id: 'video-audio-or-track',
    label: 'a video, audio, or track element',
    criteria: ['1.2.1', '1.2.2', '1.2.3', '1.2.5'],
    test: /<video\b|<audio\b|<track\b/g,
  },
  {
    id: 'heading-element',
    label: 'a heading element',
    criteria: ['1.3.1', '2.4.6', '2.4.10'],
    test: /<h[1-6]\b/g,
  },
  {
    id: 'table-structure',
    label: 'a table, header cell, or caption element',
    criteria: ['1.3.1', '2.4.6'],
    test: /<table\b|<th\b|<caption\b/g,
  },
  {
    id: 'form-control-or-label',
    label: 'a form control, label, or form element',
    criteria: ['1.3.1', '3.3.2', '4.1.2'],
    test: /<input\b|<select\b|<textarea\b|<label\b|<form\b/g,
  },
  {
    id: 'role-or-aria-attribute',
    label: 'a role or aria-* attribute',
    criteria: ['1.3.1', '4.1.2'],
    test: /\brole\s*=|\baria-[a-z]+\s*=/g,
  },
  {
    id: 'placeholder-as-label',
    label: 'a placeholder attribute standing in for a label',
    criteria: ['1.3.1', '3.3.2'],
    test: /\bplaceholder\s*=/g,
  },
  {
    id: 'inline-color-declaration',
    label: 'an inline color declaration',
    criteria: ['1.4.1', '1.4.3', '1.4.11'],
    test: /\bcolor\s*:|background-color\s*:/g,
  },
  {
    id: 'autoplay-attribute',
    label: 'an autoplay attribute',
    criteria: ['1.4.2'],
    test: /\bautoplay\b/g,
  },
  {
    id: 'click-or-key-handler-on-non-interactive-element',
    label: 'a click or key handler on a non-interactive element',
    criteria: ['2.1.1', '2.5.3', '4.1.2'],
    test: /<(?:div|span)\b[^>]*(?:onClick|onKeyDown|onKeyUp|@click|on:click|v-on:click)/g,
  },
  {
    id: 'interactive-anchor-or-button',
    label: 'a button or anchor element',
    criteria: ['2.1.1', '2.5.3', '4.1.2'],
    test: /<button\b|<a\b/g,
  },
  {
    id: 'tabindex-attribute',
    label: 'a tabindex attribute',
    criteria: ['2.1.1', '2.4.3'],
    test: /\btabindex\s*=|\btabIndex\s*=/g,
  },
  {
    id: 'dialog-modal-or-popover',
    label: 'a dialog, modal, or popover pattern',
    criteria: ['2.1.2', '2.4.3', '4.1.2'],
    test: /<dialog\b|role\s*=\s*["']dialog["']|\bpopover\b/g,
  },
  {
    id: 'accesskey-attribute',
    label: 'an accesskey attribute',
    criteria: ['2.1.4'],
    test: /\baccesskey\s*=|\baccessKey\s*=/g,
  },
  {
    id: 'timer-driven-ui-update',
    label: 'a setTimeout or setInterval driving a UI change',
    criteria: ['2.2.1', '2.2.2'],
    test: /\bsetTimeout\s*\(|\bsetInterval\s*\(/g,
  },
  {
    id: 'css-transition-or-animation',
    label: 'a CSS transition, animation, or keyframes block',
    criteria: ['2.2.2', '2.3.3'],
    test: /\btransition\s*:|\banimation\s*:|@keyframes\b/g,
  },
  {
    id: 'marquee-or-blink',
    label: 'a marquee or blink element',
    criteria: ['2.2.2', '2.3.1'],
    test: /<marquee\b|<blink\b/g,
  },
  {
    id: 'iframe-element',
    label: 'an iframe element',
    criteria: ['2.4.1', '4.1.2'],
    test: /<iframe\b/g,
  },
  {
    id: 'autofocus-attribute',
    label: 'an autofocus attribute',
    criteria: ['2.4.3', '3.2.1'],
    test: /\bautofocus\b/g,
  },
  {
    id: 'suppressed-focus-indicator',
    label: 'an outline suppressed on a focusable element',
    criteria: ['2.4.7', '2.4.11', '2.4.13'],
    // The quote is optional because a JSX style object writes `outline: 'none'` where a
    // stylesheet writes `outline: none`, and both are the thing this routes on.
    test: /outline(?:-width|Width)?\s*:\s*['"]?(?:none|0)\b/g,
  },
  {
    id: 'drag-handler',
    label: 'a drag handler or draggable attribute',
    criteria: ['2.5.1', '2.5.7'],
    test: /\bonDragStart\b|\bdraggable\s*=|\bon:dragstart\b|\b@dragstart\b/g,
  },
  {
    id: 'title-attribute-as-label',
    label: 'a title attribute used as a label',
    criteria: ['2.5.3', '4.1.2'],
    test: /\btitle\s*=/g,
  },
  {
    id: 'document-lang-attribute',
    label: 'a lang attribute on the document root',
    criteria: ['3.1.1'],
    test: /<html\b[^>]*\blang\s*=/g,
  },
];

/**
 * Every pattern that fires against `source`, in table order.
 *
 * Resets each regex's `lastIndex` before use, because a `g`-flagged regex reused across files
 * otherwise resumes mid-string and silently misses matches in the second file onward.
 */
export function matchPatterns(source: string): PatternHit[] {
  const hits: PatternHit[] = [];
  for (const pattern of MARKUP_PATTERNS) {
    pattern.test.lastIndex = 0;
    const count = (source.match(pattern.test) ?? []).length;
    if (count > 0) hits.push({ pattern, count });
  }
  return hits;
}

/** The union of every criterion the hits imply, deduplicated and in ascending WCAG order. */
export function criteriaFor(hits: PatternHit[]): string[] {
  const seen = new Set<string>();
  for (const hit of hits) for (const sc of hit.pattern.criteria) seen.add(sc);
  return [...seen].sort((a, b) => {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
      if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
    }
    return 0;
  });
}
