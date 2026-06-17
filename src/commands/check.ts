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
  ApiError,
  type UserState,
} from '../andamio/dashboard-client';
import { isExpired } from '../andamio/jwt';
import { buildReloginPrompt } from '../discord/relogin-prompt';
import {
  loadCourseDisplayNames,
  type CourseDisplayNames,
} from '../andamio/course-names';
import { loadMappings, type Mappings } from '../gating/mappings';
import { gateMemberFromState } from '../gating/triggers';
import { gatedCredentials } from './gating-view';

export const data = new SlashCommandBuilder()
  .setName('check')
  .setDescription(
    'Check whether you hold the credentials that unlock this server, and update ' +
      'your roles.',
  );

/**
 * Render the focused gate-check answer: what the member holds, what they are
 * missing (with earn links), and a one-line summary. `partial` adds a note that
 * Andamio returned incomplete data so roles were left unchanged.
 */
export function renderCheckEmbed(
  mappings: Mappings,
  names: CourseDisplayNames,
  state: UserState,
  partial = false,
): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('Your access');
  const creds = gatedCredentials(mappings, names, state);

  if (creds.length === 0) {
    embed.setDescription(
      'This server does not gate any channels on Andamio credentials yet.',
    );
    return embed;
  }

  const held = creds.filter((c) => c.satisfied);
  const missing = creds.filter((c) => !c.satisfied);

  if (missing.length === 0) {
    embed.setDescription('You hold every gated credential. Your roles are up to date.');
  } else if (held.length === 0) {
    embed.setDescription(
      `You do not yet hold the credential${missing.length > 1 ? 's' : ''} this ` +
        'server gates on.',
    );
  } else {
    embed.setDescription(`You hold ${held.length} of ${creds.length} gated credentials.`);
  }

  if (held.length > 0) {
    embed.addFields({
      name: 'You have',
      value: held.map((c) => `✅ **${c.label}**`).join('\n'),
    });
  }
  if (missing.length > 0) {
    embed.addFields({
      name: 'Not yet',
      value: missing
        .map((c) => {
          const earn = c.earnUrl ? ` — earn it: ${c.earnUrl}` : '';
          return `⬜ **${c.label}**${earn}`;
        })
        .join('\n'),
    });
  }

  if (partial) {
    embed.addFields({
      name: 'Note',
      value:
        'Andamio returned incomplete data, so your roles were not changed just ' +
        'now. Run `/check` again shortly.',
    });
  }

  return embed;
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  // A live read + a Discord role update can exceed the 3s window, so defer.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const db = getDb();
  const config = loadConfig();
  const link = getLinkByDiscordId(db, interaction.user.id);

  // Not connected, or no usable JWT → offer the Connect button (mirrors
  // /credentials). Nothing to check until the member is linked.
  if (!link || !link.user_jwt) {
    const prompt = buildReloginPrompt(
      db,
      interaction.user.id,
      config.appLoginBaseUrl,
      config.botCallbackBaseUrl,
      'connect',
    );
    await interaction.editReply(prompt);
    return;
  }
  if (isExpired(link.jwt_expires_at)) {
    const prompt = buildReloginPrompt(
      db,
      interaction.user.id,
      config.appLoginBaseUrl,
      config.botCallbackBaseUrl,
      'expired',
    );
    await interaction.editReply(prompt);
    return;
  }

  const names = loadCourseDisplayNames();

  let mappings: Mappings;
  try {
    mappings = loadMappings(config.roleMappingsPath);
  } catch (err) {
    console.error('Could not load role-mappings for /check:', err);
    await interaction.editReply({
      content:
        'Could not load this server’s credential list right now. Please try ' +
        '`/check` again shortly.',
    });
    return;
  }

  let result;
  try {
    result = await getUserDashboard(
      config.andamioApiBaseUrl,
      config.andamioApiKey,
      link.user_jwt,
    );
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'unauthorized') {
      // 401 on a non-expired JWT points at the operator key (or a revoked
      // token), not the member — log loudly, show a neutral message.
      console.error(
        'Andamio API returned 401 for a non-expired member JWT — check ' +
          'ANDAMIO_API_KEY:',
        err.message,
      );
      await interaction.editReply({
        content:
          'Andamio is having trouble verifying credentials right now. Please ' +
          'try `/check` again shortly.',
      });
      return;
    }
    const message =
      err instanceof ApiError && err.kind === 'not-found'
        ? `No Andamio state found for alias \`${link.alias}\`. If you just ` +
          `created it, give the chain a moment, then try again.`
        : 'Could not reach Andamio right now. Please try `/check` again in a moment.';
    await interaction.editReply({ content: message });
    return;
  }

  // Only a complete (non-partial) read may drive role changes — a degraded 206
  // must never strip a role the member legitimately holds. We still render the
  // (possibly incomplete) state with a note when partial.
  if (!result.partial) {
    await gateMemberFromState(interaction.user.id, result.state);
  }

  const embed = renderCheckEmbed(mappings, names, result.state, result.partial);
  await interaction.editReply({ embeds: [embed] });
}
