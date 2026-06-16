import { describe, it, expect } from 'vitest';
import { loadConfig } from './config';

/** A complete, valid env for the bot. Override per-test. */
function validEnv(): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: 'token-abc',
    DISCORD_APP_ID: '123456789',
    GUILD_ID: '987654321',
    ANDAMIO_API_BASE_URL: 'https://api.andamio.io',
    ANDAMIO_API_KEY: 'ant_mn_secret-key',
    APP_LOGIN_BASE_URL: 'https://app.andamio.io',
    BOT_CALLBACK_BASE_URL: 'https://bot.example.com',
    ROLE_MAPPINGS_PATH: './config/role-mappings.json',
    DB_PATH: './data/bot.sqlite',
  };
}

describe('loadConfig', () => {
  it('parses a valid env into a typed config', () => {
    const config = loadConfig(validEnv());
    expect(config.discordToken).toBe('token-abc');
    expect(config.discordAppId).toBe('123456789');
    expect(config.guildId).toBe('987654321');
    expect(config.andamioApiBaseUrl).toBe('https://api.andamio.io');
    expect(config.andamioApiKey).toBe('ant_mn_secret-key');
    expect(config.appLoginBaseUrl).toBe('https://app.andamio.io');
    expect(config.botCallbackBaseUrl).toBe('https://bot.example.com');
    expect(config.roleMappingsPath).toBe('./config/role-mappings.json');
    expect(config.dbPath).toBe('./data/bot.sqlite');
  });

  it('strips a trailing slash from base URLs', () => {
    const env = validEnv();
    env.ANDAMIO_API_BASE_URL = 'https://api.andamio.io/';
    env.APP_LOGIN_BASE_URL = 'https://app.andamio.io/';
    env.BOT_CALLBACK_BASE_URL = 'https://bot.example.com/';
    const config = loadConfig(env);
    expect(config.andamioApiBaseUrl).toBe('https://api.andamio.io');
    expect(config.appLoginBaseUrl).toBe('https://app.andamio.io');
    expect(config.botCallbackBaseUrl).toBe('https://bot.example.com');
  });

  const requiredVars = [
    'DISCORD_TOKEN',
    'DISCORD_APP_ID',
    'GUILD_ID',
    'ANDAMIO_API_BASE_URL',
    'ANDAMIO_API_KEY',
    'APP_LOGIN_BASE_URL',
    'BOT_CALLBACK_BASE_URL',
    'ROLE_MAPPINGS_PATH',
    'DB_PATH',
  ];

  for (const name of requiredVars) {
    it(`throws naming ${name} when it is missing`, () => {
      const env = validEnv();
      delete env[name];
      expect(() => loadConfig(env)).toThrow(name);
    });

    it(`throws naming ${name} when it is empty`, () => {
      const env = validEnv();
      env[name] = '   ';
      expect(() => loadConfig(env)).toThrow(name);
    });
  }

  it('rejects a malformed ANDAMIO_API_BASE_URL', () => {
    const env = validEnv();
    env.ANDAMIO_API_BASE_URL = 'not a url';
    expect(() => loadConfig(env)).toThrow(/ANDAMIO_API_BASE_URL/);
  });

  it('rejects a non-http(s) URL scheme', () => {
    const env = validEnv();
    env.APP_LOGIN_BASE_URL = 'ftp://app.andamio.io';
    expect(() => loadConfig(env)).toThrow(/APP_LOGIN_BASE_URL/);
  });

  it('rejects a malformed BOT_CALLBACK_BASE_URL', () => {
    const env = validEnv();
    env.BOT_CALLBACK_BASE_URL = 'http://';
    expect(() => loadConfig(env)).toThrow(/BOT_CALLBACK_BASE_URL/);
  });
});
