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
  displayNameFor,
  loadCourseDisplayNames,
  type CourseDisplayNames,
} from '../andamio/course-names';
import { loadMappings, type Mappings } from '../gating/mappings';
import { ruleSatisfied } from '../gating/evaluator';

export const data = new SlashCommandBuilder()
  .setName('credentials')
  .setDescription('Show your Andamio connection status and earned credentials.');

/** Build the ephemeral embed for a connected member's state. */
export function renderCredentialsEmbed(
  state: UserState,
  names: CourseDisplayNames = {},
  mappings?: Mappings,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('Your Andamio Credentials')
    .setDescription(`Connected as \`${state.alias}\`.`);

  // Completed section: display name + count of earned credentials per course.
  if (state.completedCourses.length > 0) {
    const lines = state.completedCourses.map((c) => {
      const name = displayNameFor(c.courseId, names);
      const n = c.claimedCredentials.length;
      return `• **${name}** — ${n} credential${n === 1 ? '' : 's'}`;
    });
    embed.addFields({ name: 'Completed', value: lines.join('\n') });
  } else {
    embed.addFields({
      name: 'Completed',
      value: '_No completed courses yet._',
    });
  }

  // Enrolled (in progress): enrolled courses that are not already completed.
  const completedIds = new Set(state.completedCourses.map((c) => c.courseId));
  const inProgress = state.enrolledCourses.filter((id) => !completedIds.has(id));
  if (inProgress.length > 0) {
    const lines = inProgress.map((id) => `• ${displayNameFor(id, names)}`);
    embed.addFields({ name: 'Enrolled (in progress)', value: lines.join('\n') });
  }

  // Earn-it hints: any rule with an `earn_url` the member does not yet satisfy.
  // Turns a gate the member is missing into a call to action. De-duped by URL,
  // since several rules may point at the same place to earn.
  if (mappings) {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const rule of mappings.rules) {
      if (rule.earn_url === undefined || ruleSatisfied(rule, state)) continue;
      if (seen.has(rule.earn_url)) continue;
      seen.add(rule.earn_url);
      const label = rule.label ?? displayNameFor(rule.course_id, names);
      lines.push(`• **${label}** — earn it: ${rule.earn_url}`);
    }
    if (lines.length > 0) {
      embed.addFields({ name: 'Earn more', value: lines.join('\n') });
    }
  }

  return embed;
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const db = getDb();
  const config = loadConfig();
  const link = getLinkByDiscordId(db, interaction.user.id);

  // Not connected, or connected without a usable JWT: show the Connect button
  // and make NO API call. A first-time member sees "connect"; a member whose
  // stored JWT has expired sees "expired" (end-user JWTs cannot be refreshed
  // unattended — the member must reconnect).
  if (!link || !link.user_jwt) {
    const prompt = buildReloginPrompt(
      db,
      interaction.user.id,
      config.appLoginBaseUrl,
      config.botCallbackBaseUrl,
      'connect',
    );
    await interaction.reply({ ...prompt, flags: MessageFlags.Ephemeral });
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
    await interaction.reply({ ...prompt, flags: MessageFlags.Ephemeral });
    return;
  }

  const names = loadCourseDisplayNames();

  // Load mappings for the earn-it hints. A config problem here must never break
  // the core /credentials output, so fall back to no hints on failure.
  let mappings: Mappings | undefined;
  try {
    mappings = loadMappings(config.roleMappingsPath);
  } catch (err) {
    console.error('Could not load role-mappings for earn-it hints:', err);
  }

  let state: UserState;
  try {
    // Partial (206) reads are fine to display as-is; only role gating must be
    // cautious about incomplete data (see triggers.ts).
    ({ state } = await getUserDashboard(
      config.andamioApiBaseUrl,
      config.andamioApiKey,
      link.user_jwt,
    ));
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'unauthorized') {
      // The JWT passed our local expiry check but the API still rejected it.
      // That points at the operator API key (or a revoked token), not anything
      // the member can fix — log loudly and show a neutral message.
      console.error(
        'Andamio API returned 401 for a non-expired member JWT — check ' +
          'ANDAMIO_API_KEY:',
        err.message,
      );
      await interaction.reply({
        content:
          'Andamio is having trouble verifying credentials right now. ' +
          'Please try `/credentials` again shortly.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const message =
      err instanceof ApiError && err.kind === 'not-found'
        ? `No Andamio state found for alias \`${link.alias}\`. If you just ` +
          `created it, give the chain a moment, then try again.`
        : `Could not reach Andamio right now. Please try \`/credentials\` ` +
          `again in a moment.`;
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    return;
  }

  const embed = renderCredentialsEmbed(state, names, mappings);
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
