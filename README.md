# Andamio Discord Bot

A reusable TypeScript Discord bot that brings Andamio on-chain credentials into
a Discord community. A member proves they control an Andamio access-token alias
with `/login`, sees their earned credentials inline with `/credentials`, and is
automatically granted Discord roles based on those credentials.

It does what a plain wallet-verification bot cannot: it reads Andamio
credentials (publicly, by alias, from andamioscan) and gates Discord roles on
them — **with no wallet handling by adopters.** The bot never touches a wallet,
seed phrase, or private key. Login is delegated to the hosted Andamio app; the
bot only ever stores a Discord-id ↔ alias link and reads credentials by alias.

This repo is a **template**: clone it, set your config, and run it against your
own Discord guild and an Andamio (preprod) deployment with **no code changes**.

## What the bot does

| Command | What it does |
|---------|--------------|
| `/login` | Replies with an ephemeral link to the Andamio hosted login. The member authenticates in their browser; the app redirects the result back to the bot, which stores `discord_id ↔ alias`. Re-running it re-links. |
| `/logout` | Unlinks the member's Discord account from their Andamio alias. |
| `/credentials` | Shows the member their connection status, alias, and earned credentials grouped by course (ephemeral). Also lists any gated credentials they have not yet earned, with a link to earn each (when `earn_url` is set in the mappings). |
| `/refresh` | Re-checks the member's Andamio credentials and updates their roles on demand. |

**How it works**

- `/login` reuses the Andamio app's hosted CLI auth flow (`/auth/cli`) to prove
  a Discord member controls an access-token alias, then stores
  `discord_id ↔ alias`. No wallet logic lives in this repo.
- Reads run on andamioscan's public `GET /api/v2/users/{alias}/state` — no JWT,
  no API key.
- Configurable rules (`role-mappings.json`) map earned credentials to Discord
  roles. The bot grants and revokes **only** the roles it manages.
- Roles re-evaluate on `/login`, `/refresh`, when a member (re)joins the guild,
  and on a periodic background sweep.

The datastore is SQLite (`better-sqlite3`) — file-based, zero-ops.

## Prerequisites

- **Node.js 18+** (better-sqlite3 ships prebuilt binaries for current LTS).
- **A Discord application + bot** (created below).
- **An Andamio app + andamioscan deployment** to point at (preprod by default).
- **A public https URL** for the bot to receive the login callback (so the
  hosted app can redirect the auth result back). Required for `/login` to
  complete; any tunnel or host that gives you a stable https origin works.

## 1. Create the Discord application + bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and **New Application**.
2. **General Information** — copy the **Application ID** → `DISCORD_APP_ID`.
3. **Bot** — **Reset Token**, copy it → `DISCORD_TOKEN`. (Treat it like a
   password; never commit it.)
4. **Bot > Privileged Gateway Intents** — enable **Server Members Intent**
   (the bot uses `GuildMembers` to fetch members for role evaluation).
5. **Invite the bot** to your server with the right scopes and permission.
   Use the OAuth2 URL Generator (OAuth2 > URL Generator), or build the URL
   directly:
   - **Scopes:** `bot` and `applications.commands`
   - **Bot permission:** **Manage Roles**

   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=268435456
   ```
   (`268435456` is the **Manage Roles** permission bit. Replace `YOUR_APP_ID`.)
6. In your server, get the **Server ID** (enable Developer Mode, then right-click
   the server > Copy Server ID) → `GUILD_ID`.

## 2. Configure the environment

Copy the template and fill it in:

```
cp .env.example .env
```

Every variable, what it's for, and an example value:

| Variable | Required | Purpose | Example |
|----------|----------|---------|---------|
| `DISCORD_TOKEN` | yes | Discord bot token | `MTspeyJ...` (from Bot > Reset Token) |
| `DISCORD_APP_ID` | yes | Discord application (client) id | `123456789012345678` |
| `GUILD_ID` | yes | Discord guild (server) id the bot operates in | `987654321098765432` |
| `SCAN_BASE_URL` | yes | andamioscan base URL — public read API (`/api/v2/users/{alias}/state`), no trailing slash | `https://preprod.api.andamio.io` *(preprod — confirm exact host)* |
| `APP_LOGIN_BASE_URL` | yes | Andamio app base URL hosting the CLI login flow (`/auth/cli`), no trailing slash | `https://preprod-app.andamio.io` *(preprod — confirm exact host)* |
| `BOT_CALLBACK_BASE_URL` | yes | Public https base URL where the bot receives the auth callback (`GET <this>/callback`); its origin must be in the app's allowlist (see Operating notes), no trailing slash | `https://your-bot-host.example.com` |
| `ROLE_MAPPINGS_PATH` | yes | Path to the role-mappings JSON config | `./config/role-mappings.json` |
| `DB_PATH` | yes | Path to the SQLite database file (created on first run) | `./data/bot.sqlite` |
| `COURSE_DISPLAY_NAMES` | no | `course_id → display name` map (JSON object) for `/credentials`; falls back to raw course ids if unset/malformed. Default `{}` | `{"course_cardano_101":"Cardano 101"}` |
| `GATING_SWEEP_INTERVAL_MS` | no | Interval (ms) for the periodic role-sweep over connected members. Positive number; default 15 min | `900000` |
| `PORT` | no | Port the callback web server listens on. Default 3000 | `3000` |

