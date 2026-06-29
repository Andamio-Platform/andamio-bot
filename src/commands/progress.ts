import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import { loadConfig } from '../config';
import { getDb } from '../db/handle';
import { getLinkByDiscordId } from '../db/links';
import {
  getAssignmentCommitments,
  getCourseModules,
  ApiError,
} from '../andamio/content-client';
import { getUserDashboard } from '../andamio/dashboard-client';
import { isExpired } from '../andamio/jwt';
import { buildReloginPrompt } from '../discord/relogin-prompt';
import {
  displayNameFor,
  isDisplayed,
  type DisplayFilter,
} from '../andamio/course-names';
import {
  joinModuleProgress,
  selectOpportunities,
  statusGlyph,
  statusLabel,
  type ModuleStatus,
} from '../andamio/module-progress';
import { fitFieldValue } from './embed-field';
import { loadDisplayFilter } from './display-filter';

/**
 * `/progress` — a connected member's per-module progress in an enrolled course,
 * and the open opportunities within it.
 *
 * Course Modules ↔ Assignments are 1:1, so each module's commitment status *is*
 * its progress, and a module with no commitment (or a refused one) *is* an open
 * opportunity. Two views read one pure join ({@link joinModuleProgress}): the
 * default lists every on-chain module with a status glyph; `view:opportunities`
 * lists only the ⬜/❌ rows. Course selection autocompletes the member's enrolled,
 * server-surfaced courses.
 *
 * Display-only and member-scoped, like `/credentials`: it reads commitments via
 * the member Bearer but NEVER feeds role gating (the gating evaluator stays the
 * sole role authority). Every reply is ephemeral. A missing/expired connection
 * shows the Connect button with no API call; an `ApiError` degrades to a
 * friendly note; nothing throws to the user.
 */

/** Bound the enrolled-course autocomplete read under Discord's ~3s window. */
const AUTOCOMPLETE_BUDGET_MS = 2_500;

/** Discord caps an autocomplete response at 25 choices. */
const CHOICE_LIMIT = 25;

/** Discord caps an autocomplete choice `name` at 100 characters. */
const CHOICE_NAME_MAX = 100;

/** Shown when a content/commitments read errors. */
const ERROR_REPLY =
  'Could not reach Andamio right now. Please try `/progress` again shortly.';

/** Shown when the authed read 401s despite a non-expired JWT (operator-key suspect). */
const VERIFY_REPLY =
  'Andamio is having trouble verifying your progress right now. Please try ' +
  '`/progress` again shortly.';

/** Shown when a hand-typed course is not one this server surfaces. */
const PICK_COURSE_REPLY =
  'Pick a course from the list — start typing in the `course` option to choose one.';

/** Shown when the chosen course has no on-chain modules to report on. */
const EMPTY_PROGRESS_REPLY = 'No modules to show for that course yet.';

/** Shown in the opportunities view when nothing is open. */
const NO_OPPORTUNITIES_REPLY =
  "You're all caught up — no open assignments in that course right now. 🎉";

/** Truncate `text` to `max` chars with a trailing ellipsis when it overflows. */
function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Race `work` against a deadline, rejecting if it does not settle in time. Keeps
 * the enrolled-course autocomplete read inside Discord's response window; the
 * underlying request keeps running but its (late) result is discarded.
 */
async function withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('autocomplete budget exceeded')), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- pure render helpers ----------------------------------------------------

/** One progress line: `‹glyph› **Title** (`code`) — Label`. */
function progressLine(row: ModuleStatus): string {
  const { module, status } = row;
  const title = module.title || module.moduleCode;
  return `${statusGlyph(status)} **${title}** (\`${module.moduleCode}\`) — ${statusLabel(status)}`;
}

/**
 * The full progress embed: every on-chain module with its status glyph, plus a
 * trailing count of open opportunities so the member sees what's left at a glance.
 */
export function renderProgressEmbed(
  courseLabel: string,
  rows: ModuleStatus[],
): EmbedBuilder {
  const opportunities = selectOpportunities(rows);
  const embed = new EmbedBuilder()
    .setTitle(clamp(`Progress — ${courseLabel}`, 256))
    .setDescription(
      `Your status across ${rows.length} module${rows.length === 1 ? '' : 's'}.` +
        (opportunities.length > 0
          ? ` ${opportunities.length} open — re-run with \`view:opportunities\` to focus.`
          : ' All caught up. 🎉'),
    )
    .addFields({ name: 'Modules', value: fitFieldValue(rows.map(progressLine)) });
  return embed;
}

/** The opportunities-only embed: just the ⬜/❌ rows off the same join. */
export function renderOpportunitiesEmbed(
  courseLabel: string,
  rows: ModuleStatus[],
): EmbedBuilder {
  const opportunities = selectOpportunities(rows);
  return new EmbedBuilder()
    .setTitle(clamp(`Opportunities — ${courseLabel}`, 256))
    .setDescription(
      `${opportunities.length} open assignment${opportunities.length === 1 ? '' : 's'} ` +
        'to start in this course.',
    )
    .addFields({
      name: 'Open',
      value: fitFieldValue(opportunities.map(progressLine)),
    });
}

// --- pure selection helpers -------------------------------------------------

/**
 * Build the `course` autocomplete choices: the member's enrolled courses that
 * this server surfaces, labelled by display name. Bounded and capped to Discord
 * limits. Pure over its inputs; the I/O (dashboard read) happens in the command.
 */
