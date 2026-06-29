import { describe, it, expect } from 'vitest';

import { rankFaqEntries, resolveAnswer, MAX_CHOICES } from './match';
import { type FaqEntry } from './config';

const entries: FaqEntry[] = [
  { id: 'connect', question: 'How do I connect my account?', answer: 'a1' },
  {
    id: 'channel',
    question: "Why can't I see a channel?",
    answer: 'a2',
    aliases: ['locked channel', 'access'],
  },
  { id: 'creds', question: 'How do I see my credentials?', answer: 'a3' },
];

describe('rankFaqEntries', () => {
  it('empty query → all entries in config order, as {name,value}', () => {
    const choices = rankFaqEntries(entries, '');
    expect(choices).toEqual([
      { name: 'How do I connect my account?', value: 'connect' },
      { name: "Why can't I see a channel?", value: 'channel' },
      { name: 'How do I see my credentials?', value: 'creds' },
    ]);
  });

  it('whitespace-only query is treated as empty', () => {
    expect(rankFaqEntries(entries, '   ')).toHaveLength(3);
  });

  it('is case-insensitive on the question text', () => {
    const choices = rankFaqEntries(entries, 'CONNECT');
    expect(choices.map((c) => c.value)).toEqual(['connect']);
  });

  it('ranks a prefix match above a mid-string substring match', () => {
    // "how" is a prefix of two questions; "channel" only appears mid-string.
    const choices = rankFaqEntries(entries, 'how');
    expect(choices.map((c) => c.value)).toEqual(['connect', 'creds']);
    // And a query hitting both prefix and alias keeps prefix entries first.
    const mixed = rankFaqEntries(
      [
        { id: 'a', question: 'channel guide', answer: 'x' }, // prefix of "channel"
        ...entries,
      ],
      'channel',
    );
    // 'a' (prefix) before 'channel' (question substring + alias).
    expect(mixed[0].value).toBe('a');
    expect(mixed.map((c) => c.value)).toContain('channel');
  });

  it('ranks a question-substring match (tier 1) above an alias-only match (tier 2)', () => {
    // 'find' is a mid-string substring of the first question (tier 1) and only
    // an alias of the second (tier 2). The tier-1 entry must come first.
    const choices = rankFaqEntries(
      [
        { id: 'a', question: 'where to find it', answer: 'x' },
        { id: 'b', question: 'unrelated topic', answer: 'y', aliases: ['find'] },
      ],
      'find',
    );
    expect(choices.map((c) => c.value)).toEqual(['a', 'b']);
  });

  it('matches on an alias when the question does not match', () => {
    const choices = rankFaqEntries(entries, 'locked');
    expect(choices.map((c) => c.value)).toEqual(['channel']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(rankFaqEntries(entries, 'zzzz')).toEqual([]);
  });

  it('caps results at the Discord 25-choice limit', () => {
    const many: FaqEntry[] = Array.from({ length: 30 }, (_, i) => ({
      id: `q${i}`,
      question: `Question number ${i} about setup`,
      answer: 'a',
    }));
    const choices = rankFaqEntries(many, 'setup');
    expect(choices).toHaveLength(MAX_CHOICES);
  });

  it('caps an all-match (empty query) at the limit too', () => {
    const many: FaqEntry[] = Array.from({ length: 30 }, (_, i) => ({
      id: `q${i}`,
      question: `Q${i}`,
      answer: 'a',
    }));
    expect(rankFaqEntries(many, '')).toHaveLength(MAX_CHOICES);
  });

  it('truncates a name longer than 100 chars to satisfy Discord', () => {
    const long = 'x'.repeat(150);
    const choices = rankFaqEntries(
      [{ id: 'long', question: long, answer: 'a' }],
      '',
    );
    expect(choices[0].name.length).toBeLessThanOrEqual(100);
    expect(choices[0].name.endsWith('…')).toBe(true);
  });
});

describe('resolveAnswer', () => {
  it('returns the entry for a known id', () => {
    expect(resolveAnswer(entries, 'channel')?.answer).toBe('a2');
  });

  it('returns undefined for an unknown id', () => {
    expect(resolveAnswer(entries, 'nope')).toBeUndefined();
  });

  it('returns undefined for an empty entry list', () => {
    expect(resolveAnswer([], 'connect')).toBeUndefined();
  });
});