> The base URLs above use **preprod** placeholders. `SCAN_BASE_URL` and
> `APP_LOGIN_BASE_URL` point at Andamio preprod — confirm the exact hosts for
> your deployment (the known API host is `preprod.api.andamio.io`).
> `BOT_CALLBACK_BASE_URL` is **your** bot's public origin.

## 3. Author your role mappings

`role-mappings.json` (path set by `ROLE_MAPPINGS_PATH`) is a JSON **array** of
rules. Each rule grants one `role_id` when its credential condition is met. The
set of `role_id`s across all rules is the bot's **managed set** — the only roles
it will ever add or remove.

Start from the example:

```
cp config/role-mappings.example.json config/role-mappings.json
```

There are three rule types — one documented example of each:

```json
[
  {
    "type": "enrolled",
    "course_id": "course_cardano_101",
    "role_id": "111111111111111111"
  },
  {
    "type": "course-complete",
    "course_id": "course_cardano_101",
    "role_id": "222222222222222222"
  },
  {
    "type": "credential",
    "course_id": "course_cardano_101",
    "slt_hash": "slt_hash_intro_to_plutus",
    "role_id": "333333333333333333",
    "label": "Andamio Developer",
    "earn_url": "https://app.andamio.io/courses/course_cardano_101"
  }
]
```

- **`enrolled`** — grant `role_id` when the member is enrolled in (or has
  completed) `course_id`.
- **`course-complete`** — grant `role_id` when the member has **completed**
  `course_id`.
- **`credential`** — grant `role_id` when the member has completed `course_id`
  **and** holds the specific credential `slt_hash`. `slt_hash` is **required**
  for this type.

Two **optional** fields turn an unmet gate into a call to action (they never
affect gating):

- **`label`** — a human name for what the rule grants (e.g. `"Andamio
  Developer"`). Used in the `/credentials` earn-it hint; falls back to the
  course display name when absent.
- **`earn_url`** — an http(s) URL to earn what the rule requires. When set,
  `/credentials` shows it to a connected member who does **not** yet satisfy the
  rule, so non-holders see exactly how to unlock the gated channel. De-duped by
  URL across rules.

Get the `role_id`s from your server (enable Developer Mode, right-click a role
> Copy Role ID). The config is **strictly validated at startup** — a missing
`course_id`/`role_id`, an unknown `type`, a `credential` rule without
`slt_hash`, a non-http(s) `earn_url`, or an empty `label` fails fast with a
message naming the offending rule.

See `config/role-mappings.example.json` in this repo for the canonical example.

## 4. Install, build, deploy commands, run

```
npm install          # install dependencies
npm run build        # compile TypeScript to dist/
npm run deploy       # register the slash commands with your guild (deploy-commands)
npm start            # run the bot (node dist/index.js)
```

- `npm run deploy` runs `src/deploy-commands.ts`, registering `/login`,
  `/logout`, `/credentials`, and `/refresh` as **guild** commands for your
  `GUILD_ID` (instant, vs. global commands which take up to an hour). Re-run it
  whenever the command definitions change.
- `npm start` boots the bot and the callback web server together. On a clean
  start it logs the logged-in tag, how many roles/rules gating manages, and the
  sweep interval.

For local development: `npm run dev` runs from source (ts-node) and
`npm run watch` reloads on change. `npm test` runs the suite (vitest);
`npm run lint` runs eslint.

## Operating notes

- **Role ordering — the bot's role must sit ABOVE the roles it manages.**
  Discord only lets a bot add/remove roles that are **lower** than its own
  highest role in the server's role list (Server Settings > Roles). Drag the
  bot's role above every role named in `role-mappings.json`, or grants/revokes
  will silently fail with a permissions error.
- **The bot only ever touches roles it manages.** The managed set is exactly the
  `role_id`s named in your mappings. The evaluator computes a desired-vs-current
  diff scoped to that set, so it never adds or removes any other role a member
  holds. Roles not in the mappings are invisible to the bot.
- **`/login` requires an app-side allowlist change.** The Andamio app's hosted
  login (`/auth/cli`) only redirects the auth result to allowlisted origins. The
  app must be deployed with **`ALLOWED_BOT_CALLBACK_ORIGINS`** including this
  bot's `BOT_CALLBACK_BASE_URL` **origin** (scheme + host + port), or the
  callback is rejected and `/login` never completes. This is a one-line,
  env-gated allowlist entry on the **app side** (it does not broaden to arbitrary
  https — it matches your explicit origin). Coordinate this with whoever operates
  the Andamio app deployment before testing `/login` end-to-end.
- **Unconnected members get no credential roles.** A member must `/login` to earn
  any mapped role; if they `/logout` (or were never linked), the bot removes any
  managed roles they hold on the next evaluation.
- **Re-evaluation timing.** Roles update on `/login`, on `/refresh` (on demand),
  when a member rejoins, and on the periodic sweep (`GATING_SWEEP_INTERVAL_MS`,
  default 15 min). A member who crosses a threshold sees the role on their next
  `/refresh` or the next sweep — no re-login needed.

## Scripts

```
npm run build    # compile TypeScript to dist/
npm start        # run the compiled bot (node dist/index.js)
npm run deploy   # register slash commands with the guild
npm run dev      # run the bot from source (ts-node)
npm run watch    # run from source, reloading on change
npm test         # run the test suite (vitest)
npm run lint     # eslint
```

## License

MIT
