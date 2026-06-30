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
import {
  getUserDashboard,
  ApiError as DashboardApiError,
  type UserState,
} from '../andamio/dashboard-client';
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
 * `/progress` — a connected member's progress, at two altitudes.
 *
 * With NO `course`, it shows an overview: the credentials the member has earned
 * across every completed course (including ones they're no longer enrolled in)
 * plus their in-progress courses ({@link renderProgressOverviewEmbed}, off the
 * dashboard read). This is the "what have I earned?" view.
 *
 * With a `course`, it shows that course's per-module detail. Course Modules ↔
 * Assignments are 1:1, so each module's commitment status *is* its progress, and
 * a module with no commitment (or a refused one) *is* an open opportunity. Two
 * views read one pure join ({@link joinModuleProgress}): the default lists every
 * on-chain module with a status glyph; `view:opportunities` lists only the ⬜/❌
 * rows. Course selection autocompletes the member's enrolled AND completed
 * server-surfaced courses, so a finished course can be drilled into too.
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

/** Discord caps an embed title at 256 characters. */
const EMBED_TITLE_MAX = 256;

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
    .setTitle(clamp(`Progress — ${courseLabel}`, EMBED_TITLE_MAX))
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
    .setTitle(clamp(`Opportunities — ${courseLabel}`, EMBED_TITLE_MAX))
    .setDescription(
      `${opportunities.length} open assignment${opportunities.length === 1 ? '' : 's'} ` +
        'to start in this course.',
    )
    .addFields({
      name: 'Open',
      value: fitFieldValue(opportunities.map(progressLine)),
    });
}

/**
 * The overview embed shown when no course is chosen: the member's earned
 * credentials across every completed course (including ones they're no longer
 * enrolled in), plus their in-progress courses. Mirrors the sections `/credentials`
 * renders, framed as a progress summary, and points the member at the `course`
 * option to drill into a single course's module-by-module detail. Both lists are
 * restricted to courses this server surfaces (curated display).
 */
export function renderProgressOverviewEmbed(
  state: UserState,
  filter: DisplayFilter,
): EmbedBuilder {
  const { names } = filter;
  const embed = new EmbedBuilder()
    .setTitle('Your Andamio Progress')
    .setDescription(
      `Connected as \`${state.alias}\`. Pick a course in the \`course\` option ` +
        'to see its module-by-module detail.',
    );

  // Credentials earned: every completed course + its claimed-credential count,
  // independent of current enrolment (so past courses still show what was earned).
  const completed = state.completedCourses.filter((c) =>
    isDisplayed(c.courseId, filter),
  );
  if (completed.length > 0) {
    const lines = completed.map((c) => {
      const name = displayNameFor(c.courseId, names) || c.courseId;
      const n = c.claimedCredentials.length;
      return `🎓 **${name}** — ${n} credential${n === 1 ? '' : 's'} earned`;
    });
    embed.addFields({ name: 'Credentials earned', value: fitFieldValue(lines) });
  } else {
    embed.addFields({
      name: 'Credentials earned',
      value: '_No completed courses yet._',
    });
  }

  // Enrolled (in progress): enrolled courses not already completed, same filter.
  const completedIds = new Set(state.completedCourses.map((c) => c.courseId));
  const inProgress = state.enrolledCourses
    .filter((id) => !completedIds.has(id))
    .filter((id) => isDisplayed(id, filter));
  if (inProgress.length > 0) {
    const lines = inProgress.map((id) => `• ${displayNameFor(id, names) || id}`);
    embed.addFields({
      name: 'Enrolled (in progress)',
      value: fitFieldValue(lines),
    });
  }

  return embed;
}

// --- pure selection helpers -------------------------------------------------

/**
 * Build the `course` autocomplete choices from a list of course ids the member
 * has touched (enrolled + completed), keeping the ones this server surfaces and
 * labelling them by display name. Bounded and capped to Discord limits. Pure over
 * its inputs; the I/O (dashboard read) happens in the command. Surfacing completed
 * courses too lets a member drill into the module detail of a course they finished.
 */
export function courseChoices(
  courseIds: string[],
  filter: DisplayFilter,
  focused: string,
): { name: string; value: string }[] {
  const q = focused.trim().toLowerCase();
  return courseIds
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
      .setDescription('Choose a course for module detail — leave blank for your credentials overview.')
      .setRequired(false)
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
    // Offer enrolled AND completed courses (deduped) so a member can drill into
    // a course they've finished, not just one they're still enrolled in.
    const courseIds = [
      ...new Set([
        ...state.enrolledCourses,
        ...state.completedCourses.map((c) => c.courseId),
      ]),
    ];
    await interaction.respond(courseChoices(courseIds, filter, focused.value));
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
  const courseId = interaction.options.getString('course');

  // No course chosen → the credentials overview: what the member has earned
  // across every completed course (incl. ones they've left) + what's in progress.
  if (!courseId) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { state } = await getUserDashboard(
        config.andamioApiBaseUrl,
        config.andamioApiKey,
        link.user_jwt,
      );
      await interaction.editReply({
        embeds: [renderProgressOverviewEmbed(state, filter)],
      });
    } catch (err) {
      if (err instanceof DashboardApiError && err.kind === 'unauthorized') {
        console.error(
          '/progress overview: Andamio API returned 401 for a non-expired ' +
            'member JWT — check ANDAMIO_API_KEY:',
          err.message,
        );
        await interaction.editReply({ content: VERIFY_REPLY });
        return;
      }
      if (!(err instanceof DashboardApiError)) {
        console.error('/progress overview: unexpected error:', err);
      }
      await interaction.editReply({ content: ERROR_REPLY });
    }
    return;
  }

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
