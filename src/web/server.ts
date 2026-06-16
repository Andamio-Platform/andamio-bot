import * as http from 'http';

import type { Db } from '../db/index';
import { consumePending, storeLink } from '../andamio/login';
import { reevaluateMember } from '../gating/triggers';

/** Re-evaluation hook fired after a successful link (U5 makes it real). */
export type ReevaluateHook = (discordId: string) => void | Promise<void>;

export interface CallbackServerOptions {
  db: Db;
  /** Fired after a link is stored. Defaults to the gating no-op. */
  reevaluate?: ReevaluateHook;
}

function htmlPage(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title>` +
    `<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;` +
    `margin:4rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a}` +
    `h1{font-size:1.4rem}code{background:#f0f0f0;padding:.1em .3em;border-radius:.2em}</style>` +
    `</head><body><h1>${title}</h1>${body}</body></html>`
  );
}

/**
 * Render a `GET /callback` request to an HTTP status + HTML body.
 *
 * Pure and synchronous so it is directly testable; the only side effect is the
 * link write on success. The returned `linkedDiscordId` lets the caller fire
 * the gating re-evaluation hook (which may be async) outside this function.
 */
export function handleCallback(
  db: Db,
  query: URLSearchParams,
): { status: number; html: string; linkedDiscordId?: string } {
  const state = query.get('state') ?? '';
  const alias = query.get('alias') ?? '';
  // The user JWT is persisted: it is the member's `Authorization: Bearer` for
  // authenticated Andamio dashboard reads. user_id is proof only, not stored.
  const jwt = query.get('jwt');

  if (!state) {
    return {
      status: 400,
      html: htmlPage(
        'Login failed',
        `<p>This callback is missing its <code>state</code>. ` +
          `Please return to Discord and run <code>/login</code> again.</p>`,
      ),
    };
  }

  const result = consumePending(db, state);
  if (!result.ok) {
    // Unknown covers both "never issued" and "already consumed" (replay).
    const reason =
      result.error === 'expired'
        ? 'This login link has expired.'
        : 'This login link is invalid or has already been used.';
    return {
      status: 400,
      html: htmlPage(
        'Login failed',
        `<p>${reason} Please return to Discord and run <code>/login</code> again.</p>`,
      ),
    };
  }

  if (!alias) {
    // Valid state, but the user has no access-token alias. Do not write a
    // partial link — the pending row was already consumed above, so the user
    // simply re-runs /login after obtaining an access token.
    return {
      status: 400,
      html: htmlPage(
        'No access token found',
        `<p>We proved your identity, but your account has no Andamio access ` +
          `token alias yet, so there is nothing to link. Once you have an ` +
          `access token, return to Discord and run <code>/login</code> again.</p>`,
      ),
    };
  }

  storeLink(db, result.pending.discord_id, alias, jwt);

  return {
    status: 200,
    linkedDiscordId: result.pending.discord_id,
    html: htmlPage(
      'You are connected',
      `<p>Your Discord account is now linked to Andamio alias ` +
        `<code>${escapeHtml(alias)}</code>.</p>` +
        `<p>You can close this tab and return to Discord.</p>`,
    ),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Create (but do not start) the HTTP server exposing `GET /callback`.
 * Any other path/method returns 404.
 */
export function createCallbackServer(opts: CallbackServerOptions): http.Server {
  const reevaluate: ReevaluateHook = opts.reevaluate ?? reevaluateMember;

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('Not found', '<p>Nothing here.</p>'));
      return;
    }

    const { status, html, linkedDiscordId } = handleCallback(
      opts.db,
      url.searchParams,
    );

    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);

    if (linkedDiscordId) {
      // Fire-and-forget; failures must not break the user's success page.
      Promise.resolve(reevaluate(linkedDiscordId)).catch((err) =>
        console.error('Gating re-evaluation failed:', err),
      );
    }
  });
}

/** Create and start the callback server on `port`. */
export function startCallbackServer(
  opts: CallbackServerOptions,
  port: number,
): http.Server {
  const server = createCallbackServer(opts);
  server.listen(port, () => {
    console.log(`Callback web server listening on :${port}`);
  });
  return server;
}
