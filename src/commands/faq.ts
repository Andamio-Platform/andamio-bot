import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import { loadConfig, type Config } from '../config';
import {
  loadCourseDisplayNames,
  type CourseDisplayNames,
} from '../andamio/course-names';
import { loadMappings, type Mappings } from '../gating/mappings';
import { loadFaq, type FaqEntry } from '../faq/config';
import { rankFaqEntries, resolveAnswer } from '../faq/match';
import { gatedCredentials } from './gating-view';

export const data = new SlashCommandBuilder()
  .setName('faq')
  .setDescription('How to get started: connect your Andamio account and unlock channels.')
  .addStringOption((option) =>
    option
      .setName('question')
      .setDescription('Search the FAQ — start typing to pick a question (optional).')
      .setRequired(false)
      .setAutocomplete(true),
  );

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

/**
 * Build the static get-started guide embed from local config only. Factored out
 * of `execute` so both the no-question path and the unknown-question fallback
 * render the identical guide. The role-mappings enrichment is best-effort: if
 * the config can't be read, ship the steps rather than error.
 */
function renderStaticGuide(config: Config): EmbedBuilder {
  const names = loadCourseDisplayNames();
  let mappings: Mappings | undefined;
  try {
    mappings = loadMappings(config.roleMappingsPath);
  } catch (err) {
    console.error('/faq: could not load role-mappings, showing steps only:', err);
  }
  return renderFaqEmbed(mappings, names);
}

/** Render a single Q&A entry's answer as an embed (Discord markdown ok). */
export function renderAnswerEmbed(entry: FaqEntry): EmbedBuilder {
  return new EmbedBuilder().setTitle(entry.question).setDescription(entry.answer);
}

/**
 * Autocomplete handler for the `question` option. Loads the FAQ config and
 * returns up to 25 ranked choices. Config-read failures degrade to an empty
 * list — autocomplete must never throw to Discord (the dispatcher in index.ts
 * also guards this, but the handler stays graceful on its own).
 */
export async function autocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  let entries: FaqEntry[] = [];
  try {
    entries = loadFaq(loadConfig().faqPath);
  } catch (err) {
    console.error('/faq autocomplete: could not load FAQ config:', err);
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused();
  await interaction.respond(rankFaqEntries(entries, focused));
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = loadConfig();
  const id = interaction.options.getString('question');

  // No question → the static get-started guide, byte-for-byte as before.
  if (!id) {
    await interaction.reply({
      embeds: [renderStaticGuide(config)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Q&A path. Best-effort: a config read failure falls back to the guide rather
  // than erroring to the member (matches the role-mappings posture above).
  let entry: FaqEntry | undefined;
  try {
    entry = resolveAnswer(loadFaq(config.faqPath), id);
  } catch (err) {
    console.error('/faq: could not load FAQ config, showing the guide:', err);
  }

  if (entry) {
    await interaction.reply({
      embeds: [renderAnswerEmbed(entry)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Unknown id (or the config failed to load): a friendly note + the guide.
  await interaction.reply({
    content:
      "I don't have an answer for that one yet — here's the get-started guide instead.",
    embeds: [renderStaticGuide(config)],
    flags: MessageFlags.Ephemeral,
  });
}
