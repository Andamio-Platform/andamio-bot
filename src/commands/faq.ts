import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import { loadConfig } from '../config';
import {
  loadCourseDisplayNames,
  type CourseDisplayNames,
} from '../andamio/course-names';
import { loadMappings, type Mappings } from '../gating/mappings';
import { gatedCredentials } from './gating-view';

export const data = new SlashCommandBuilder()
  .setName('faq')
  .setDescription('How to get started: connect your Andamio account and unlock channels.');

/** The get-started steps. Stable copy, keyed to the bot's existing commands. */
const STEPS: { name: string; value: string }[] = [
  {
    name: '1 · Connect your account',
    value: 'Run `/login` and follow the link to connect your Andamio account to Discord.',
  },
  {
    name: '2 · See what you hold',
    value: 'Run `/credentials` to list the Andamio credentials on your account.',
  },
  {
    name: '3 · Check your access',
    value:
      'Run `/check` to re-read your credentials live and update your channel roles right away.',
  },
  {
    name: '4 · Browse what unlocks channels',
    value:
      'Run `/available` to see which credentials gate channels here, and which you already hold.',
  },
];

/**
 * Render the get-started guide. Pure local config — no API call — so it renders
 * identically for connected and unconnected members and when Andamio is down.
 *
 * When role-mappings are available, append a short "what this server unlocks"
 * list (credential labels + earn links) built from config only. We pass no
 * member state, so nothing claims ✓/✗ — this is browse/onboarding copy.
 */
export function renderFaqEmbed(
  mappings?: Mappings,
  names: CourseDisplayNames = {},
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('Getting started')
    .setDescription(
      'New here? These four commands connect you to Andamio and unlock the ' +
        'channels your credentials earn. Run them in order:',
    )
    .addFields(STEPS);

  const creds = mappings ? gatedCredentials(mappings, names) : [];
  if (creds.length > 0) {
    const lines = creds.map((c) => {
      const earn = c.earnUrl ? ` — earn it: ${c.earnUrl}` : '';
      return `• **${c.label}**${earn}`;
    });
    embed.addFields({
      name: 'What this server unlocks',
      value: lines.join('\n'),
    });
  }

  return embed;
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = loadConfig();
  const names = loadCourseDisplayNames();

  // The guide is local-only. The catalog enrichment is best-effort: if the
  // role-mappings config can't be read, still ship the steps rather than error.
  let mappings: Mappings | undefined;
  try {
    mappings = loadMappings(config.roleMappingsPath);
  } catch (err) {
    console.error('/faq: could not load role-mappings, showing steps only:', err);
  }

  const embed = renderFaqEmbed(mappings, names);
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
