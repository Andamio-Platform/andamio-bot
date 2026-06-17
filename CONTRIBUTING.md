# Contributing

Thanks for working on the Andamio Discord bot. This is a small, focused
TypeScript codebase; the bar is "clear, tested, and consistent with what is
already here."

## Develop

```
npm install
npm run dev      # run from source (ts-node)
npm run watch    # run from source, reload on change
npm test         # vitest
npm run lint     # eslint
npm run doctor   # validate your .env before running
```

Build and run the compiled bot with `npm run build && npm start`.

## Conventions

- **TypeScript, tested.** New behavior comes with tests (vitest). Keep pure logic
  in a pure function and a thin wrapper around it (see `src/doctor.ts` and
  `src/discord/register.ts` for the pattern).
- **Commands register themselves on boot.** Do not add a manual command-deploy
  step. On startup the bot PUTs its current command set as guild commands, so
  adding, renaming, or removing a command in `src/commands/` is all it takes;
  `npm run deploy` exists only as an optional standalone registration.
- **The bot talks only to the Andamio API.** No wallet, signing, or Cardano code
  belongs in this repo.
- **No secrets in git.** `.env` is gitignored; never commit a real token or API
  key. `role-mappings.json` and `COURSE_DISPLAY_NAMES` are config (ids and
  names), not secrets.

## Project layout

- `src/commands/`: slash commands (auto-discovered + auto-registered)
- `src/gating/`: role-mapping rules, the evaluator, and re-evaluation triggers
- `src/andamio/`: the Andamio API client, login flow, and display config
- `src/doctor.ts`: pre-deploy env validation (`npm run doctor`)
- `config/role-mappings.json`: which credential unlocks which role
- `docs/`: onboarding guides (quickstart, concepts, deploy, troubleshooting,
  builder)

## A note on history

This repository's git history was intentionally squashed to a single clean
initial commit before it was made public; there are no secrets in history.
