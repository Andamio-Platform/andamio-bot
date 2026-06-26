import { describe, it, expect } from 'vitest';

import type { UserState } from '../andamio/dashboard-client';
import { parseMappings, type Mappings } from './mappings';
import { evaluate, desiredRoles, unconnectedDiff } from './evaluator';

const mappings: Mappings = parseMappings([
  { type: 'enrolled', course_id: 'c1', role_id: 'role-enrolled' },
  { type: 'course-complete', course_id: 'c1', role_id: 'role-complete' },
  {
    type: 'credential',
    course_id: 'c1',
    slt_hash: 'slt-target',
    role_id: 'role-cred',
  },
]);

function state(partial: Partial<UserState>): UserState {
  return {
    alias: partial.alias ?? 'alice',
    enrolledCourses: partial.enrolledCourses ?? [],
    completedCourses: partial.completedCourses ?? [],
  };
}

describe('per-type granting conditions', () => {
  it('enrolled: grants on active enrollment', () => {
    const s = state({ enrolledCourses: ['c1'] });
    expect(desiredRoles(s, mappings).has('role-enrolled')).toBe(true);
    // not completed → no complete/credential roles
    expect(desiredRoles(s, mappings).has('role-complete')).toBe(false);
    expect(desiredRoles(s, mappings).has('role-cred')).toBe(false);
  });

  it('enrolled: also satisfied by completion (completion implies enrollment)', () => {
    const s = state({
      completedCourses: [{ courseId: 'c1', claimedCredentials: [] }],
    });
    expect(desiredRoles(s, mappings).has('role-enrolled')).toBe(true);
  });

  it('course-complete: grants only on completion, not mere enrollment', () => {
    expect(
      desiredRoles(state({ enrolledCourses: ['c1'] }), mappings).has(
        'role-complete',
      ),
    ).toBe(false);
    expect(
      desiredRoles(
        state({
          completedCourses: [{ courseId: 'c1', claimedCredentials: [] }],
        }),
        mappings,
      ).has('role-complete'),
    ).toBe(true);
  });

  it('credential: grants only when the SPECIFIC slt_hash is claimed', () => {
    // completed, but holds a different credential → no role-cred
    const wrong = state({
      completedCourses: [
        { courseId: 'c1', claimedCredentials: ['slt-other'] },
      ],
    });
    expect(desiredRoles(wrong, mappings).has('role-cred')).toBe(false);

    // completed AND holds the target credential → role-cred
    const right = state({
      completedCourses: [
        { courseId: 'c1', claimedCredentials: ['slt-other', 'slt-target'] },
      ],
    });
    expect(desiredRoles(right, mappings).has('role-cred')).toBe(true);
  });

  it('credential: not granted if the credential is claimed in a DIFFERENT course', () => {
    const s = state({
      completedCourses: [
        { courseId: 'c2', claimedCredentials: ['slt-target'] },
      ],
    });
    expect(desiredRoles(s, mappings).has('role-cred')).toBe(false);
  });
});

describe('AE2 — completing a mapped course gains the role (in add)', () => {
  it('returns the newly-earned roles in `add` with no re-login', () => {
    const s = state({
      completedCourses: [
        { courseId: 'c1', claimedCredentials: ['slt-target'] },
      ],
    });
    // Member currently holds none of the managed roles.
    const diff = evaluate(s, [], mappings);
    expect(diff.add.sort()).toEqual([
      'role-complete',
      'role-cred',
      'role-enrolled',
    ]);
    expect(diff.remove).toEqual([]);
  });
});

describe('AE3 — no longer satisfying a mapping revokes the role (in remove)', () => {
  it('removes a managed role the member holds but no longer earns', () => {
    // Member holds role-complete + role-cred, but now only enrolled (not complete).
    const s = state({ enrolledCourses: ['c1'] });
    const diff = evaluate(s, ['role-complete', 'role-cred', 'role-enrolled'], mappings);
    expect(diff.add).toEqual([]);
    expect(diff.remove.sort()).toEqual(['role-complete', 'role-cred']);
  });
});

