/**
 * Discord embed-field helpers.
 *
 * Discord rejects an entire message when any embed field `value` exceeds 1024
 * characters. Several commands build a field value by joining one line per
 * credential or course (`lines.join('\n')`), which is unbounded: a server with
 * many gated credentials, long labels, or long earn URLs can cross 1024 chars
 * and make `interaction.reply` throw — turning a best-effort render into a hard
 * command failure. `fitFieldValue` keeps a list inside the limit instead.
 */

/** Discord's hard limit on an embed field `value` length. */
export const FIELD_VALUE_LIMIT = 1024;

/**
 * Join `lines` into an embed field value that never exceeds the 1024-char limit.
 *
 * Keeps as many whole lines as fit alongside a trailing `…and N more` marker; if
 * a single line is itself longer than the limit, it is hard-truncated with an
 * ellipsis. Returns `''` for an empty list — callers that must not emit an empty
 * field (Discord also rejects empty values) should guard `lines.length` first,
 * exactly as they already do today.
 */
export function fitFieldValue(lines: string[]): string {
  const full = lines.join('\n');
  if (full.length <= FIELD_VALUE_LIMIT) return full;

  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const remaining = lines.length - (i + 1);
    const marker = remaining > 0 ? `\n…and ${remaining} more` : '';
    const candidate = [...kept, lines[i]].join('\n') + marker;
    if (candidate.length > FIELD_VALUE_LIMIT) break;
    kept.push(lines[i]);
  }

  // Even the first line plus its marker overflows: hard-truncate that one line.
  if (kept.length === 0) {
    return lines[0].slice(0, FIELD_VALUE_LIMIT - 1) + '…';
  }

  const dropped = lines.length - kept.length;
  return kept.join('\n') + (dropped > 0 ? `\n…and ${dropped} more` : '');
}
