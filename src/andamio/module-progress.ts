/**
 * Pure join of a course's modules with a member's assignment commitments — the
 * single source of truth behind both `/progress` views (full status + the
 * opportunities subset).
 *
 * Product fact: Course Modules ↔ Assignments are 1:1, so a module's progress
 * *is* its assignment's commitment status, and a module with no commitment (or a
 * refused one) *is* an open opportunity. The commitments endpoint returns only
 * modules the member has engaged, so "not started" is the absence of a row —
 * derived here, never sent by the server.
 *
 * Everything in this module is pure, total, and I/O-free: no `discord.js`, no
 * fetch, no db. The command layer ({@link ../commands/progress}) does the reads,
 * scopes commitments to one course, filters modules to on-chain, then calls in.
 *
 * Status vocabulary is LIVE-CONFIRMED (mainnet 2026-06-29 — see
 * `__fixtures__/content/README.md`): commitment statuses observed are `ACCEPTED`
 * and `CREDENTIAL_CLAIMED`. Glyphs/labels map those plus the refused-like and
 * not-started cases; any other server-side status passes through and renders as
 * a neutral "in progress" rather than crashing or being dropped.
 */

import type { AssignmentCommitment, CommitmentStatus, CourseModule } from './content-client';

/** A module's progress: its commitment status, or `'NONE'` when not started. */
export type ModuleProgressStatus = CommitmentStatus | 'NONE';

/** One module joined with the member's commitment status for it. */
export interface ModuleStatus {
  module: CourseModule;
  status: ModuleProgressStatus;
}

/**
 * Join modules with commitments by module code (1:1 module↔assignment). The
 * caller is responsible for scoping `commitments` to the relevant course
 * (`CourseModule` carries no course id) and for filtering `modules` to the set
 * it wants to display (e.g. on-chain only). Module order is preserved. A module
 * with no matching commitment gets `'NONE'`; on the rare duplicate module code
 * the first commitment wins. Total — never throws.
 */
export function joinModuleProgress(
  modules: CourseModule[],
  commitments: AssignmentCommitment[],
): ModuleStatus[] {
  const byCode = new Map<string, AssignmentCommitment>();
  for (const c of commitments) {
    if (!byCode.has(c.moduleCode)) byCode.set(c.moduleCode, c);
  }
  return modules.map((module) => {
    const commitment = byCode.get(module.moduleCode);
    return { module, status: commitment ? commitment.status : 'NONE' };
  });
}

/** The refused-like statuses (forward-compat; not present in the 2026-06-29 capture). */
function isRefused(status: ModuleProgressStatus): boolean {
  const s = status.toUpperCase();
  return s === 'REFUSED' || s === 'REJECTED';
}

/**
 * An open opportunity = a module the member has **not started** (`'NONE'`) or
 * whose commitment was **refused** (origin R4). Approved / submitted / claimed
 * modules are not opportunities.
 */
export function isOpportunity(status: ModuleProgressStatus): boolean {
  return status === 'NONE' || isRefused(status);
}

/** Keep only the open-opportunity rows, preserving order. */
export function selectOpportunities(statuses: ModuleStatus[]): ModuleStatus[] {
  return statuses.filter((m) => isOpportunity(m.status));
}

/**
 * Map a progress status to its display glyph. Confirmed values get distinct
 * glyphs; the not-started and refused cases drive the opportunity views; any
 * unrecognized (passed-through) status renders as 📝 "in progress" so the row is
 * still shown, never dropped.
 *
 *   ✅ accepted/approved · 🎓 credential claimed · 📝 in progress ·
 *   ⬜ not started · ❌ refused
 */
export function statusGlyph(status: ModuleProgressStatus): string {
  if (status === 'NONE') return '⬜';
  if (isRefused(status)) return '❌';
  switch (status) {
    case 'ACCEPTED':
      return '✅';
    case 'CREDENTIAL_CLAIMED':
      return '🎓';
    default:
      return '📝';
  }
}

/** A short human label for a progress status (pairs with {@link statusGlyph}). */
export function statusLabel(status: ModuleProgressStatus): string {
  if (status === 'NONE') return 'Not started';
  if (isRefused(status)) return 'Refused';
  switch (status) {
    case 'ACCEPTED':
      return 'Accepted';
    case 'CREDENTIAL_CLAIMED':
      return 'Credential claimed';
    default:
      // An unrecognized but real server status — surface it verbatim rather
      // than hiding it behind a generic word.
      return status;
  }
}
