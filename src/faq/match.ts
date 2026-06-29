/**
 * FAQ matching + answer resolution — the pure logic behind `/faq` autocomplete
 * and answer lookup. No Discord types here so it is trivially unit-testable.
 *
 * `rankFaqEntries` turns a focused query into the choice list Discord shows:
 * case-insensitive substring matches over each entry's `question` and `aliases`,
 * with prefix matches ranked first, capped at Discord's hard 25-choice limit.
 * `resolveAnswer` looks an entry up by its stable `id` (the autocomplete value).
 */

import { type FaqEntry } from './config';

/** Discord's hard cap on autocomplete choices per response. */
export const MAX_CHOICES = 25;

/** Discord's max length for an autocomplete choice `name`. */
const MAX_CHOICE_NAME_LEN = 100;

/** One autocomplete choice: `name` is shown, `value` (the id) is submitted. */
export interface FaqChoice {
  name: string;
  value: string;
}

/** Clamp a display name to Discord's 100-char limit (defensive). */
function clampName(name: string): string {
  return name.length <= MAX_CHOICE_NAME_LEN
    ? name
    : `${name.slice(0, MAX_CHOICE_NAME_LEN - 1)}…`;
}

/**
 * Rank `entries` against `query` for autocomplete. Returns at most `limit`
 * (default {@link MAX_CHOICES}) choices as `{ name: question, value: id }`.
 *
 * - An empty/whitespace query returns all entries in config order (capped).
 * - Otherwise, an entry matches when the query is a case-insensitive substring
 *   of its `question` or any `alias`. Entries whose `question` *starts with* the
 *   query rank first; remaining `question` substring matches next; alias-only
 *   matches last. Ties hold config order (stable), so the result is
 *   deterministic.
 */
export function rankFaqEntries(
  entries: FaqEntry[],
  query: string,
  limit: number = MAX_CHOICES,
): FaqChoice[] {
  const q = query.trim().toLowerCase();

  const toChoice = (e: FaqEntry): FaqChoice => ({
    name: clampName(e.question),
    value: e.id,
  });

  if (q === '') {
    return entries.slice(0, limit).map(toChoice);
  }

  // Tier each match so prefix > question-substring > alias-only, preserving
  // config order within a tier via the stable index.
  const ranked: { entry: FaqEntry; tier: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    const question = entry.question.toLowerCase();
    if (question.startsWith(q)) {
      ranked.push({ entry, tier: 0, index });
    } else if (question.includes(q)) {
      ranked.push({ entry, tier: 1, index });
    } else if ((entry.aliases ?? []).some((a) => a.toLowerCase().includes(q))) {
      ranked.push({ entry, tier: 2, index });
    }
  });

  ranked.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return ranked.slice(0, limit).map((r) => toChoice(r.entry));
}

/** Resolve an entry by its stable `id` (the autocomplete value). */
export function resolveAnswer(
  entries: FaqEntry[],
  id: string,
): FaqEntry | undefined {
  return entries.find((e) => e.id === id);
}