describe('AE4 — unconnected member gets no credential roles', () => {
  it('unconnectedDiff adds nothing and removes managed roles if present', () => {
    const diff = unconnectedDiff(
      ['role-cred', 'unmanaged-role'],
      mappings,
    );
    expect(diff.add).toEqual([]);
    expect(diff.remove).toEqual(['role-cred']);
    // unmanaged role untouched
    expect(diff.remove).not.toContain('unmanaged-role');
  });

  it('unconnected with no managed roles is a no-op', () => {
    const diff = unconnectedDiff(['unmanaged-1', 'unmanaged-2'], mappings);
    expect(diff.add).toEqual([]);
    expect(diff.remove).toEqual([]);
  });
});

describe('managed-set guard — never touches unmanaged roles', () => {
  it('does not add or remove any role outside the managed set', () => {
    const s = state({
      completedCourses: [
        { courseId: 'c1', claimedCredentials: ['slt-target'] },
      ],
    });
    // Member holds an unmanaged role; assert it's never in add or remove.
    const diff = evaluate(
      s,
      ['unmanaged-mod-role', 'role-enrolled'],
      mappings,
    );
    expect(diff.add).not.toContain('unmanaged-mod-role');
    expect(diff.remove).not.toContain('unmanaged-mod-role');
    // Sanity: it still grants the genuinely-earned managed roles.
    expect(diff.add.sort()).toEqual(['role-complete', 'role-cred']);
  });

  it('every id in add/remove is in the managed set', () => {
    const s = state({
      enrolledCourses: ['c1'],
      completedCourses: [
        { courseId: 'c1', claimedCredentials: [] },
      ],
    });
    const diff = evaluate(s, ['unmanaged-x', 'role-cred'], mappings);
    for (const id of [...diff.add, ...diff.remove]) {
      expect(mappings.managedRoleIds.has(id)).toBe(true);
    }
  });
});

describe('deny-list subtraction (R1, R4)', () => {
  // A member who has completed c1 and claimed the target credential earns all
  // three managed roles.
  const earnedAll = state({
    enrolledCourses: ['c1'],
    completedCourses: [{ courseId: 'c1', claimedCredentials: ['slt-target'] }],
  });

  it('empty deny set → identical to the no-arg behavior (regression guard)', () => {
    const withArg = evaluate(earnedAll, [], mappings, new Set());
    const without = evaluate(earnedAll, [], mappings);
    expect(withArg).toEqual(without);
  });

  it('denied role the member does NOT hold is never added', () => {
    const diff = evaluate(earnedAll, [], mappings, new Set(['role-cred']));
    expect(diff.add).not.toContain('role-cred');
    // The other earned roles are still granted.
    expect(diff.add.sort()).toEqual(['role-complete', 'role-enrolled']);
  });

  it('denied role the member currently holds is actively removed', () => {
    const diff = evaluate(
      earnedAll,
      ['role-cred'],
      mappings,
      new Set(['role-cred']),
    );
    expect(diff.remove).toContain('role-cred');
    expect(diff.add).not.toContain('role-cred');
  });

  it('full block (all managed roles denied) withholds every earned role, leaves unmanaged alone', () => {
    const diff = evaluate(
      earnedAll,
      ['role-enrolled', 'role-complete', 'role-cred', 'unmanaged-mod'],
      mappings,
      mappings.managedRoleIds,
    );
    expect(diff.add).toEqual([]);
    expect(diff.remove.sort()).toEqual([
      'role-complete',
      'role-cred',
      'role-enrolled',
    ]);
    expect(diff.remove).not.toContain('unmanaged-mod');
  });

  it('denying an unmanaged role has no effect on add/remove', () => {
    const diff = evaluate(
      earnedAll,
      ['unmanaged-mod'],
      mappings,
      new Set(['unmanaged-mod']),
    );
    expect(diff.remove).not.toContain('unmanaged-mod');
    expect(diff.add.sort()).toEqual([
      'role-complete',
      'role-cred',
      'role-enrolled',
    ]);
  });
});
