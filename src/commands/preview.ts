import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';

import { loadConfig } from '../config';
import {
  getAssignment,
  getCourseModules,
  getLesson,
  getModuleSlts,
  ApiError,
  type AssignmentContent,
  type CourseModule,
  type LessonContent,
} from '../andamio/content-client';
import {
  displayNameFor,
  isDisplayed,
  type DisplayFilter,
} from '../andamio/course-names';
import { fitFieldValue } from './embed-field';
import { loadDisplayFilter } from './display-filter';

/**
 * `/preview` — surface a course's modules and render a chosen module's
 * lesson or assignment as an ephemeral embed.
 *
 * Built entirely on the public (operator `X-API-Key` only) content-client reads,
 * so it renders identically for connected and unconnected members and never
 * touches member state. Course selection reuses the curated `course-names`
 * display filter (consistent with `/credentials`, `/available`, `/check`); the
 * module option autocompletes the course's on-chain modules. Every reply is
 * ephemeral, and an `ApiError` or empty/degraded content read degrades to a
 * friendly note rather than throwing — mirroring `/faq`'s defensive posture.
 *
 * Shape note: the live lesson/assignment endpoints expose only a title and an
 * opaque Tiptap `contentJson` (no description/image/video — see the content
 * fixtures README), so a content embed renders the title plus a plain-text
 * excerpt of the body and a reference to its module.
 */

/** Discord caps an autocomplete response at 25 choices. */
const CHOICE_LIMIT = 25;

/** Discord caps an autocomplete choice `name` at 100 characters. */
const CHOICE_NAME_MAX = 100;

/** Discord caps an embed title at 256 characters. */
const EMBED_TITLE_MAX = 256;

/**
 * Bound the module-autocomplete API read well under Discord's ~3s autocomplete
 * response window — the content-client's own 10s timeout would let a slow-but-
 * healthy API overrun the window and silently drop the whole suggestion list.
 */
const AUTOCOMPLETE_BUDGET_MS = 2_500;

/** Max length of the plain-text excerpt pulled from a Tiptap document. */
const EXCERPT_MAX = 280;

/** Truncate `text` to `max` chars with a trailing ellipsis when it overflows. */
function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Race `work` against a deadline, rejecting if it does not settle in time. Used
 * to keep the module-autocomplete fetch inside Discord's response window; the
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

/** Shown when the API is unreachable or returns an error. */
const ERROR_REPLY =
  'Could not reach Andamio right now. Please try `/preview` again shortly.';

/** Shown when there is nothing on-chain to preview, or the requested module is not found (not an error). */
const EMPTY_REPLY = 'No preview available for that yet.';

/** Shown when a hand-typed course is not one this server surfaces. */
const PICK_COURSE_REPLY =
  'Pick a course from the list — start typing in the `course` option to choose one.';

// --- pure render helpers (U2) ----------------------------------------------

/**
 * Extract a short plain-text excerpt from an opaque Tiptap document. Walks the
 * node tree collecting `text` nodes in document order, joins on spaces, collapses
 * whitespace, and truncates to `maxLen` with an ellipsis. Total and defensive:
 * any non-conforming shape yields `''` (the caller then omits the excerpt). Never
 * throws, never leaks raw JSON.
 */
export function tiptapExcerpt(contentJson: unknown, maxLen = EXCERPT_MAX): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const n = node as Record<string, unknown>;
    if (n.type === 'text' && typeof n.text === 'string') parts.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(contentJson);

  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1).trimEnd() + '…';
}

/**
 * Compact list of a course's modules: one line per module with its title
 * and code. `fitFieldValue` keeps the field inside Discord's 1024-char limit.
 */
