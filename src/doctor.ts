/**
 * Env "doctor" — pre-deploy validation of the variables a deployer was handed.
 *
 * Run with `npm run doctor`. It checks that every required variable is present
 * and well-shaped, reporting ALL problems at once (unlike `loadConfig`, which
 * fails fast on the first). It reuses the shared validators from `config.ts` and
 * `gating/mappings.ts` so it can never disagree with the boot path.
 *
 * Two hard rules:
 *   - It validates SHAPE, not LIVENESS — a well-formed but wrong API host or a
 *     stale credential passes here and only fails at runtime. The docs say so.
 *   - **Secret safety:** messages name only the variable and a shape-level
 *     problem — they NEVER echo a variable's value, so a malformed-but-present
 *     `ANDAMIO_API_KEY` is never leaked into a terminal, CI, or host log.
 *
 * No network call, no Discord/Andamio request, no Andamio CLI or account needed.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  REQUIRED_VARS,
  URL_VARS,
  isPresent,
  urlProblem,
  hasTrailingSlash,
} from './config';
import { loadMappings } from './gating/mappings';

export type Level = 'warn' | 'error';

/** One problem found with the environment. Never carries a variable's value. */
export interface Finding {
  level: Level;
  variable: string;
  message: string;
}

/**
 * Inspect `env` and return every problem found (empty array = all good).
 * Pure and synchronous: only reads env + the local role-mappings file.
 */
export function diagnose(env: NodeJS.ProcessEnv = process.env): Finding[] {
  const findings: Finding[] = [];

  // 1. Required vars present.
  for (const name of REQUIRED_VARS) {
    if (!isPresent(env[name])) {
      findings.push({
        level: 'error',
        variable: name,
        message: 'required, but missing or empty',
      });
    }
  }

  // 2. Base URLs: valid, https, no trailing slash. Skip if missing (reported above).
  for (const name of URL_VARS) {
    const value = env[name];
    if (!isPresent(value)) continue;
    const problem = urlProblem(value);
    if (problem) {
      findings.push({ level: 'error', variable: name, message: `${problem}` });
      continue;
    }
    if (!value.toLowerCase().startsWith('https://')) {
      findings.push({
        // The bot's public callback MUST be https; the others should be.
        level: name === 'BOT_CALLBACK_BASE_URL' ? 'error' : 'warn',
        variable: name,
        message: 'should use https',
      });
    }
    if (hasTrailingSlash(value)) {
      findings.push({
        level: 'error',
        variable: name,
        message: 'must not end with a trailing slash',
      });
    }
  }

  // 3. Role-mappings file exists and validates.
  const mappingsPath = env.ROLE_MAPPINGS_PATH;
  if (isPresent(mappingsPath)) {
    if (!fs.existsSync(mappingsPath)) {
      findings.push({
        level: 'error',
        variable: 'ROLE_MAPPINGS_PATH',
        message: 'no file found at the configured path',
      });
    } else {
      try {
        loadMappings(mappingsPath);
      } catch (err) {
        findings.push({
          level: 'error',
          variable: 'ROLE_MAPPINGS_PATH',
          message: `invalid role-mappings file: ${(err as Error).message}`,
        });
      }
    }
  }

  // 4. COURSE_DISPLAY_NAMES, if set, must be a JSON object.
  const cdn = env.COURSE_DISPLAY_NAMES;
  if (isPresent(cdn)) {
    let ok = false;
    try {
      const parsed: unknown = JSON.parse(cdn);
      ok = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    } catch {
      ok = false;
    }
    if (!ok) {
      findings.push({
        level: 'error',
        variable: 'COURSE_DISPLAY_NAMES',
        message: 'must be a JSON object of course_id → display name',
      });
    }
  }

  // 5. SHOW_ALL_COURSES, if set, must be a boolean string.
  const sac = env.SHOW_ALL_COURSES;
  if (isPresent(sac)) {
    const norm = sac.trim().toLowerCase();
    if (norm !== 'true' && norm !== 'false') {
      findings.push({
        level: 'warn',
        variable: 'SHOW_ALL_COURSES',
        message: 'unrecognized value; expected true or false (treated as false)',
      });
    }
  }

  // 6. DB_PATH parent directory writable (warn — the file is created on boot).
  const dbPath = env.DB_PATH;
  if (isPresent(dbPath)) {
    const dir = path.dirname(dbPath);
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      findings.push({
        level: 'warn',
        variable: 'DB_PATH',
        message: 'parent directory may not be writable',
      });
    }
  }

  return findings;
}

/** Render findings as printable lines (icon + variable + message). */
export function formatFindings(findings: Finding[]): string[] {
  const icon: Record<Level, string> = { warn: '⚠', error: '✗' };
  return findings.map((f) => `${icon[f.level]} ${f.variable}: ${f.message}`);
}

/** CLI entry: print the checklist and exit non-zero if any error was found. */
function runCli(): void {
  const findings = diagnose();
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');

  if (findings.length === 0) {
    console.log('✓ Environment looks good. (Shape only — this does not check that hosts/keys actually work.)');
    return;
  }

  for (const line of formatFindings(findings)) console.log(line);

  if (errors.length > 0) {
    console.error(
      `\n${errors.length} error(s) must be fixed before deploying` +
        (warns.length ? ` (${warns.length} warning(s)).` : '.'),
    );
    process.exit(1);
  }
  console.log(`\nReady, with ${warns.length} warning(s).`);
}

// Run as a CLI only when executed directly (not when imported by tests).
if (require.main === module) {
  runCli();
}
