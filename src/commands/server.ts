import { CommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('server')
  .setDescription('Provides information about the server');

export async function execute(interaction: CommandInteraction): Promise<void> {
  // Check if the interaction is in a guild
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in a server!', ephemeral: true });
    return;
  }

  const { guild } = interaction;
  
  const embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle(`${guild.name}`)
    .setThumbnail(guild.iconURL() || '')
    .addFields(
      { name: 'Created On', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: true },
      { name: 'Server ID', value: guild.id, inline: true },
      { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
      { name: 'Members', value: guild.memberCount.toString(), inline: true },
      { name: 'Boost Level', value: guild.premiumTier.toString(), inline: true },
      { name: 'Verification Level', value: guild.verificationLevel.toString(), inline: true }
    )
    .setTimestamp()
    .setFooter({ text: 'Andamio Bot' });

  await interaction.reply({ embeds: [embed] });
}
