import { describe, expect, it } from 'vitest';

import { earnSuffix, gatedCredentials } from './gating-view';
import type { UserState } from '../andamio/dashboard-client';
import type { Mappings, MappingRule } from '../gating/mappings';

const mappingsOf = (rules: MappingRule[]): Mappings => ({
  rules,
  managedRoleIds: new Set(rules.map((r) => r.role_id)),
});

const state = (over: Partial<UserState> = {}): UserState => ({
  alias: 'alice',
  enrolledCourses: [],
  completedCourses: [],
  ...over,
});

const issuerRule: MappingRule = {
  type: 'credential',
  course_id: 'c1',
  slt_hash: 's1',
  role_id: 'r1',
  label: 'Andamio Issuer',
  earn_url: 'https://app.andamio.io/earn',
};

describe('earnSuffix', () => {
  it('returns the " — earn it: <url>" suffix when a url is present', () => {
    expect(earnSuffix('https://app.andamio.io/earn')).toBe(
      ' — earn it: https://app.andamio.io/earn',
    );
  });

  it('returns an empty string for a missing or empty url', () => {
    expect(earnSuffix()).toBe('');
    expect(earnSuffix(undefined)).toBe('');
    expect(earnSuffix('')).toBe('');
  });
});

describe('gatedCredentials', () => {
  it('labels via rule.label, falling back to the course display name', () => {
    const noLabel: MappingRule = { type: 'enrolled', course_id: 'c2', role_id: 'r2' };
    const out = gatedCredentials(mappingsOf([issuerRule, noLabel]), { c2: 'Cardano 101' });
    expect(out[0].label).toBe('Andamio Issuer');
    expect(out[1].label).toBe('Cardano 101');
  });

  it('falls back to the raw course_id when no label or display name exists', () => {
    const out = gatedCredentials(
      mappingsOf([{ type: 'enrolled', course_id: 'c9', role_id: 'r9' }]),
      {},
    );
    expect(out[0].label).toBe('c9');
  });

  it('satisfied is false for every credential when no state is given', () => {
    const out = gatedCredentials(mappingsOf([issuerRule]), {});
    expect(out[0].satisfied).toBe(false);
  });

  it('marks satisfied when the member holds the credential', () => {
    const held = state({ completedCourses: [{ courseId: 'c1', claimedCredentials: ['s1'] }] });
    const out = gatedCredentials(mappingsOf([issuerRule]), {}, held);
    expect(out[0].satisfied).toBe(true);
  });

  it('marks unsatisfied when the member lacks the credential', () => {
    const out = gatedCredentials(mappingsOf([issuerRule]), {}, state());
    expect(out[0].satisfied).toBe(false);
    expect(out[0].earnUrl).toBe('https://app.andamio.io/earn');
  });

  it('de-dupes by the required credential (course + slt), not by role', () => {
    const out = gatedCredentials(
      mappingsOf([issuerRule, { ...issuerRule, role_id: 'r2' }]),
      {},
    );
    expect(out).toHaveLength(1);
  });

  it('keeps distinct credentials in the same course separate', () => {
    const out = gatedCredentials(
      mappingsOf([
        issuerRule,
        { ...issuerRule, slt_hash: 's2', role_id: 'r2', label: 'Second' },
      ]),
      {},
    );
    expect(out).toHaveLength(2);
  });
});