export function enrolledCourseChoices(
  enrolledCourseIds: string[],
  filter: DisplayFilter,
  focused: string,
): { name: string; value: string }[] {
  const q = focused.trim().toLowerCase();
  return enrolledCourseIds
    .filter((id) => isDisplayed(id, filter))
    .map((id) => ({ name: displayNameFor(id, filter.names) || id, value: id }))
    .filter((c) => c.name !== '' && c.value !== '')
    .filter(
      (c) =>
        q === '' ||
        c.name.toLowerCase().includes(q) ||
        c.value.toLowerCase().includes(q),
    )
    .map((c) => ({ name: clamp(c.name, CHOICE_NAME_MAX), value: c.value }))
    .slice(0, CHOICE_LIMIT);
}

/** Whether a course id is one this server surfaces (drives the execute guard). */
export function isCourseSelectable(
  courseId: string,
  filter: DisplayFilter,
): boolean {
  return courseId !== '' && isDisplayed(courseId, filter);
}

// --- command wiring ---------------------------------------------------------

export const data = new SlashCommandBuilder()
  .setName('progress')
  .setDescription('See your per-module progress and open assignments in a course.')
  .addStringOption((option) =>
    option
      .setName('course')
      .setDescription('Choose one of your enrolled courses — start typing to pick.')
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((option) =>
    option
      .setName('view')
      .setDescription('What to show (default: all modules).')
      .setRequired(false)
      .addChoices(
        { name: 'All modules', value: 'all' },
        { name: 'Open opportunities only', value: 'opportunities' },
      ),
  );

/**
 * Autocomplete for `course`: the member's enrolled, server-surfaced courses.
 * Reads the member's link + dashboard (member Bearer) within a tight budget; on
 * no connection, expired JWT, timeout, or any error, responds with an empty list
 * — autocomplete must never throw to Discord.
 */
export async function autocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  try {
    const config = loadConfig();
    const filter = loadDisplayFilter(config.roleMappingsPath);
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'course') {
      await interaction.respond([]);
      return;
    }

    const db = getDb();
    const link = getLinkByDiscordId(db, interaction.user.id);
    if (!link || !link.user_jwt || isExpired(link.jwt_expires_at)) {
      await interaction.respond([]);
      return;
    }

    const { state } = await withBudget(
      getUserDashboard(config.andamioApiBaseUrl, config.andamioApiKey, link.user_jwt),
      AUTOCOMPLETE_BUDGET_MS,
    );
    await interaction.respond(
      enrolledCourseChoices(state.enrolledCourses, filter, focused.value),
    );
  } catch (err) {
    console.error('/progress autocomplete failed:', err);
    try {
      await interaction.respond([]);
    } catch {
      // The interaction may already have expired; nothing more to do.
    }
  }
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const db = getDb();
  const config = loadConfig();
  const link = getLinkByDiscordId(db, interaction.user.id);

  // Reconnect gate — identical posture to /credentials. No API call here.
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

  const filter = loadDisplayFilter(config.roleMappingsPath);
  const courseId = interaction.options.getString('course', true);

  // Reject a hand-typed, non-surfaced course before spending an API call.
  if (!isCourseSelectable(courseId, filter)) {
    await interaction.reply({
      content: PICK_COURSE_REPLY,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const view = interaction.options.getString('view') ?? 'all';
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    // Public modules (operator key) + the member's commitments (member Bearer).
    const [modules, commitments] = await Promise.all([
      getCourseModules(config.andamioApiBaseUrl, config.andamioApiKey, courseId),
      getAssignmentCommitments(config.andamioApiBaseUrl, config.andamioApiKey, link.user_jwt),
    ]);

    // On-chain modules only (mirrors /preview post-#25); commitments scoped to
    // this course before the join (KTD5 — modules carry no course id).
    const onChainModules = modules.filter((m) => m.onChain);
    const courseCommitments = commitments.filter((c) => c.courseId === courseId);
    const rows = joinModuleProgress(onChainModules, courseCommitments);
    const courseLabel = displayNameFor(courseId, filter.names);

    if (rows.length === 0) {
      await interaction.editReply({ content: EMPTY_PROGRESS_REPLY });
      return;
    }

    if (view === 'opportunities') {
      if (selectOpportunities(rows).length === 0) {
        await interaction.editReply({ content: NO_OPPORTUNITIES_REPLY });
        return;
      }
      await interaction.editReply({
        embeds: [renderOpportunitiesEmbed(courseLabel, rows)],
      });
      return;
    }

    await interaction.editReply({
      embeds: [renderProgressEmbed(courseLabel, rows)],
    });
  } catch (err) {
    // 401 despite a non-expired JWT points at the operator key (or a revoked
    // token), not anything the member can fix — log loudly, show a neutral note.
    if (err instanceof ApiError && err.kind === 'unauthorized') {
      console.error(
        '/progress: Andamio API returned 401 for a non-expired member JWT — ' +
          'check ANDAMIO_API_KEY:',
        err.message,
      );
      await interaction.editReply({ content: VERIFY_REPLY });
      return;
    }
    if (!(err instanceof ApiError)) {
      console.error('/progress: unexpected error rendering progress:', err);
    }
    await interaction.editReply({ content: ERROR_REPLY });
  }
}
