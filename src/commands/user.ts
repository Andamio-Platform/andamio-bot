import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder, User, GuildMember } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('user')
  .setDescription('Provides information about the user')
  .addUserOption(option => 
    option.setName('target')
      .setDescription('The user to get information about')
      .setRequired(false));

/**
 * Retrieves detailed information about a Discord user
 * @param user The Discord user to get information about
 * @param member Optional guild member object if the user is in a guild
 * @returns An object containing formatted user information
 */
export async function getUserInfo(user: User, member?: GuildMember | null) {
  const userInfo = {
    id: user.id,
    username: user.username,
    avatarURL: user.displayAvatarURL({ size: 256 }),
    createdAt: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`,
    displayColor: member?.displayHexColor || '#0099ff',
    joinedAt: member?.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>` : 'Unknown',
    nickname: member?.nickname || 'None',
    roles: member && member.roles.cache.size > 1 ? 
      member.roles.cache.filter(role => role.id !== member.guild.id).map(role => `<@&${role.id}>`).join(', ') : 
      'No roles'
  };
  
  return userInfo;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // Get the target user (either the mentioned user or the command user)
  const target = interaction.options.getUser('target') || interaction.user;
  
  // Get the member object if in a guild
  const member = interaction.guild ? await interaction.guild.members.fetch(target.id).catch(() => null) : null;
  
  // Get user information
  const userInfo = await getUserInfo(target, member);
  
  const embed = new EmbedBuilder()
    .setColor(userInfo.displayColor)
    .setTitle(`User Information: ${userInfo.username}`)
    .setThumbnail(userInfo.avatarURL)
    .addFields(
      { name: 'User ID', value: userInfo.id, inline: true },
      { name: 'Account Created', value: userInfo.createdAt, inline: true }
    )
    .setTimestamp()
    .setFooter({ text: 'Andamio Bot' });
  
  // Add guild-specific information if available
  if (member) {
    embed.addFields(
      { name: 'Joined Server', value: userInfo.joinedAt, inline: true },
      { name: 'Nickname', value: userInfo.nickname, inline: true },
      { name: 'Roles', value: userInfo.roles, inline: false }
    );
  }

  await interaction.reply({ embeds: [embed] });
}
