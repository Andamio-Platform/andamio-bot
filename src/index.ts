import * as fs from 'fs';
import * as path from 'path';

import {
  ChatInputCommandInteraction,
  Client,
  ClientOptions,
  Collection,
  Events,
  GatewayIntentBits,
  RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';

import { loadConfig } from './config';
import { openDb } from './db/index';
import { setDb } from './db/handle';
import { loadMappings } from './gating/mappings';
import { initGating, reevaluateAll, reevaluateMember } from './gating/triggers';
import { startCallbackServer } from './web/server';
import { isCommandModule } from './command-loader';
import { registerGuildCommands } from './discord/register';

interface Command {
  data: {
    name: string;
    toJSON(): RESTPostAPIApplicationCommandsJSONBody;
  };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

class BotClient extends Client {
  public commands: Collection<string, Command>;

  constructor(options: ClientOptions) {
    super(options);
    this.commands = new Collection<string, Command>();
  }
}

/** Port the callback web server listens on. */
const WEB_PORT = Number(process.env.PORT ?? 3000);

/** Default periodic gating-sweep interval: 15 minutes. */
const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Periodic sweep interval in ms, from `GATING_SWEEP_INTERVAL_MS` if set and a
 * positive number, otherwise the 15-minute default.
 */
function sweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GATING_SWEEP_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SWEEP_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SWEEP_INTERVAL_MS;
}

function loadCommands(client: BotClient): void {
  const commandsPath = path.join(__dirname, 'commands');
  const commandFiles = fs
    .readdirSync(commandsPath)
    .filter((file) => isCommandModule(file));

  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
      client.commands.set(command.data.name, command);
    } else {
      console.log(
        `[WARNING] The command at ${filePath} is missing a "data" or "execute" property.`,
      );
    }
  }
}

function main(): void {
  // Fail fast on bad/missing config before touching Discord or the db.
  const config = loadConfig();

  // Fail fast on an invalid role-mappings file too — gating must not start with
  // a config it would silently misinterpret.
  const mappings = loadMappings(config.roleMappingsPath);

  // Open the db once and share the handle with reflectively-loaded commands.
  const db = openDb(config.dbPath);
  setDb(db);

  // Start the callback web server alongside the bot.
  startCallbackServer({ db, reevaluate: reevaluateMember }, WEB_PORT);

  const client = new BotClient({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  // Wire the gating triggers with their runtime dependencies (mirrors setDb).
  initGating({ client, config, mappings });

  loadCommands(client);

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
    console.log(
      `Gating managing ${mappings.managedRoleIds.size} role(s) across ` +
        `${mappings.rules.length} rule(s).`,
    );

    // Self-register the guild's slash commands on every boot, so a deploy is all
    // it takes to add/rename/remove a command (the PUT fully replaces the set).
    // Best-effort: a transient failure here leaves the previously registered
    // commands working, so it must never take the bot down.
    try {
      const bodies = [...client.commands.values()].map((c) => c.data.toJSON());
      await registerGuildCommands(
        config.discordToken,
        config.discordAppId,
        config.guildId,
        bodies,
      );
      console.log(`Registered ${bodies.length} guild command(s).`);
    } catch (err) {
      console.error(
        'Command registration failed (existing commands still work):',
        err,
      );
    }

    // Periodic sweep: re-evaluate every connected member so credentials earned
    // (or lost) since their last interaction are reflected without a re-login.
    const intervalMs = sweepIntervalMs();
    setInterval(() => {
      reevaluateAll().catch((err) =>
        console.error('Gating: periodic sweep failed:', err),
      );
    }, intervalMs);
    console.log(`Gating sweep scheduled every ${intervalMs}ms.`);
  });

  // Re-evaluate a member's roles when they (re)join the guild.
  client.on(Events.GuildMemberAdd, (member) => {
    reevaluateMember(member.id).catch((err) =>
      console.error('Gating: guildMemberAdd re-evaluation failed:', err),
    );
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) {
      console.error(`No command matching ${interaction.commandName} was found.`);
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(error);
      const payload = {
        content: 'There was an error while executing this command!',
        ephemeral: true,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    }
  });

  client.login(config.discordToken).catch((error) => {
    console.error('Error logging in to Discord:', error);
    process.exit(1);
  });
}

main();
