import { describe, expect, it } from 'vitest';

import { gatingRolesForChannel, type ChannelOverwrite } from './channel-roles';

// Small builder so each case reads as just the fact under test.
function ow(
  id: string,
  type: 'role' | 'member',
  allowsView: boolean,
): ChannelOverwrite {
  return { id, type, allowsView };
}

const managed = new Set(['r1', 'r2', 'r3']);

describe('gatingRolesForChannel (R2)', () => {
  it('includes a managed, role-type, allow-View overwrite (happy path)', () => {
    expect(gatingRolesForChannel([ow('r1', 'role', true)], managed)).toEqual([
      'r1',
    ]);
  });

  it('excludes an allow-View role that is NOT managed (pins the over-broad-denial guard)', () => {
    expect(gatingRolesForChannel([ow('rX', 'role', true)], managed)).toEqual([]);
  });

  it('excludes a member-type overwrite even when its id is in managedRoleIds', () => {
    // A per-member View grant must never be read as a gating role.
    expect(gatingRolesForChannel([ow('r1', 'member', true)], managed)).toEqual(
      [],
    );
  });

  it('excludes a managed role whose View is denied/neutral (allowsView false)', () => {
    expect(gatingRolesForChannel([ow('r2', 'role', false)], managed)).toEqual(
      [],
    );
  });

  it('returns [] when there are no overwrites', () => {
    expect(gatingRolesForChannel([], managed)).toEqual([]);
  });

  it('returns ALL qualifying managed roles, order preserved (R5)', () => {
    expect(
      gatingRolesForChannel(
        [ow('r3', 'role', true), ow('r1', 'role', true)],
        managed,
      ),
    ).toEqual(['r3', 'r1']);
  });

  it('from a mixed bag, returns only the one qualifying overwrite', () => {
    const overwrites = [
      ow('r1', 'role', true), // qualifies
      ow('rX', 'role', true), // unmanaged → excluded
      ow('r2', 'member', true), // member-type → excluded
      ow('r3', 'role', false), // View not allowed → excluded
    ];
    expect(gatingRolesForChannel(overwrites, managed)).toEqual(['r1']);
  });

  it('returns [] when managedRoleIds is empty, even for otherwise-qualifying overwrites', () => {
    expect(
      gatingRolesForChannel([ow('r1', 'role', true)], new Set()),
    ).toEqual([]);
  });
});
