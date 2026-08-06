import { describe, expect, it } from 'vitest';

import { checkDesign } from '../../payload/scripts/lib/design-checks.mts';
import { parseColor } from '../../payload/scripts/lib/dtcg-normalize.mts';

function colorTokenSet(): Record<string, unknown> {
  return {
    color: {
      brand: {
        primary: { $value: parseColor('#2563eb') },
      },
    },
  };
}

function spacingTokenSet(): Record<string, unknown> {
  return {
    spacing: {
      xs: { $value: { value: 0.25, unit: 'rem' } },
      sm: { $value: { value: 0.5, unit: 'rem' } },
      md: { $value: { value: 1, unit: 'rem' } },
      lg: { $value: { value: 1.5, unit: 'rem' } },
    },
  };
}

function fontSizeTokenSet(): Record<string, unknown> {
  return {
    fontSize: {
      sm: { $value: { value: 0.875, unit: 'rem' } },
      md: { $value: { value: 1, unit: 'rem' } },
      lg: { $value: { value: 1.25, unit: 'rem' } },
    },
  };
}

function radiusTokenSet(): Record<string, unknown> {
  return {
    radius: {
      sm: { $value: { value: 0.25, unit: 'rem' } },
      md: { $value: { value: 0.5, unit: 'rem' } },
    },
  };
}

describe('checkDesign, untokenized colors', () => {
  it('names the token when a literal is exactly its value', () => {
    const css = `
.button {
  color: #2563eb;
}
`;

    const { findings } = checkDesign(css, colorTokenSet());

    expect(
      findings.some((finding) =>
        finding.message.includes('color.brand.primary'),
      ),
    ).toBe(true);
  });

  it('reports a new-value finding, distinct from a token swap, for a literal matching no token', () => {
    const css = `
.button {
  color: #2563eb;
}
.alert {
  color: #ff00ff;
}
`;

    const { findings } = checkDesign(css, colorTokenSet());
    const swap = findings.find((finding) =>
      finding.message.includes('#2563eb'),
    );
    const newValue = findings.find((finding) =>
      finding.message.includes('#ff00ff'),
    );

    expect(swap?.message).toContain('color.brand.primary');
    expect(newValue?.message).toContain('matches no token');
    expect(newValue?.message).not.toContain('color.brand.primary');
  });
});

describe('checkDesign, declared-pair contrast', () => {
  it('computes 1.99:1 for #adb5bd on #f9fafb', () => {
    const css = `
.summary-card__label {
  color: #adb5bd;
  background: #f9fafb;
}
`;

    const { findings } = checkDesign(css, {});

    expect(findings.some((finding) => finding.message.includes('1.99:1'))).toBe(
      true,
    );
  });

  it('computes 1.52:1 for #c9ced4 on #f9fafb', () => {
    const css = `
.summary-card__hint {
  color: #c9ced4;
  background: #f9fafb;
}
`;

    const { findings } = checkDesign(css, {});

    expect(findings.some((finding) => finding.message.includes('1.52:1'))).toBe(
      true,
    );
  });

  it('reports no finding for #ffffff on #2563eb at 5.17:1', () => {
    const css = `
.primary-button {
  color: #ffffff;
  background: #2563eb;
}
`;

    const { findings } = checkDesign(css, {});

    expect(
      findings.some((finding) => finding.message.includes('the 4.5:1 minimum')),
    ).toBe(false);
  });

  it('reports no finding for #6b7280 on white at 4.83:1', () => {
    const css = `
.muted-text {
  color: #6b7280;
  background: #ffffff;
}
`;

    const { findings } = checkDesign(css, {});

    expect(
      findings.some((finding) => finding.message.includes('the 4.5:1 minimum')),
    ).toBe(false);
  });
});

