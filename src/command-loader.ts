/**
 * Shared predicate for selecting loadable command modules from the commands
 * directory. The bot and the deploy-commands script both reflectively read
 * `src/commands/` (or `dist/commands/`) and `require()` each entry; this keeps
 * them from pulling in test files (`*.test.ts`, which import vitest) or type
 * declarations (`*.d.ts`). In production the compiled `dist/` has no test files,
 * but running from source (e.g. `npm run deploy` via ts-node) does, so without
 * this filter the registration script crashes on `import vitest`.
 */
export function isCommandModule(file: string): boolean {
  if (!file.endsWith('.js') && !file.endsWith('.ts')) return false;
  if (file.endsWith('.d.ts')) return false;
  if (/\.test\.[jt]s$/.test(file)) return false;
  return true;
}