export function renderModuleListEmbed(
  courseLabel: string,
  onChainModules: CourseModule[],
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(clamp(`Preview — ${courseLabel}`, EMBED_TITLE_MAX))
    .setDescription(
      onChainModules.length > 0
        ? 'Modules in this course. Re-run `/preview` with a `module` to see ' +
            'its lesson or assignment.'
        : 'No modules to preview in this course yet.',
    );

  if (onChainModules.length > 0) {
    const lines = onChainModules.map((m) => {
      const desc = m.description ? ` — ${m.description}` : '';
      return `• **${m.title || m.moduleCode}** (\`${m.moduleCode}\`)${desc}`;
    });
    embed.addFields({ name: 'Modules', value: fitFieldValue(lines) });
  }

  return embed;
}

/**
 * Render a single module's lesson or assignment: the content title, a plain-text
 * excerpt of its Tiptap body, and a reference to the owning module.
 */
export function renderModulePreviewEmbed(
  module: CourseModule,
  content: LessonContent | AssignmentContent,
  kind: 'lesson' | 'assignment',
): EmbedBuilder {
  const label = kind === 'lesson' ? 'Lesson' : 'Assignment';
  const title = content.title || module.title || module.moduleCode;
  const excerpt = tiptapExcerpt(content.contentJson);

  return new EmbedBuilder()
    .setTitle(clamp(`${label}: ${title}`, EMBED_TITLE_MAX))
    .setDescription(excerpt || '_No description available for this content yet._')
    .addFields({
      name: 'Module',
      value: `**${module.title || module.moduleCode}** (\`${module.moduleCode}\`)`,
    });
}

/** Whether a content read came back with nothing worth showing. */
function isEmptyContent(content: LessonContent | AssignmentContent): boolean {
  return content.title.trim() === '' && tiptapExcerpt(content.contentJson) === '';
}

// --- pure selection helpers (U3) -------------------------------------------

/**
 * Shared shaping for both autocompletes: drop choices with an empty name or
 * value (Discord rejects the *whole* batch if any single choice is invalid),
 * narrow by the focused query (case-insensitive over name and value, matched
 * against the full name before truncation), bound each name to Discord's
 * 100-char limit, and cap at the 25-choice limit.
 */
