# Andamio Bot

A reusable TypeScript Discord bot that brings Andamio on-chain credentials into a
Discord community. A member proves they control an Andamio alias with `/login`,
sees their earned credentials with `/credentials`, and is automatically granted
Discord roles based on what they hold.

It does what a plain wallet-verification bot cannot: it reads each member's
Andamio credentials from the authenticated Andamio API and gates Discord roles on
them, **with no wallet handling by adopters.** The bot never touches a wallet,
seed phrase, or private key. Login is delegated to the hosted Andamio app; the
bot stores a `discord_id` to alias link plus the member's login token and reads
that member's dashboard with it.

**What you do NOT need:** no wallet, no ADA, no signing, no Cardano knowledge, and
no Andamio CLI or account to deploy. This repo is a template: use it as-is against
your own Discord server and an Andamio deployment with no code changes.

## Pick your path

- **You were handed a list of variables and want to deploy?** Start with
  [docs/QUICKSTART.md](./docs/QUICKSTART.md). You do not need an Andamio account.
- **You want to wire up your own gating?** See
  [docs/BUILDER-GUIDE.md](./docs/BUILDER-GUIDE.md) (uses the Andamio CLI to find
  your `course_id` and `slt_hash` fast). A team that starts on the quickstart and
  later wants to change what it gates on grows into this guide.
- **Just want to understand it?** Read "How it works" below, and
  [docs/CONCEPTS.md](./docs/CONCEPTS.md) for the few terms involved and what each
  config value is.

Other guides: [deploy anywhere](./docs/DEPLOY.md) ·
[troubleshooting](./docs/TROUBLESHOOTING.md).

## What the bot does

| Command | What it does |
|---------|--------------|
| `/login` | Replies with an ephemeral link to the Andamio hosted login. The member authenticates in their browser; the app redirects the result back to the bot, which stores `discord_id` to alias. Re-running it re-links. |
| `/logout` | Unlinks the member's Discord account from their Andamio alias. |
| `/credentials` | Shows the member the Andamio credentials they have earned (ephemeral). Personal inventory only. Curated by `COURSE_DISPLAY_NAMES` (see Curated display below). |
| `/available` | Lists the credentials this server gates channels on, each marked held or not, with a link to earn the ones they lack. Works before connecting. |
| `/check` | Re-reads the member's credentials live, updates their roles, and reports which gated credentials they hold and still need. One command to refresh roles and see where you stand. |
| `/faq` | Shows a get-started guide (connect, see what you hold, check access, browse what unlocks channels), plus a config-built list of what this server gates on. Local-only — renders identically before connecting and when Andamio is down. |

## Moderator commands (deny-list)

Gating only ever **grants** roles a member's credentials earn. These three
commands let a moderator **withhold** a gated role from a specific member even
when they hold the credential — and the block **survives every periodic sweep**
(the sweep recomputes desired roles each tick and subtracts active denials, so a
manual Discord role removal alone would not stick, but a denial does). Use it to
block a member from a channel without revoking their credential. Lift it with
`/allow`.

| Command | What it does |
|---------|--------------|
| `/deny <member> [role] [reason]` | Blocks `member` from a gated `role` (omit `role` to block **all** gated roles) even if they hold the credential. The block is recorded immediately and applies on the next login if the member isn't connected. `reason` shows in `/denials`. |
| `/allow <member> [role]` | Lifts a block. Name a `role` to lift just that one, or omit it to lift **all** blocks on the member. Any role they've earned is then restored. |
| `/denials [member]` | Lists active blocks (who, which role or "all gated roles", reason, who set it). Omit `member` for the whole server. |

**Who can use them.** A member with Discord's native **Manage Roles** permission,
or — when `MOD_ROLE_ID` is set — anyone holding that role. The check is enforced
server-side inside each command, not via Discord's command-visibility defaults
alone. `MOD_ROLE_ID` is optional; absent means "Manage Roles only."

## How it works

- `/login` reuses the Andamio app's hosted login flow (`/auth/cli`) to prove a
  Discord member controls an alias, then stores `discord_id` to alias plus the
  member's login token. No wallet logic lives in this repo.
