import { CommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('info')
  .setDescription('Get information about the bot');

export async function execute(interaction: CommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle('Andamio Discord Bot')
    .setDescription('A TypeScript Discord bot built with discord.js')
    .addFields(
      { name: 'Version', value: '1.0.0', inline: true },
      { name: 'Created with', value: 'Node.js & TypeScript', inline: true },
      { name: 'Commands', value: 'Use / to see available commands' }
    )
    .setTimestamp()
    .setFooter({ text: 'Andamio Bot' });

  await interaction.reply({ embeds: [embed] });
}
