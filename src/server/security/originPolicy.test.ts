import { describe, expect, it } from 'vitest';

import { isOriginAllowed, parseAllowedOrigins } from './originPolicy.js';

describe('origin policy', () => {
  it('parses comma-separated origins', () => {
    expect(parseAllowedOrigins(' http://localhost:3000, https://play.example ')).toEqual(
      new Set(['http://localhost:3000', 'https://play.example']),
    );
  });

  it('allows configured browser origins and native clients', () => {
    const allowed = parseAllowedOrigins('http://localhost:3000');

    expect(isOriginAllowed('http://localhost:3000', allowed)).toBe(true);
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
  });

  it('rejects unconfigured browser origins', () => {
    const allowed = parseAllowedOrigins('http://localhost:3000');

    expect(isOriginAllowed('https://evil.example', allowed)).toBe(false);
  });

  it('supports an explicit wildcard policy', () => {
    expect(isOriginAllowed('https://any.example', parseAllowedOrigins('*'))).toBe(true);
  });
});
