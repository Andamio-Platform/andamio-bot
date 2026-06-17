# Troubleshooting

The failure modes this bot actually hits in the wild, with the fix for each.
Most are Discord setup or the one cross-system allowlist step, not Cardano.

| Symptom | Cause | Fix |
|---|---|---|
| Bot crash-loops on startup with "disallowed intents" | **Server Members Intent** is not enabled | Developer Portal > your app > Bot > Privileged Gateway Intents > enable **Server Members Intent**, then restart |
| A member holds the credential but never gets the role | The bot's role sits **below** the role it manages, so Discord refuses the grant | Server Settings > Roles: drag the bot's role **above** every role named in `role-mappings.json` |
| `/login` opens the link but never finishes | The bot's callback origin is not on the Andamio app's allowlist | Send your `BOT_CALLBACK_BASE_URL` origin to Andamio to add to `ALLOWED_BOT_CALLBACK_ORIGINS` (see [QUICKSTART step 5](./QUICKSTART.md#5-register-your-callback-origin-with-andamio-do-not-skip)) |
| `/credentials` or `/check` says it cannot reach Andamio | Wrong `ANDAMIO_API_BASE_URL`, or a bad/expired `ANDAMIO_API_KEY` | Confirm the API host (mainnet `https://api.andamio.io`) and that the key is the operator key Andamio gave you. `npm run doctor` catches a malformed value; a wrong-but-valid host only shows up here |
| `/credentials` shows long hex ids instead of course names | `COURSE_DISPLAY_NAMES` is unset or malformed | Set it to a JSON object of `course_id` to name. `npm run doctor` flags a malformed value. See [BUILDER-GUIDE.md](./BUILDER-GUIDE.md) to generate it |
| A member sees credentials from unrelated communities | `COURSE_DISPLAY_NAMES` is empty (so everything shows) | Set `COURSE_DISPLAY_NAMES` to just the courses you want surfaced; unlisted ones are hidden. Set `SHOW_ALL_COURSES=true` to show everything again |
| `/available` or `/check` is missing from the slash menu | First boot is still registering, or `GUILD_ID` is wrong | Wait a few seconds, then check the logs for "Registered N guild command(s)" and confirm `GUILD_ID` is your server |
| Everyone has to `/login` again after a redeploy | The SQLite database was not on a persistent volume | Mount a volume at `/app/data` and set `DB_PATH=./data/bot.sqlite` (see [DEPLOY.md](./DEPLOY.md)) |
| The doctor reports a problem you do not understand | A variable is missing or the wrong shape | The message names the variable and what is wrong (it never prints the value). Fix that one and re-run `npm run doctor` |

Still stuck? Ask in the [Andamio Network Discord](https://discord.gg/andamio).
