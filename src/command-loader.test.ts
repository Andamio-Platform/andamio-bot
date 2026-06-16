import { describe, it, expect } from 'vitest';

import { isCommandModule } from './command-loader';

describe('isCommandModule', () => {
  it('accepts compiled and source command modules', () => {
    expect(isCommandModule('login.js')).toBe(true);
    expect(isCommandModule('credentials.ts')).toBe(true);
  });

  it('rejects test files (they import vitest and would crash the loader)', () => {
    expect(isCommandModule('credentials.test.ts')).toBe(false);
    expect(isCommandModule('credentials.test.js')).toBe(false);
  });

  it('rejects type declarations and non-modules', () => {
    expect(isCommandModule('login.d.ts')).toBe(false);
    expect(isCommandModule('.gitkeep')).toBe(false);
    expect(isCommandModule('README.md')).toBe(false);
  });
});
