import { describe, expect, it } from 'vitest';

import type { AssignmentCommitment, CourseModule } from './content-client';
import {
  isOpportunity,
  joinModuleProgress,
  selectOpportunities,
  statusGlyph,
  statusLabel,
  type ModuleStatus,
} from './module-progress';

/** Minimal on-chain module factory. */
function mod(moduleCode: string, title = `Module ${moduleCode}`): CourseModule {
  return { title, description: '', onChain: true, moduleCode };
}

/** Commitment factory (course id is irrelevant to the join; caller pre-scopes). */
function commit(moduleCode: string, status: string): AssignmentCommitment {
  return { courseId: 'course_x', moduleCode, status };
}

describe('joinModuleProgress', () => {
  it('attaches each module its commitment status, preserving module order', () => {
    const modules = [mod('101'), mod('102'), mod('103')];
    const commitments = [
      commit('101', 'ACCEPTED'),
      commit('103', 'CREDENTIAL_CLAIMED'),
    ];
    expect(joinModuleProgress(modules, commitments)).toEqual<ModuleStatus[]>([
      { module: modules[0], status: 'ACCEPTED' },
      { module: modules[1], status: 'NONE' }, // no commitment → not started
      { module: modules[2], status: 'CREDENTIAL_CLAIMED' },
    ]);
  });

  it('marks a module with no matching commitment as NONE', () => {
    const modules = [mod('201')];
    expect(joinModuleProgress(modules, [])).toEqual([
      { module: modules[0], status: 'NONE' },
    ]);
  });

  it('passes a refused commitment through as its status', () => {
    const modules = [mod('301')];
    const result = joinModuleProgress(modules, [commit('301', 'REFUSED')]);
    expect(result[0].status).toBe('REFUSED');
  });

  it('returns [] for no modules, and all-NONE when commitments is empty', () => {
    expect(joinModuleProgress([], [])).toEqual([]);
    const modules = [mod('1'), mod('2')];
    expect(joinModuleProgress(modules, []).map((m) => m.status)).toEqual([
      'NONE',
      'NONE',
    ]);
  });

  it('ignores commitments whose module code matches no module (no phantom rows)', () => {
    const modules = [mod('101')];
    const result = joinModuleProgress(modules, [
      commit('101', 'ACCEPTED'),
      commit('999', 'ACCEPTED'), // unrelated module → ignored
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].module.moduleCode).toBe('101');
  });

  it('resolves a duplicate module code to the first commitment', () => {
    const modules = [mod('101')];
    const result = joinModuleProgress(modules, [
      commit('101', 'ACCEPTED'),
      commit('101', 'CREDENTIAL_CLAIMED'),
    ]);
    expect(result[0].status).toBe('ACCEPTED');
  });

  it('keeps an unrecognized status verbatim on the joined row', () => {
    const modules = [mod('101')];
    const result = joinModuleProgress(modules, [commit('101', 'PENDING_REVIEW')]);
    expect(result[0].status).toBe('PENDING_REVIEW');
  });
});

describe('isOpportunity / selectOpportunities', () => {
  it('treats NONE and refused-like statuses as opportunities, others not', () => {
    expect(isOpportunity('NONE')).toBe(true);
    expect(isOpportunity('REFUSED')).toBe(true);
    expect(isOpportunity('rejected')).toBe(true); // case-insensitive
    expect(isOpportunity('ACCEPTED')).toBe(false);
    expect(isOpportunity('CREDENTIAL_CLAIMED')).toBe(false);
    expect(isOpportunity('PENDING_REVIEW')).toBe(false);
  });

  it('selects exactly the NONE + refused rows, in order', () => {
    const rows: ModuleStatus[] = [
      { module: mod('101'), status: 'ACCEPTED' },
      { module: mod('102'), status: 'NONE' },
      { module: mod('103'), status: 'CREDENTIAL_CLAIMED' },
      { module: mod('104'), status: 'REFUSED' },
    ];
    expect(selectOpportunities(rows).map((m) => m.module.moduleCode)).toEqual([
      '102',
      '104',
    ]);
  });

  it('returns [] when there are no open opportunities', () => {
    const rows: ModuleStatus[] = [
      { module: mod('101'), status: 'ACCEPTED' },
      { module: mod('102'), status: 'CREDENTIAL_CLAIMED' },
    ];
    expect(selectOpportunities(rows)).toEqual([]);
  });
});

describe('statusGlyph', () => {
  it('maps each known status to its glyph', () => {
    expect(statusGlyph('NONE')).toBe('⬜');
    expect(statusGlyph('ACCEPTED')).toBe('✅');
    expect(statusGlyph('CREDENTIAL_CLAIMED')).toBe('🎓');
    expect(statusGlyph('REFUSED')).toBe('❌');
    expect(statusGlyph('rejected')).toBe('❌');
  });

  it('maps an unrecognized status to the neutral in-progress glyph', () => {
    expect(statusGlyph('PENDING_REVIEW')).toBe('📝');
  });
});

describe('statusLabel', () => {
  it('gives friendly labels for known statuses', () => {
    expect(statusLabel('NONE')).toBe('Not started');
    expect(statusLabel('ACCEPTED')).toBe('Accepted');
    expect(statusLabel('CREDENTIAL_CLAIMED')).toBe('Credential claimed');
    expect(statusLabel('REFUSED')).toBe('Refused');
  });

  it('surfaces an unrecognized status verbatim', () => {
    expect(statusLabel('PENDING_REVIEW')).toBe('PENDING_REVIEW');
  });
});
