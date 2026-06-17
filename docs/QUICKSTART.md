# Quickstart: deploy with the values you were given

For a team that was handed a list of variables by Andamio and just wants the
gated channel working. No Cardano knowledge, no Andamio CLI, no account needed.
If you do not have your Andamio values yet, see
[CONCEPTS.md](./CONCEPTS.md#where-each-value-comes-from) for what to ask for.

Some values are yours to make (your Discord ids, your bot's URL); the rest
Andamio gives you. [CONCEPTS.md](./CONCEPTS.md#where-each-value-comes-from) maps
every value to its source.

## 1. Set up your Discord side

These steps are all in Discord, not Cardano. Each has a quiet failure mode if
skipped, so check them against [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

1. Create the **role** the bot will grant (e.g. "Andamio Issuer") and the
   **private channel** it unlocks. On the channel, deny `@everyone` *View
   Channel* and allow that role *View Channel*.
2. In the [Developer Portal](https://discord.com/developers/applications),
   create an application, copy the **Application ID** (`DISCORD_APP_ID`) and a
   **Bot Token** (`DISCORD_TOKEN`), and enable **Server Members Intent** (Bot >
   Privileged Gateway Intents).
3. Invite the bot with the `bot` and `applications.commands` scopes and the
   **Manage Roles** permission. In your server, **drag the bot's role above**
   the role it grants, or it cannot assign it.
4. Copy your **Server ID** (`GUILD_ID`) and the **role id** of the role you
   created (enable Developer Mode, right-click to copy ids).

## 2. Fill in your variables

Copy `.env.example` to `.env` and set the values Andamio gave you plus the
Discord ones above. Put the gated role into `config/role-mappings.json` (replace
the example values with your `course_id`, `slt_hash`, and `role_id`). You are
NOT creating a course or minting a credential; those are handed to you.

## 3. Check your variables before deploying

```
npm install
npm run doctor
```

`doctor` validates every variable's shape and lists anything missing or
malformed, all at once, without contacting Discord or Andamio. Fix what it flags
before going further. (It checks shape, not whether a host or key actually
works.)

## 4. Deploy

Deploy the container on any host. See [DEPLOY.md](./DEPLOY.md) for the portable
requirements and a worked Railway example. After deploying you will have a
**public HTTPS URL** for the bot; set that as `BOT_CALLBACK_BASE_URL`. Slash
commands register themselves on boot, so there is no separate registration step.

## 5. Register your callback origin with Andamio (do not skip)

This is a **required, cross-system, one-time** step, and it can only happen
**after** step 4 because you need your bot's URL first.

`/login` sends a member to the Andamio app and the app redirects the result back
to your bot. The app only redirects to **allowlisted** origins, so your bot's
`BOT_CALLBACK_BASE_URL` origin must be added to the Andamio app's
`ALLOWED_BOT_CALLBACK_ORIGINS`. You do not control that, Andamio does.

**Send your bot's origin to Andamio** (the
[Andamio Network Discord](https://discord.gg/andamio) is the fastest path) and
wait for confirmation before testing `/login`. Until this lands, `/login` will
open but never complete.

## 6. Verify

Once your origin is allowlisted: a member runs `/login`, then `/check`. If they
hold the gating credential, the bot grants the role and the private channel
appears. A member who does not hold it sees a link to earn it. That is the whole
loop.

Stuck on any step? [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) covers the common
failures (intents, role order, the allowlist, wrong API host).