describe('checkDesign, off-scale dimensions', () => {
  it('reports the nearest spacing scale value for an off-scale value', () => {
    const css = `
.card {
  padding: 0.6875rem;
}
`;

    const { findings } = checkDesign(css, spacingTokenSet());
    const finding = findings.find((entry) =>
      entry.message.includes('0.6875rem'),
    );

    expect(finding?.message).toContain('Nearest is 0.5rem');
  });

  it('reports the nearest font-size scale value for an off-scale value', () => {
    const css = `
.text {
  font-size: 0.95rem;
}
`;

    const { findings } = checkDesign(css, fontSizeTokenSet());
    const finding = findings.find((entry) => entry.message.includes('0.95rem'));

    expect(finding?.message).toContain('Nearest is 1rem');
  });

  it('reports the nearest radius scale value for an off-scale value', () => {
    const css = `
.card {
  border-radius: 0.3rem;
}
`;

    const { findings } = checkDesign(css, radiusTokenSet());
    const finding = findings.find((entry) => entry.message.includes('0.3rem'));

    expect(finding?.message).toContain('Nearest is 0.25rem');
  });

  it('reports nothing for a value already on the scale', () => {
    const css = `
.card {
  padding: 1rem;
}
`;

    const { findings } = checkDesign(css, spacingTokenSet());

    expect(findings).toEqual([]);
  });
});

describe('checkDesign, hit targets', () => {
  it('reports an interactive element under the 24 by 24 minimum', () => {
    const css = `
.button-small {
  width: 18px;
  height: 18px;
}
`;

    const { findings } = checkDesign(css, {});

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('18 by 18');
    expect(findings[0].message).toContain('under the 24 by 24 minimum');
  });

  it('reports nothing for an interactive element at the 24 by 24 minimum', () => {
    const css = `
.button-ok {
  width: 24px;
  height: 24px;
}
`;

    const { findings } = checkDesign(css, {});

    expect(findings).toEqual([]);
  });
});

describe('checkDesign, compact single-line CSS', () => {
  it('produces the same findings as the equivalent expanded CSS', () => {
    const compact = `.card { padding: 24px; background: #ffffff; border-radius: 8px; }\n.label { color: #adb5bd; font-size: 13px; }`;
    const expanded = `
.card {
  padding: 24px;
  background: #ffffff;
  border-radius: 8px;
}
.label {
  color: #adb5bd;
  font-size: 13px;
}
`;

    const compactResult = checkDesign(compact, {});
    const expandedResult = checkDesign(expanded, {});

    expect(compactResult.findings.map((finding) => finding.message)).toEqual(
      expandedResult.findings.map((finding) => finding.message),
    );
    expect(compactResult.findings.length).toBeGreaterThan(0);
  });

  it('reports accurate line numbers for declarations packed onto one line', () => {
    const css = `.card {\n  color: #ff00ff;\n}\n.label { color: #ff00ff; font-size: 13px; }`;

    const { findings } = checkDesign(css, {});
    const label = findings.filter((finding) => finding.line === 4);

    expect(label.length).toBeGreaterThan(0);
  });
});

describe('checkDesign, px declarations against a rem scale', () => {
  it('flags a px font-size that is off a rem type scale', () => {
    const css = `
.label {
  font-size: 13px;
}
`;

    const { findings } = checkDesign(css, fontSizeTokenSet());
    const finding = findings.find((entry) => entry.message.includes('13px'));

    expect(finding?.message).toContain('off the font size scale');
  });

  it('does not flag a px padding that equals a rem spacing scale value', () => {
    const css = `
.card {
  padding: 24px;
}
`;

    const { findings } = checkDesign(css, spacingTokenSet());

    expect(findings).toEqual([]);
  });
});

describe('checkDesign, var()-only stylesheets', () => {
  it('reports nothing when every value is a var() reference', () => {
    const css = `
.control {
  color: var(--color-text);
  padding: var(--spacing-md);
  width: var(--size-control);
  height: var(--size-control);
}
`;

    const { findings } = checkDesign(css, {});

    expect(findings).toEqual([]);
  });
});
