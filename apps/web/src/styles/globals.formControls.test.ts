import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'globals.css'), 'utf8');

/**
 * Two app-wide visual defects fixed in globals.css rather than in ~170 call
 * sites; these guard the rules from being lost in a stylesheet rewrite.
 */
describe('globals.css form controls and sticky headers', () => {
  // The forms plugin pads every <select> 0.5rem top and bottom, so an
  // h-8 select had 14px for a 20px line and clipped its text.
  it('zeroes block padding on fixed-height selects', () => {
    const rule = css.match(/select:where\([^)]*\.h-8[^)]*\)\s*\{[^}]*\}/);
    expect(rule, 'expected a fixed-height select rule').not.toBeNull();
    expect(rule![0]).toMatch(/padding-block:\s*0/);
  });

  // bg-muted/40 is translucent, so rows scrolled under a sticky header showed
  // through it (Software tab and other device-detail tables).
  it('makes translucent sticky table headers opaque and stacked above rows', () => {
    expect(css).toMatch(/thead\.sticky\s*\{[^}]*z-index:\s*10/);
    const tint = css.match(/thead\.sticky\.bg-muted\\\/40\s*\{[^}]*\}/);
    expect(tint, 'expected an opaque bg-muted/40 sticky header rule').not.toBeNull();
    expect(tint![0]).toMatch(/color-mix\([^)]*hsl\(var\(--muted\)\)[^)]*hsl\(var\(--card\)\)/);
  });
});
