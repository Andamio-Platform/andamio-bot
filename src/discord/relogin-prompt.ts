/**
 * The "Connect Andamio" affordance.
 *
 * Authenticated reads need a valid member JWT. When a member has never
 * connected, or their stored JWT has expired (end-user JWTs cannot be refreshed
 * unattended), the bot replies with a short message and a one-click Link button
 * that opens a freshly minted, single-use login URL — the same destination as
 * `/login`. A Link-style button carries its URL inline, so no interaction
 * handler is needed; the click just opens the browser and the callback links
 * the member.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

import type { Db } from '../db/index';
import { startLogin } from '../andamio/login';

/** Which situation prompted the reconnect — drives the message copy. */
export type ReloginVariant = 'connect' | 'expired';

/** A reply payload (content + a Link-button row) ready for reply/editReply. */
export interface ReloginPrompt {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
}

/**
 * Mint a fresh login URL for `discordId` and build the reconnect reply. The
 * `expired` variant tells a previously-connected member their session lapsed;
 * `connect` is the first-time prompt.
 */
export function buildReloginPrompt(
  db: Db,
  discordId: string,
  appLoginBaseUrl: string,
  botCallbackBaseUrl: string,
  variant: ReloginVariant = 'connect',
): ReloginPrompt {
  const { url } = startLogin(db, discordId, appLoginBaseUrl, botCallbackBaseUrl);

  const content =
    variant === 'expired'
      ? 'Your Andamio session has expired. Reconnect to refresh your ' +
        'credentials and roles:'
      : 'Connect your Andamio account to see your credentials and unlock ' +
        'channels:';

  const button = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel('Connect Andamio')
    .setURL(url);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

  return { content, components: [row] };
}