- Reads run on the authenticated Andamio API, `POST /api/v2/user/dashboard`, with
  two headers: `X-API-Key` (the operator key, `ANDAMIO_API_KEY`) authenticates the
  bot, and `Authorization: Bearer <member token>` selects whose dashboard to read.
- Configurable rules (`config/role-mappings.json`) map earned credentials to
  Discord roles. The bot grants and revokes **only** the roles it manages.
- Roles re-evaluate on `/login`, on `/check`, when a member rejoins, and on a
  periodic sweep. Login tokens expire and cannot be refreshed unattended: a member
  whose token lapsed keeps their current roles until they reconnect (the bot shows
  a one-click **Connect** button on `/credentials`, `/available`, and `/check`).

The datastore is SQLite (file-based, zero-ops). Commands register themselves on
boot, so a deploy is all it takes to add, rename, or remove one.

## Configure credential gating (`role-mappings.json`)

`config/role-mappings.json` decides **which Andamio credential unlocks which
Discord role**. It is committed on purpose: it is config, not a secret. The
committed file ships with Andamio's own live rule as a working example; replace
its values with yours. `config/role-mappings.example.json` is an annotated
reference showing all three rule types.

| Field | Required | What it is |
|---|---|---|
| `type` | yes | `enrolled`, `course-complete`, or `credential` |
| `course_id` | yes | The Andamio course the rule keys on |
| `slt_hash` | for `credential` | The specific credential within the course |
| `role_id` | yes | The Discord role to grant (right-click the role > Copy Role ID) |
| `label` | no | Human name for the gate, shown in `/available` and `/check` |
| `earn_url` | no | Link to earn what the rule requires, shown to non-holders |

The set of all `role_id`s is the bot's **managed set**: the only roles it ever
adds or removes. It never touches a moderator, booster, or other role. The config
is strictly validated at startup and fails fast, naming the offending rule.

Where do `course_id` and `slt_hash` come from? Andamio provides them, or you find
them yourself with the [builder guide](./docs/BUILDER-GUIDE.md).

## Curated display

`COURSE_DISPLAY_NAMES` (a JSON object of `course_id` to friendly name) does two
jobs: it labels courses, and it decides which courses the bot shows. With a
non-empty map, only listed courses appear in `/credentials` (and `/available` and
`/check`); unlisted courses are hidden, so a focused server is not cluttered with
a member's unrelated credentials. Escapes: an empty or unset map shows everything,
and `SHOW_ALL_COURSES=true` forces all courses even with a map. Credentials your
server gates on are always shown. See the
[builder guide](./docs/BUILDER-GUIDE.md#2-build-a-curated-course_display_names).

## Environment

Copy `.env.example` to `.env` and fill it in (run `npm run doctor` to validate).
[docs/CONCEPTS.md](./docs/CONCEPTS.md#where-each-value-comes-from) maps every value
to its source. Only `ANDAMIO_API_KEY` and `DISCORD_TOKEN` are secrets: set them
through your host's secret store, never in a committed file. The full list with
purposes and examples is in `.env.example`.

## Operating notes

- **Role ordering.** Discord only lets a bot manage roles **below** its own
  highest role. Drag the bot's role above every role in `role-mappings.json`, or
  grants fail silently.
- **`/login` needs an app-side allowlist entry.** The bot's `BOT_CALLBACK_BASE_URL`
  origin must be in the Andamio app's `ALLOWED_BOT_CALLBACK_ORIGINS`. This is a
  cross-system step on the Andamio side, done after you know your URL. See
  [QUICKSTART step 5](./docs/QUICKSTART.md#5-register-your-callback-origin-with-andamio-do-not-skip).
- **The SQLite store holds tokens.** Keep `DB_PATH` on a private, persistent
  volume and never commit `data/`. Losing it just forces everyone to `/login`
  again; exposing it leaks bearer tokens.

More failure modes and fixes: [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md).

## Run

```
npm install
npm run build
npm start
```

`npm run dev` runs from source; `npm run watch` reloads on change; `npm test`
runs the suite; `npm run lint` runs eslint; `npm run doctor` validates your env.

## Use this as a template

This repo is a GitHub template: use "Use this template" to start your own, or fork
it. Deploy guidance is in [docs/DEPLOY.md](./docs/DEPLOY.md). Contributions welcome,
see [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) (c) 2026 Andamio.
