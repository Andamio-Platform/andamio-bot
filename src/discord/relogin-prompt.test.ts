import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDb, type Db } from '../db/index';
import { getPendingByState } from '../db/links';
import { buildReloginPrompt } from './relogin-prompt';

const APP = 'https://app.andamio.io';
const BOT = 'https://bot.example.com';

describe('buildReloginPrompt', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('builds a Link button pointing at a fresh single-use login URL', () => {
    const prompt = buildReloginPrompt(db, 'discord-1', APP, BOT);

    const row = prompt.components[0].toJSON();
    const button = row.components[0] as { style: number; url?: string; label?: string };

    // ButtonStyle.Link === 5
    expect(button.style).toBe(5);
    expect(button.label).toBe('Connect Andamio');
    expect(button.url).toContain(`${APP}/auth/cli`);
    expect(button.url).toContain('state=');
    expect(button.url).toContain(encodeURIComponent(`${BOT}/callback`));
  });

  it('records a pending login so the minted link is valid', () => {
    const prompt = buildReloginPrompt(db, 'discord-1', APP, BOT);
    const row = prompt.components[0].toJSON();
    const url = (row.components[0] as { url: string }).url;
    const state = new URL(url).searchParams.get('state');

    expect(state).toBeTruthy();
    expect(getPendingByState(db, state as string)).not.toBeNull();
  });

  it('uses connect copy by default and expired copy on demand', () => {
    expect(buildReloginPrompt(db, 'd1', APP, BOT).content).toContain('Connect');
    expect(
      buildReloginPrompt(db, 'd2', APP, BOT, 'expired').content,
    ).toContain('expired');
  });
});
