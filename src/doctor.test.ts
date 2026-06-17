import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import { diagnose } from './doctor';

// A fully valid environment. ROLE_MAPPINGS_PATH points at the repo's real,
// committed mappings file (present + valid); DB_PATH's parent is the cwd (writable).
const validEnv = (): NodeJS.ProcessEnv => ({
  DISCORD_TOKEN: 'discord-token',
  DISCORD_APP_ID: '123456789012345678',
  GUILD_ID: '987654321098765432',
  ANDAMIO_API_BASE_URL: 'https://api.test',
  ANDAMIO_API_KEY: 'ant_mn_super-secret-value',
  APP_LOGIN_BASE_URL: 'https://app.test',
  BOT_CALLBACK_BASE_URL: 'https://bot.test',
  ROLE_MAPPINGS_PATH: './config/role-mappings.json',
  DB_PATH: './bot.sqlite',
});

const find = (findings: ReturnType<typeof diagnose>, variable: string) =>
  findings.find((f) => f.variable === variable);

describe('diagnose', () => {
  it('valid environment → no findings', () => {
    expect(diagnose(validEnv())).toEqual([]);
  });

  it('missing required var → one error naming it', () => {
    const env = validEnv();
    delete env.ANDAMIO_API_KEY;
    const f = find(diagnose(env), 'ANDAMIO_API_KEY');
    expect(f?.level).toBe('error');
    expect(f?.message).toMatch(/missing or empty/i);
  });

  it('malformed base URL → error', () => {
    const env = validEnv();
    env.BOT_CALLBACK_BASE_URL = 'not-a-url';
    const f = find(diagnose(env), 'BOT_CALLBACK_BASE_URL');
    expect(f?.level).toBe('error');
    expect(f?.message).toMatch(/not a valid url/i);
  });

  it('trailing slash on a base URL → error', () => {
    const env = validEnv();
    env.ANDAMIO_API_BASE_URL = 'https://api.test/';
    const f = find(diagnose(env), 'ANDAMIO_API_BASE_URL');
    expect(f?.level).toBe('error');
    expect(f?.message).toMatch(/trailing slash/i);
  });

  it('non-https callback → error; non-https other base URL → warn', () => {
    const env = validEnv();
    env.BOT_CALLBACK_BASE_URL = 'http://bot.test';
    env.ANDAMIO_API_BASE_URL = 'http://api.test';
    const findings = diagnose(env);
    expect(find(findings, 'BOT_CALLBACK_BASE_URL')?.level).toBe('error');
    expect(find(findings, 'ANDAMIO_API_BASE_URL')?.level).toBe('warn');
  });

  it('role-mappings file missing → error', () => {
    const env = validEnv();
    env.ROLE_MAPPINGS_PATH = './does-not-exist.json';
    const f = find(diagnose(env), 'ROLE_MAPPINGS_PATH');
    expect(f?.level).toBe('error');
    expect(f?.message).toMatch(/no file found/i);
  });

  it('invalid role-mappings file → error carrying the validation reason', () => {
    const tmp = path.join(os.tmpdir(), `doctor-bad-mappings-${process.pid}.json`);
    fs.writeFileSync(tmp, '{ not an array }');
    try {
      const env = validEnv();
      env.ROLE_MAPPINGS_PATH = tmp;
      const f = find(diagnose(env), 'ROLE_MAPPINGS_PATH');
      expect(f?.level).toBe('error');
      expect(f?.message).toMatch(/invalid role-mappings/i);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('COURSE_DISPLAY_NAMES: object ok, array/non-JSON error, unset ok', () => {
    const ok = validEnv();
    ok.COURSE_DISPLAY_NAMES = '{"c1":"One"}';
    expect(find(diagnose(ok), 'COURSE_DISPLAY_NAMES')).toBeUndefined();

    const bad = validEnv();
    bad.COURSE_DISPLAY_NAMES = '["a","b"]';
    expect(find(diagnose(bad), 'COURSE_DISPLAY_NAMES')?.level).toBe('error');

    expect(find(diagnose(validEnv()), 'COURSE_DISPLAY_NAMES')).toBeUndefined();
  });

  it('SHOW_ALL_COURSES: true/false ok, other → warn', () => {
    const good = validEnv();
    good.SHOW_ALL_COURSES = 'true';
    expect(find(diagnose(good), 'SHOW_ALL_COURSES')).toBeUndefined();

    const odd = validEnv();
    odd.SHOW_ALL_COURSES = 'maybe';
    expect(find(diagnose(odd), 'SHOW_ALL_COURSES')?.level).toBe('warn');
  });

  it('never echoes a secret value in any finding message', () => {
    const env = validEnv();
    const secret = 'ant_mn_TOP-SECRET-DO-NOT-LEAK';
    env.ANDAMIO_API_KEY = secret;
    // Introduce a couple of unrelated problems so findings exist.
    env.BOT_CALLBACK_BASE_URL = 'nope';
    delete env.DISCORD_TOKEN;
    const messages = diagnose(env).map((f) => f.message).join(' | ');
    expect(messages).not.toContain(secret);
    expect(messages).not.toContain('nope'); // URL value not echoed either
  });
});
