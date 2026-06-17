import { describe, expect, it } from 'vitest';

import {
  loadCourseDisplayNames,
  loadShowAllCourses,
  displayNameFor,
  isDisplayed,
  type DisplayFilter,
} from './course-names';

describe('loadCourseDisplayNames', () => {
  it('parses a JSON object of id → name', () => {
    const m = loadCourseDisplayNames({ COURSE_DISPLAY_NAMES: '{"c1":"One","c2":"Two"}' });
    expect(m).toEqual({ c1: 'One', c2: 'Two' });
  });

  it('returns {} for unset / empty / malformed / non-object values', () => {
    expect(loadCourseDisplayNames({})).toEqual({});
    expect(loadCourseDisplayNames({ COURSE_DISPLAY_NAMES: '  ' })).toEqual({});
    expect(loadCourseDisplayNames({ COURSE_DISPLAY_NAMES: 'not json' })).toEqual({});
    expect(loadCourseDisplayNames({ COURSE_DISPLAY_NAMES: '["a","b"]' })).toEqual({});
  });

  it('drops non-string values', () => {
    const m = loadCourseDisplayNames({ COURSE_DISPLAY_NAMES: '{"c1":"One","c2":5}' });
    expect(m).toEqual({ c1: 'One' });
  });
});

describe('loadShowAllCourses', () => {
  it('is true only for the string "true" (case-insensitive)', () => {
    expect(loadShowAllCourses({ SHOW_ALL_COURSES: 'true' })).toBe(true);
    expect(loadShowAllCourses({ SHOW_ALL_COURSES: 'TRUE' })).toBe(true);
    expect(loadShowAllCourses({ SHOW_ALL_COURSES: ' true ' })).toBe(true);
  });

  it('is false for unset / false / other values', () => {
    expect(loadShowAllCourses({})).toBe(false);
    expect(loadShowAllCourses({ SHOW_ALL_COURSES: 'false' })).toBe(false);
    expect(loadShowAllCourses({ SHOW_ALL_COURSES: '1' })).toBe(false);
    expect(loadShowAllCourses({ SHOW_ALL_COURSES: 'yes' })).toBe(false);
  });
});

describe('displayNameFor', () => {
  it('returns the mapped label, falling back to the raw id', () => {
    expect(displayNameFor('c1', { c1: 'One' })).toBe('One');
    expect(displayNameFor('c2', { c1: 'One' })).toBe('c2');
  });
});

describe('isDisplayed', () => {
  const filter = (over: Partial<DisplayFilter> = {}): DisplayFilter => ({
    names: {},
    showAll: false,
    gatedCourseIds: new Set<string>(),
    ...over,
  });

  it('shows everything when the map is empty (back-compat)', () => {
    expect(isDisplayed('anything', filter())).toBe(true);
  });

  it('with a non-empty map, shows mapped courses and hides unmapped ones', () => {
    const f = filter({ names: { c1: 'One' } });
    expect(isDisplayed('c1', f)).toBe(true);
    expect(isDisplayed('c2', f)).toBe(false);
  });

  it('SHOW_ALL_COURSES overrides curation', () => {
    const f = filter({ names: { c1: 'One' }, showAll: true });
    expect(isDisplayed('c2', f)).toBe(true);
  });

  it('always shows a gated course even when absent from the map', () => {
    const f = filter({ names: { c1: 'One' }, gatedCourseIds: new Set(['gated']) });
    expect(isDisplayed('gated', f)).toBe(true);
    expect(isDisplayed('other', f)).toBe(false);
  });
});
