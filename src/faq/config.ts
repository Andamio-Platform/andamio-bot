/**
 * FAQ Q&A config: parse + validate the optional question/answer entries that
 * power `/faq question:<id>` and its autocomplete.
 *
 * The config is a JSON array of entries read from `FAQ_PATH` (default
 * `config/faq.json`). Each entry is:
 *
 *   - `id`       — stable identifier, used as the autocomplete `value` and the
 *                  answer-lookup key. Renaming a question never breaks lookup.
 *   - `question` — the human-readable prompt shown as the autocomplete label.
 *   - `answer`   — the embed body rendered when the entry is selected (Discord
 *                  markdown ok).
 *   - `aliases`  — optional extra search terms the matcher also checks.
 *
 * Two postures, deliberately different from `loadMappings`:
 *
 *   - A MISSING file (or an absent/empty path) → `[]`, never a throw. `/faq`
 *     then degrades to the static get-started guide exactly as before the Q&A
 *     existed — the command is the safe onboarding fallback even when
 *     unconfigured. (Mirrors `loadCourseDisplayNames`.)
 *   - MALFORMED content (bad JSON, wrong shape, duplicate ids) → throws a typed
 *     error so a caller can catch and fall back, and so the shipped seed is
 *     guarded by a test rather than silently half-loading. (Mirrors
 *     `parseMappings`'s strict, entry-indexed validation.)
 */

import * as fs from 'fs';

/** A single validated FAQ entry. */
export interface FaqEntry {
  /** Stable id — the autocomplete `value` and answer-lookup key. */
  id: string;
  /** Human-readable prompt — the autocomplete display `name`. */
  question: string;
  /** Answer body rendered into the embed (Discord markdown ok). */
  answer: string;
  /** Optional extra search terms the matcher also checks. */
  aliases?: string[];
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Validate a parsed JSON value into {@link FaqEntry}[]. Throws an `Error` with a
 * clear, entry-indexed message on any of: not an array, an entry that is not an
 * object, a missing/empty `id`/`question`/`answer`, an `aliases` that is not an
 * array of non-empty strings, or a duplicate `id` (ids must be unique — they are
 * the answer key, so a collision would make resolution ambiguous).
 */
export function parseFaq(parsed: unknown): FaqEntry[] {
  if (!Array.isArray(parsed)) {
    throw new Error('Invalid FAQ config: expected a JSON array of entries.');
  }

  const entries: FaqEntry[] = [];
  const seenIds = new Set<string>();

  parsed.forEach((raw, i) => {
    const where = `entry #${i}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`Invalid FAQ config: ${where} is not an object.`);
    }
    const e = raw as Record<string, unknown>;

    if (!isNonEmptyString(e.id)) {
      throw new Error(
        `Invalid FAQ config: ${where} is missing a non-empty "id".`,
      );
    }
    if (!isNonEmptyString(e.question)) {
      throw new Error(
        `Invalid FAQ config: ${where} (id "${e.id}") is missing a non-empty ` +
          `"question".`,
      );
    }
    if (!isNonEmptyString(e.answer)) {
      throw new Error(
        `Invalid FAQ config: ${where} (id "${e.id}") is missing a non-empty ` +
          `"answer".`,
      );
    }

    if (e.aliases !== undefined) {
      if (
        !Array.isArray(e.aliases) ||
        !e.aliases.every((a) => isNonEmptyString(a))
      ) {
        throw new Error(
          `Invalid FAQ config: ${where} (id "${e.id}") has an "aliases" that ` +
            `is not an array of non-empty strings.`,
        );
      }
    }

    if (seenIds.has(e.id)) {
      throw new Error(
        `Invalid FAQ config: duplicate id "${e.id}" at ${where} — ids must be ` +
          `unique (they key the answer lookup).`,
      );
    }
    seenIds.add(e.id);

    const entry: FaqEntry = {
      id: e.id,
      question: e.question,
      answer: e.answer,
    };
    if (e.aliases !== undefined) entry.aliases = e.aliases as string[];
    entries.push(entry);
  });

  return entries;
}

/**
 * Read + validate the FAQ file at `filePath`. Returns `[]` when the path is
 * absent/empty or the file does not exist (the degrade-to-static path). Throws
 * (via {@link parseFaq}) only on a file that exists but contains malformed JSON
 * or an invalid shape, so a caller in `/faq` can catch and fall back while the
 * shipped seed stays guarded by a test.
 */
export function loadFaq(filePath: string | undefined): FaqEntry[] {
  if (!isNonEmptyString(filePath)) return [];

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    // A missing file is the "unconfigured" degrade path → empty list. Any other
    // read error (permissions, etc.) also degrades rather than crashing /faq.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `FAQ file at "${filePath}" is not valid JSON: ${(err as Error).message}`,
    );
  }

  return parseFaq(parsed);
}
