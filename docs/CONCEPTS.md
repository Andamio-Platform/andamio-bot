# Concepts: just enough, and what you do NOT need

You can run this bot without knowing anything about Cardano or blockchains. This
page explains the handful of terms you will see, and is honest about which
values you produce yourself versus which ones Andamio hands you.

## What you do NOT need

- **No wallet.** The bot never touches a wallet, seed phrase, or private key.
- **No ADA, no gas, no signing.** Members authenticate in a browser; Andamio
  sponsors anything on-chain.
- **No Cardano knowledge.** The bot only calls Andamio's web API.
- **No Andamio CLI or account** to deploy. (The CLI helps if you want to build
  your own gating later. See [BUILDER-GUIDE.md](./BUILDER-GUIDE.md).)

## The few terms you will meet

- **Andamio Access Token** and **alias.** Each Andamio user has an on-chain
  identity with a short human-readable name (the "alias"). A member proves they
  control theirs by running `/login`. You never handle the token.
- **Credential.** A thing a member earned on-chain by completing course work.
  The bot reads which credentials a member holds and grants Discord roles based
  on that.
- **`course_id` and `slt_hash`.** The two values that identify a specific
  credential: the course it belongs to (`course_id`) and the learning target
  within it (`slt_hash`). You put these into `role-mappings.json` to say "this
  credential unlocks this role." They are long hex strings; you do not memorize
  them, you paste them.
- **Module (and "on-chain" content).** A course is made of modules — each a
  learning target with a lesson and/or an assignment. A module is **published
  (on-chain)** once it has its own top-level `slt_hash`; until then it is still a
  draft and the bot ignores it. `/preview` lists a course's on-chain modules and
  renders a lesson or assignment, and `/progress` shows a member's per-module
  status across them. These are read-only views of public course content and do
  not affect role gating — gating only ever reads earned **credentials**.
- **Operator API key (`ANDAMIO_API_KEY`).** One secret per deployment that lets
  the bot read the Andamio API. This is the one true secret. Treat it like a
  password: never commit it, set it through your host's secret store.
- **Member JWT.** A short-lived token the bot stores after a member logs in, so
  it can read that member's credentials. Handled automatically; expires, and the
  bot prompts the member to reconnect when it does.
- **FAQ Q&A config (`FAQ_PATH`).** A plain JSON file (default `config/faq.json`,
  template in `config/faq.example.json`) of `{id, question, answer, aliases?}`
  entries that power `/faq question:<…>` and its autocomplete. The `id` is the
  stable lookup key (so rewording a question never breaks it); `question` is what
  members see and search; `answer` is the reply. Adding a Q&A is a config edit
  plus a restart — no code change. It is config, not a secret, and safe to
  commit. A missing file just means `/faq` shows its static get-started guide.

## Where each value comes from

Every value the bot needs is one of three kinds:

| Kind | Values | Who produces it |
|---|---|---|
| **You create** (in Discord) | `DISCORD_TOKEN`, `DISCORD_APP_ID`, `GUILD_ID`, and the **role id(s)** you gate on | You, in the Discord Developer Portal and your server |
| **Andamio gives you** | `ANDAMIO_API_KEY`, `ANDAMIO_API_BASE_URL`, `APP_LOGIN_BASE_URL`, and each rule's `course_id` + `slt_hash` (and optionally an `earn_url`) | Andamio (ask in the [Andamio Network Discord](https://discord.gg/andamio) if you do not have these yet) |
| **You choose / your host sets** | `BOT_CALLBACK_BASE_URL` (your bot's public URL, known after you deploy), `ROLE_MAPPINGS_PATH`, `DB_PATH`, `COURSE_DISPLAY_NAMES`, `SHOW_ALL_COURSES`, `MOD_ROLE_ID` (optional moderator role for the deny-list commands), `FAQ_PATH` (optional `/faq` Q&A config), `PORT` | You, or your hosting platform |

The hardest part for a new community is getting the Andamio-side values (the API
key and a credential to gate on). At this stage Andamio provisions those and is
glad to help. Ask in the **Andamio Network Discord** and someone will get you
set up.

## Secrets, in one line

Only `ANDAMIO_API_KEY` and `DISCORD_TOKEN` are secret. They go in your host's
secret store (or your local, gitignored `.env`), never in a committed file.
`role-mappings.json`, `faq.json`, and `COURSE_DISPLAY_NAMES` are config, not
secrets: they hold ids, names, and onboarding copy, and are safe to commit.
