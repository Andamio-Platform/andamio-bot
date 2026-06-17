import { RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';

import { loadConfig } from './config';
import { isCommandModule } from './command-loader';
import { registerGuildCommands } from './discord/register';

/**
 * Standalone command registration (`npm run deploy`).
 *
 * The bot self-registers its commands on every boot (see `index.ts`), so this is
 * an optional convenience: register the guild's commands WITHOUT starting the
 * bot — handy when forking, or to push a command change before the next deploy.
 * It reads `src/commands/` (or `dist/commands/`) the same way the bot does.
 */

const config = loadConfig();

const commands: RESTPostAPIApplicationCommandsJSONBody[] = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(isCommandModule);

// Grab the SlashCommandBuilder#toJSON() output of each command's data.
for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const command = require(filePath);
  if ('data' in command && 'execute' in command) {
    commands.push(command.data.toJSON());
  } else {
    console.log(
      `[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`,
    );
  }
}

(async () => {
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);
    await registerGuildCommands(
      config.discordToken,
      config.discordAppId,
      config.guildId,
      commands,
    );
    console.log(`Successfully reloaded ${commands.length} application (/) commands.`);
  } catch (error) {
    console.error(error);
  }
})();
