import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import { loadConfig } from '../config';
import { getDb } from '../db/handle';
import { getLinkByDiscordId } from '../db/links';
import {
  getUserDashboard,
  type UserState,
} from '../andamio/dashboard-client';
import { isExpired } from '../andamio/jwt';
import {
  loadCourseDisplayNames,
  type CourseDisplayNames,
} from '../andamio/course-names';
import { loadMappings, type Mappings } from '../gating/mappings';
import { earnSuffix, gatedCredentials } from './gating-view';
import { fitFieldValue } from './embed-field';

export const data = new SlashCommandBuilder()
  .setName('available')
  .setDescription(
    'List the Andamio credentials that unlock channels in this server.',
  );

/**
 * Render the catalog of gated credentials. With `state` (a connected member),
 * each line shows ✅/⬜ for whether they hold it; without it (unconnected), the
 * list is shown plainly with earn links and a prompt to connect. `couldNotCheck`
 * flags that we are connected but the live read failed, so we show the catalog
 * without claiming ✓/✗.
 */
export function renderAvailableEmbed(
  mappings: Mappings,
  names: CourseDisplayNames = {},
  state?: UserState,
  couldNotCheck = false,
): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('Credentials in this server');

  const creds = gatedCredentials(mappings, names, state);
  if (creds.length === 0) {
    embed.setDescription(
      'This server does not gate any channels on Andamio credentials yet.',
    );
    return embed;
  }

  const showStatus = state !== undefined;
  const lines = creds.map((c) => {
    const mark = showStatus ? (c.satisfied ? '✅' : '⬜') : '•';
    const earn = !c.satisfied ? earnSuffix(c.earnUrl) : '';
    return `${mark} **${c.label}**${earn}`;
  });

  if (showStatus) {
    embed.setDescription('A ✅ is a credential you hold; its channel is unlocked.');
  } else if (couldNotCheck) {
    embed.setDescription(
      'Could not check which you hold right now — here is what this server ' +
        'gates on. Try `/check` again in a moment.',
    );
  } else {
    embed.setDescription(
      'Connect with `/login`, then run `/check` to see which you hold.',
    );
  }

  embed.addFields({ name: 'Gated credentials', value: fitFieldValue(lines) });
  return embed;
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const db = getDb();
  const config = loadConfig();
  const names = loadCourseDisplayNames();

  // The catalog is local config, so it renders even for an unconnected member or
  // when the API is down — only the ✓/✗ overlay needs a live read.
  let mappings: Mappings;
  try {
    mappings = loadMappings(config.roleMappingsPath);
  } catch (err) {
    console.error('Could not load role-mappings for /available:', err);
    await interaction.reply({
      content:
        'Could not load this server’s credential list right now. Please try ' +
        '`/available` again shortly.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const link = getLinkByDiscordId(db, interaction.user.id);

  // Unconnected or no usable JWT → show the catalog without a held-status claim.
  // No API call, no Connect button: this is a browse command, and `/login` /
  // `/check` are the calls to action embedded in the copy.
  if (!link || !link.user_jwt || isExpired(link.jwt_expires_at)) {
    const embed = renderAvailableEmbed(mappings, names);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  // Connected: overlay which the member holds. A failed read still shows the
  // catalog (without ✓/✗) rather than erroring — the list itself is useful.
  let state: UserState | undefined;
  let couldNotCheck = false;
  try {
    ({ state } = await getUserDashboard(
      config.andamioApiBaseUrl,
      config.andamioApiKey,
      link.user_jwt,
    ));
  } catch (err) {
    console.error('/available: dashboard read failed, showing catalog only:', err);
    couldNotCheck = true;
  }

  const embed = renderAvailableEmbed(mappings, names, state, couldNotCheck);
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
