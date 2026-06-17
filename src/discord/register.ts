/**
 * Slash-command registration.
 *
 * Discord needs the command definitions (names + descriptions) registered via
 * the REST API before they appear in a server's slash menu — separate from the
 * gateway bot that *handles* invocations. The bot self-registers on every boot
 * (see `index.ts`), so a deploy is all it takes to add/rename/remove a command;
 * `deploy-commands.ts` exposes the same call as a standalone script for forkers
 * who want to register without starting the bot.
 *
 * Guild commands (scoped to one `GUILD_ID`) update instantly, and the PUT fully
 * replaces the set — so a removed command (e.g. a retired `/refresh`) disappears
 * on the next registration.
 */

import {
  REST,
  Routes,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';

/**
 * Register `bodies` as the guild's complete command set (a full replace). Throws
 * on a REST/network failure — callers decide whether that is fatal (the
 * standalone script) or best-effort (the bot boot, where the previously
 * registered set keeps working).
 */
export async function registerGuildCommands(
  token: string,
  appId: string,
  guildId: string,
  bodies: RESTPostAPIApplicationCommandsJSONBody[],
): Promise<void> {
  const rest = new REST().setToken(token);
  await rest.put(Routes.applicationGuildCommands(appId, guildId), {
    body: bodies,
  });
}