function narrowChoices(
  choices: { name: string; value: string }[],
  focused: string,
): { name: string; value: string }[] {
  const q = focused.trim().toLowerCase();
  return choices
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

/**
 * Build the curated course choices for the `course` autocomplete: the union of
 * the display-name map keys and the gated course ids, kept to those the filter
 * surfaces, labelled by display name (falling back to the raw id when the
 * configured label is blank), narrowed and bounded by {@link narrowChoices}.
 *
 * Note: there is no full course-catalog source here, so when no courses are
 * curated and none are gated the list is empty by design (a focused server is
 * the intended shape; see the plan's Scope Boundaries).
 */
export function courseChoices(
  filter: DisplayFilter,
  focused: string,
): { name: string; value: string }[] {
  const ids = new Set<string>([
    ...Object.keys(filter.names),
    ...filter.gatedCourseIds,
  ]);
  const choices = [...ids]
    .filter((id) => isDisplayed(id, filter))
    .map((id) => ({ name: displayNameFor(id, filter.names) || id, value: id }));
  return narrowChoices(choices, focused);
}

/**
 * Build the module choices for the `module` autocomplete: on-chain modules only,
 * labelled `Title (code)`, valued by module code, narrowed and bounded by
 * {@link narrowChoices}.
 */
export function moduleChoices(
  modules: CourseModule[],
  focused: string,
): { name: string; value: string }[] {
  const choices = modules
    .filter((m) => m.onChain)
    .map((m) => ({
      name: `${m.title || m.moduleCode} (${m.moduleCode})`,
      value: m.moduleCode,
    }));
  return narrowChoices(choices, focused);
}

/** Whether a course id is one this server surfaces (drives the execute guard). */
export function isCourseSelectable(
  courseId: string,
  filter: DisplayFilter,
): boolean {
  return courseId !== '' && isDisplayed(courseId, filter);
}

// --- command wiring (U4) ---------------------------------------------------

export const data = new SlashCommandBuilder()
  .setName('preview')
  .setDescription(
    "Preview a course's modules and their lesson or assignment content.",
  )
  .addStringOption((option) =>
    option
      .setName('course')
      .setDescription('Choose a course — start typing to pick one.')
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((option) =>
    option
      .setName('module')
      .setDescription(
        'Optional: choose a module to preview its lesson or assignment.',
      )
      .setRequired(false)
      .setAutocomplete(true),
  );

/**
 * Autocomplete for both options. `course` returns the curated set with no API
 * call (Discord's ~3s budget). `module` reads the already-chosen `course` and
 * lists its on-chain modules — but only when that course is one the server surfaces
 * (`isCourseSelectable`), so a hand-typed non-curated id cannot enumerate an
 * arbitrary course's modules via the operator key. With no/invalid course, or on
 * any failure, it responds with an empty list — autocomplete must never throw to
 * Discord.
 */
export async function autocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  try {
    const config = loadConfig();
    const filter = loadDisplayFilter(config.roleMappingsPath);
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'course') {
      await interaction.respond(courseChoices(filter, focused.value));
      return;
    }

    const courseId = interaction.options.getString('course') ?? '';
    if (!isCourseSelectable(courseId, filter)) {
      await interaction.respond([]);
      return;
    }

    const modules = await withBudget(
      getCourseModules(config.andamioApiBaseUrl, config.andamioApiKey, courseId),
      AUTOCOMPLETE_BUDGET_MS,
    );
    await interaction.respond(moduleChoices(modules, focused.value));
  } catch (err) {
    console.error('/preview autocomplete failed:', err);
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
  const config = loadConfig();
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

  const moduleCode = interaction.options.getString('module');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const modules = await getCourseModules(
      config.andamioApiBaseUrl,
      config.andamioApiKey,
      courseId,
    );
    const onChainModules = modules.filter((m) => m.onChain);
    const courseLabel = displayNameFor(courseId, filter.names);

    // Module-list view: no module chosen.
    if (!moduleCode) {
      if (onChainModules.length === 0) {
        await interaction.editReply({ content: EMPTY_REPLY });
        return;
      }
      await interaction.editReply({
        embeds: [renderModuleListEmbed(courseLabel, onChainModules)],
      });
      return;
    }

    // Per-module view: the module must be on-chain to preview.
    const module = onChainModules.find((m) => m.moduleCode === moduleCode);
    if (!module) {
      await interaction.editReply({ content: EMPTY_REPLY });
      return;
    }

    // Lesson-preferred: render a lesson if any SLT has one, else the assignment.
    const slts = await getModuleSlts(
      config.andamioApiBaseUrl,
      config.andamioApiKey,
      courseId,
      moduleCode,
    );
    const lessonSlt = slts.find((s) => s.hasLesson);

    if (lessonSlt) {
      const lesson = await getLesson(
        config.andamioApiBaseUrl,
        config.andamioApiKey,
        courseId,
        moduleCode,
        lessonSlt.sltIndex,
      );
      await interaction.editReply(
        isEmptyContent(lesson)
          ? { content: EMPTY_REPLY }
          : { embeds: [renderModulePreviewEmbed(module, lesson, 'lesson')] },
      );
      return;
    }

    const assignment = await getAssignment(
      config.andamioApiBaseUrl,
      config.andamioApiKey,
      courseId,
      moduleCode,
    );
    await interaction.editReply(
      isEmptyContent(assignment)
        ? { content: EMPTY_REPLY }
        : { embeds: [renderModulePreviewEmbed(module, assignment, 'assignment')] },
    );
  } catch (err) {
    // No command throws to the user: an ApiError (or any unexpected error) maps
    // to a friendly note. Log non-ApiError loudly so a real bug is still visible.
    if (!(err instanceof ApiError)) {
      console.error('/preview: unexpected error rendering a preview:', err);
    }
    await interaction.editReply({ content: ERROR_REPLY });
  }
}
