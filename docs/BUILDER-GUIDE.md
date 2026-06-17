# Builder guide: author your gating config with the Andamio CLI

> **Requires the [Andamio CLI](https://github.com/Andamio-Platform/andamio-cli)
> and an Andamio account.** This is the fast lane for someone wiring up their
> own gating. If you were handed a config to deploy, you do not need this; see
> [QUICKSTART.md](./QUICKSTART.md).

The bot never uses the CLI at runtime. The CLI is a setup-time convenience: it
turns "hunt down 56-character hex ids by hand" into a couple of commands. Once
your `role-mappings.json` and env are set, the bot runs without it.

Authenticate first: `andamio auth status` (or `andamio user login`).

## 1. Find your `course_id` and `slt_hash`

```
andamio course list --output json        # find a course and its course_id
andamio course get <course_id>           # read its module slt_hash(es)
```

Put those into a `credential` rule in `config/role-mappings.json`, with the
Discord `role_id` you want it to grant:

```json
{
  "type": "credential",
  "course_id": "<course_id from above>",
  "slt_hash": "<slt_hash from above>",
  "role_id": "<your Discord role id>",
  "label": "Your Credential Name",
  "earn_url": "https://app.andamio.io/course/<course_id>/<module>/assignment"
}
```

## 2. Build a curated `COURSE_DISPLAY_NAMES`

`COURSE_DISPLAY_NAMES` does two jobs at once: it gives courses friendly names,
**and** it decides which courses the bot shows at all. List only the courses
relevant to your server and members see just those; leave a course out and it is
hidden. (Set `SHOW_ALL_COURSES=true` to show everything regardless.)

Generate a starting map from the full course list, then trim it down:

```
./scripts/gen-display-names.sh
```

That prints a `COURSE_DISPLAY_NAMES` value covering every course. **Curate it**:
keep the handful relevant to your community, edit the labels to taste, and set
the result as your `COURSE_DISPLAY_NAMES` env var. The goal is a short, relevant
list, not a dump of everything.

## 3. Verify before you launch

Confirm a known holder's alias actually returns the credential, so the gate will
fire when you announce it. Run the bot, have that member `/login` then `/check`,
and confirm they get the role and the private channel.

That is the whole setup. From here the bot runs on the values you produced, with
no CLI or Andamio account needed at runtime, and anyone you hand the config to
can deploy it CLI-free.
