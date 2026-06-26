import { describe, expect, it } from 'vitest';

import { fitFieldValue, FIELD_VALUE_LIMIT } from './embed-field';

describe('fitFieldValue', () => {
  it('empty list → empty string', () => {
    expect(fitFieldValue([])).toBe('');
  });

  it('under the limit → plain join, unchanged', () => {
    const lines = ['• one', '• two', '• three'];
    expect(fitFieldValue(lines)).toBe('• one\n• two\n• three');
  });

  it('a list whose join is exactly the limit is kept whole', () => {
    // One line of exactly FIELD_VALUE_LIMIT chars, no separators.
    const line = 'x'.repeat(FIELD_VALUE_LIMIT);
    const out = fitFieldValue([line]);
    expect(out).toBe(line);
    expect(out.length).toBe(FIELD_VALUE_LIMIT);
  });

  it('over the limit → keeps whole lines and appends a "…and N more" marker', () => {
    // 50 lines of 40 chars each (~2050 chars joined) blows past 1024.
    const lines = Array.from({ length: 50 }, (_, i) => `• ${'c'.repeat(38)} ${i}`);
    const out = fitFieldValue(lines);

    expect(out.length).toBeLessThanOrEqual(FIELD_VALUE_LIMIT);
    expect(out).toMatch(/\n…and \d+ more$/);

    // The marker count matches the lines actually dropped.
    const kept = out.split('\n').filter((l) => !l.startsWith('…and')).length;
    const dropped = Number(out.match(/…and (\d+) more/)![1]);
    expect(kept + dropped).toBe(lines.length);

    // Every kept line is an intact original line (no mid-line truncation).
    const keptLines = out.split('\n').slice(0, kept);
    keptLines.forEach((l, i) => expect(l).toBe(lines[i]));
  });

  it('a single line longer than the limit → hard-truncated with an ellipsis', () => {
    const huge = '•' + 'y'.repeat(FIELD_VALUE_LIMIT + 500);
    const out = fitFieldValue([huge]);
    expect(out.length).toBe(FIELD_VALUE_LIMIT);
    expect(out.endsWith('…')).toBe(true);
  });

  it('first line fits but with its marker overflows → that line is hard-truncated', () => {
    // Line just under the limit, so "<line>\n…and 1 more" overflows.
    const nearLimit = 'z'.repeat(FIELD_VALUE_LIMIT - 2);
    const out = fitFieldValue([nearLimit, 'second']);
    expect(out.length).toBeLessThanOrEqual(FIELD_VALUE_LIMIT);
    expect(out.endsWith('…')).toBe(true);
  });
});
