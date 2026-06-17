# Deploy anywhere

The bot is a standard Docker container. Any host that can run a container works.
Railway is shown below as one worked example, but it is just one option.

## The portable contract

Wherever you run it, the bot needs four things:

1. **Environment variables.** All the required vars (see `.env.example`).
2. **A persistent volume mounted at `/app/data`.** The SQLite database there
   holds each member's `discord_id` to alias link and their login token. If you
   lose it, every member has to `/login` again. Set `DB_PATH=./data/bot.sqlite`
   so it lands on the mounted volume.
3. **A public HTTPS URL** routed to the container. The bot serves the OAuth
   callback at `<url>/callback`, so it must be reachable from a member's browser
   over HTTPS. Set `BOT_CALLBACK_BASE_URL` to this URL (no trailing slash).
4. **The host's injected `PORT`.** The bot listens on `process.env.PORT` and
   falls back to 3000, so most platforms work with no extra config. Do not set
   `PORT` yourself if your host injects it.

Slash commands register themselves on boot, so deploying is all it takes; there
is no separate command-registration step.

## Secrets: inject, never commit

`ANDAMIO_API_KEY` and `DISCORD_TOKEN` are secrets. Set them through your host's
secret or variable store so they are injected at runtime. **Never** put them in
a committed file or a Docker build argument. This repo is a public template, so a
secret committed to a fork would be exposed to everyone.

Everything else (`role-mappings.json`, `COURSE_DISPLAY_NAMES`) is config, not a
secret, and is fine to commit.

## Railway (one worked example)

1. New project, deploy from this GitHub repo. Railway detects the `Dockerfile`.
2. Add a **Volume**, mount path `/app/data`. (Configure persistence here in the
   dashboard, not with a `VOLUME` line in the Dockerfile, which Railway rejects.)
3. Set the environment **Variables**: all the required vars. Put
   `ANDAMIO_API_KEY` and `DISCORD_TOKEN` here as Variables (injected at runtime),
   not in any committed file. Do **not** set `PORT`; Railway injects it.
4. Settings > Networking > **Generate Domain**, copy the `https://…up.railway.app`
   URL.
5. Set `BOT_CALLBACK_BASE_URL` to that URL (no trailing slash) and redeploy.

## Other hosts

Fly, Render, a VPS with Docker, or anything else that runs a container works the
same way: provide the env vars, mount a volume at `/app/data`, expose the
container over HTTPS, and let the host set `PORT`. The four requirements above
are the whole contract.

## One cross-system step

Whatever host you pick, `/login` will not complete until your
`BOT_CALLBACK_BASE_URL` origin is added to the Andamio app's
`ALLOWED_BOT_CALLBACK_ORIGINS` allowlist. That happens on the Andamio side, not
yours, and only after you know your URL. See
[QUICKSTART.md](./QUICKSTART.md#5-register-your-callback-origin-with-andamio-do-not-skip).
