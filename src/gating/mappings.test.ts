import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { parseMappings, loadMappings } from './mappings';

const valid = [
  { type: 'enrolled', course_id: 'c1', role_id: 'role-enrolled' },
  { type: 'course-complete', course_id: 'c1', role_id: 'role-complete' },
  {
    type: 'credential',
    course_id: 'c1',
    slt_hash: 'slt-abc',
    role_id: 'role-cred',
  },
];

describe('parseMappings — valid config', () => {
  it('parses each rule type and derives the managed-role set', () => {
    const m = parseMappings(valid);
    expect(m.rules).toHaveLength(3);
    expect([...m.managedRoleIds].sort()).toEqual([
      'role-complete',
      'role-cred',
      'role-enrolled',
    ]);
    // credential rule retains its slt_hash; others don't.
    const cred = m.rules.find((r) => r.type === 'credential');
    expect(cred?.slt_hash).toBe('slt-abc');
    const enrolled = m.rules.find((r) => r.type === 'enrolled');
    expect(enrolled?.slt_hash).toBeUndefined();
  });

  it('accepts optional earn_url and label and retains them', () => {
    const m = parseMappings([
      {
        type: 'credential',
        course_id: 'c1',
        slt_hash: 's',
        role_id: 'r',
        earn_url: 'https://app.andamio.io/earn',
        label: 'Andamio Developer',
      },
    ]);
    expect(m.rules[0].earn_url).toBe('https://app.andamio.io/earn');
    expect(m.rules[0].label).toBe('Andamio Developer');
  });

  it('leaves earn_url and label undefined when absent', () => {
    const m = parseMappings([
      { type: 'enrolled', course_id: 'c1', role_id: 'r' },
    ]);
    expect(m.rules[0].earn_url).toBeUndefined();
    expect(m.rules[0].label).toBeUndefined();
  });

  it('dedupes role ids across rules in the managed set', () => {
    const m = parseMappings([
      { type: 'enrolled', course_id: 'c1', role_id: 'shared' },
      { type: 'course-complete', course_id: 'c2', role_id: 'shared' },
    ]);
    expect(m.managedRoleIds.size).toBe(1);
    expect(m.managedRoleIds.has('shared')).toBe(true);
  });
});

describe('parseMappings — invalid config fails with a clear message', () => {
  it('rejects a non-array top level', () => {
    expect(() => parseMappings({ type: 'enrolled' })).toThrow(/array/i);
  });

  it('rejects an unknown rule type', () => {
    expect(() =>
      parseMappings([{ type: 'bogus', course_id: 'c1', role_id: 'r' }]),
    ).toThrow(/unknown or missing "type"/i);
  });

  it('rejects a missing type', () => {
    expect(() =>
      parseMappings([{ course_id: 'c1', role_id: 'r' }]),
    ).toThrow(/"type"/i);
  });

  it('rejects a rule missing course_id', () => {
    expect(() =>
      parseMappings([{ type: 'enrolled', role_id: 'r' }]),
    ).toThrow(/course_id/i);
  });

  it('rejects a rule missing role_id', () => {
    expect(() =>
      parseMappings([{ type: 'enrolled', course_id: 'c1' }]),
    ).toThrow(/role_id/i);
  });

  it('rejects a credential rule missing slt_hash', () => {
    expect(() =>
      parseMappings([
        { type: 'credential', course_id: 'c1', role_id: 'r' },
      ]),
    ).toThrow(/slt_hash/i);
  });

  it('rejects a non-http(s) earn_url', () => {
    expect(() =>
      parseMappings([
        { type: 'enrolled', course_id: 'c1', role_id: 'r', earn_url: 'ftp://x' },
      ]),
    ).toThrow(/earn_url/i);
  });

  it('rejects a malformed earn_url', () => {
    expect(() =>
      parseMappings([
        { type: 'enrolled', course_id: 'c1', role_id: 'r', earn_url: 'not a url' },
      ]),
    ).toThrow(/earn_url/i);
  });

  it('rejects an empty label', () => {
    expect(() =>
      parseMappings([
        { type: 'enrolled', course_id: 'c1', role_id: 'r', label: '   ' },
      ]),
    ).toThrow(/label/i);
  });

  it('names the offending rule index in the message', () => {
    expect(() =>
      parseMappings([
        { type: 'enrolled', course_id: 'c1', role_id: 'r0' },
        { type: 'enrolled', role_id: 'r1' },
      ]),
    ).toThrow(/rule #1/);
  });
});

describe('loadMappings — file loading', () => {
  function writeTmp(contents: string): string {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'mappings-')),
      'role-mappings.json',
    );
    fs.writeFileSync(file, contents);
    return file;
  }

  it('loads and validates a well-formed file', () => {
    const file = writeTmp(JSON.stringify(valid));
    const m = loadMappings(file);
    expect(m.rules).toHaveLength(3);
  });

  it('throws a clear error on a missing file', () => {
    expect(() => loadMappings('/no/such/role-mappings.json')).toThrow(
      /Could not read role-mappings file/i,
    );
  });

  it('throws a clear error on malformed JSON', () => {
    const file = writeTmp('{ not json');
    expect(() => loadMappings(file)).toThrow(/not valid JSON/i);
  });

  it('propagates validation errors from file contents', () => {
    const file = writeTmp(
      JSON.stringify([{ type: 'credential', course_id: 'c1', role_id: 'r' }]),
    );
    expect(() => loadMappings(file)).toThrow(/slt_hash/i);
  });

  it('validates the committed demo config (config/role-mappings.json)', () => {
    const demo = path.join(
      __dirname,
      '..',
      '..',
      'config',
      'role-mappings.json',
    );
    // The demo config is committed and deploy-critical; it must always parse,
    // even with REPLACE_WITH_… placeholders still in place.
    const m = loadMappings(demo);
    expect(Array.isArray(m.rules)).toBe(true);
  });

  it('validates the shipped example config', () => {
    const example = path.join(
      __dirname,
      '..',
      '..',
      'config',
      'role-mappings.example.json',
    );
    const m = loadMappings(example);
    expect(m.rules.length).toBeGreaterThanOrEqual(3);
    const types = new Set(m.rules.map((r) => r.type));
    expect(types.has('enrolled')).toBe(true);
    expect(types.has('course-complete')).toBe(true);
    expect(types.has('credential')).toBe(true);
  });
});
