import { CommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Shows a list of available commands');

export async function execute(interaction: CommandInteraction): Promise<void> {
  const commandsPath = path.join(__dirname);
  const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'));
  
  const embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle('Available Commands')
    .setDescription('Here are all the available commands for this bot:')
    .setTimestamp()
    .setFooter({ text: 'Andamio Bot' });

  // Loop through all command files and add them to the embed
  for (const file of commandFiles) {
    if (file === 'help.ts' || file === 'help.js') continue; // Skip the help command itself
    
    const filePath = path.join(commandsPath, file);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const command = require(filePath);
    
    if ('data' in command && 'execute' in command) {
      embed.addFields({
        name: `/${command.data.name}`,
        value: command.data.description || 'No description provided',
        inline: true
      });
    }
  }

  await interaction.reply({ embeds: [embed] });
}
