import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { parseFaq, loadFaq } from './config';

const valid = [
  { id: 'connect', question: 'How do I connect my account?', answer: 'Run /login.' },
  {
    id: 'channel',
    question: "Why can't I see a channel?",
    answer: 'Run /check, then /available.',
    aliases: ['locked channel', 'missing channel'],
  },
  { id: 'creds', question: 'How do I see my credentials?', answer: 'Run /credentials.' },
];

describe('parseFaq — valid config', () => {
  it('parses each entry and preserves optional aliases', () => {
    const entries = parseFaq(valid);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      id: 'connect',
      question: 'How do I connect my account?',
      answer: 'Run /login.',
    });
    expect(entries[1].aliases).toEqual(['locked channel', 'missing channel']);
    // aliases omitted when absent (not set to undefined or []).
    expect('aliases' in entries[0]).toBe(false);
  });
});

describe('parseFaq — validation', () => {
  it('rejects a non-array top level', () => {
    expect(() => parseFaq({})).toThrow(/expected a JSON array/i);
    expect(() => parseFaq('nope')).toThrow(/expected a JSON array/i);
    expect(() => parseFaq(null)).toThrow(/expected a JSON array/i);
  });

  it('rejects an entry that is not an object', () => {
    expect(() => parseFaq(['x'])).toThrow(/entry #0 is not an object/i);
  });

  it('rejects a missing or empty id', () => {
    expect(() => parseFaq([{ question: 'q', answer: 'a' }])).toThrow(/"id"/i);
    expect(() => parseFaq([{ id: '  ', question: 'q', answer: 'a' }])).toThrow(
      /"id"/i,
    );
  });

  it('rejects a missing question or answer', () => {
    expect(() => parseFaq([{ id: 'x', answer: 'a' }])).toThrow(/"question"/i);
    expect(() => parseFaq([{ id: 'x', question: 'q' }])).toThrow(/"answer"/i);
  });

  it('rejects aliases that are not an array of non-empty strings', () => {
    expect(() =>
      parseFaq([{ id: 'x', question: 'q', answer: 'a', aliases: 'nope' }]),
    ).toThrow(/aliases/i);
    expect(() =>
      parseFaq([{ id: 'x', question: 'q', answer: 'a', aliases: ['ok', ''] }]),
    ).toThrow(/aliases/i);
  });

  it('rejects a duplicate id and names the offending entry', () => {
    expect(() =>
      parseFaq([
        { id: 'dup', question: 'q1', answer: 'a1' },
        { id: 'dup', question: 'q2', answer: 'a2' },
      ]),
    ).toThrow(/duplicate id "dup".*entry #1/is);
  });

  it('names the offending entry index in the message', () => {
    expect(() =>
      parseFaq([
        { id: 'ok', question: 'q', answer: 'a' },
        { id: 'bad', question: 'q' },
      ]),
    ).toThrow(/entry #1/);
  });
});

describe('loadFaq — file loading', () => {
  function writeTmp(contents: string): string {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'faq-')),
      'faq.json',
    );
    fs.writeFileSync(file, contents);
    return file;
  }

  it('loads and validates a well-formed file', () => {
    const file = writeTmp(JSON.stringify(valid));
    expect(loadFaq(file)).toHaveLength(3);
  });

  it('returns [] for a missing file (degrade to static guide)', () => {
    expect(loadFaq('/no/such/faq.json')).toEqual([]);
  });

  it('returns [] for an absent or empty path', () => {
    expect(loadFaq(undefined)).toEqual([]);
    expect(loadFaq('')).toEqual([]);
    expect(loadFaq('   ')).toEqual([]);
  });

  it('throws on malformed JSON in an existing file', () => {
    const file = writeTmp('{ not json');
    expect(() => loadFaq(file)).toThrow(/not valid JSON/i);
  });

  it('propagates validation errors from file contents', () => {
    const file = writeTmp(JSON.stringify([{ id: 'x', question: 'q' }]));
    expect(() => loadFaq(file)).toThrow(/"answer"/i);
  });
});

// Guard: the shipped seed config is always valid and non-trivial. A broken seed
// would silently strip /faq down to the static guide in production, so fail loud
// here instead. (Path is repo-relative; tests run from the repo root.)
describe('config/faq.json seed', () => {
  it('parses without throwing and ships at least 3 unique-id entries', () => {
    const entries = loadFaq('config/faq.json');
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
