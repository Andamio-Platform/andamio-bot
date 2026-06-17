import * as dotenv from 'dotenv';

dotenv.config();

export interface Config {
  /** Discord bot token. */
  discordToken: string;
  /** Discord application (client) id. */
  discordAppId: string;
  /** Discord guild (server) id the bot operates in. */
  guildId: string;
  /** Andamio API base URL (authenticated read API). No trailing slash. */
  andamioApiBaseUrl: string;
  /**
   * Operator-level Andamio API key (mainnet `ant_mn_…`). SECRET — sent as the
   * `X-API-Key` header on every Andamio API call. Never log or commit it.
   */
  andamioApiKey: string;
  /** Andamio app base URL hosting the CLI login flow. No trailing slash. */
  appLoginBaseUrl: string;
  /** Public https base URL where the bot receives the auth callback. No trailing slash. */
  botCallbackBaseUrl: string;
  /** Path to the role-mappings JSON config file. */
  roleMappingsPath: string;
  /** Path to the SQLite database file. */
  dbPath: string;
}

/** Env vars that must be present and non-empty. */
const REQUIRED_VARS = [
  'DISCORD_TOKEN',
  'DISCORD_APP_ID',
  'GUILD_ID',
  'ANDAMIO_API_BASE_URL',
  'ANDAMIO_API_KEY',
  'APP_LOGIN_BASE_URL',
  'BOT_CALLBACK_BASE_URL',
  'ROLE_MAPPINGS_PATH',
  'DB_PATH',
] as const;

/** Env vars that must parse as valid http(s) URLs. */
const URL_VARS = [
  'ANDAMIO_API_BASE_URL',
  'APP_LOGIN_BASE_URL',
  'BOT_CALLBACK_BASE_URL',
] as const;

function assertValidUrl(name: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid URL for ${name}: "${value}" is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid URL for ${name}: "${value}" must use http or https`);
  }
}

/** Strip a single trailing slash so base URLs concatenate predictably. */
function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * Load and validate configuration from the given environment (defaults to
 * `process.env`). Fails fast, naming the first missing var or malformed URL.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  for (const name of REQUIRED_VARS) {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }

  for (const name of URL_VARS) {
    assertValidUrl(name, env[name] as string);
  }

  return {
    discordToken: env.DISCORD_TOKEN as string,
    discordAppId: env.DISCORD_APP_ID as string,
    guildId: env.GUILD_ID as string,
    andamioApiBaseUrl: stripTrailingSlash(env.ANDAMIO_API_BASE_URL as string),
    andamioApiKey: env.ANDAMIO_API_KEY as string,
    appLoginBaseUrl: stripTrailingSlash(env.APP_LOGIN_BASE_URL as string),
    botCallbackBaseUrl: stripTrailingSlash(env.BOT_CALLBACK_BASE_URL as string),
    roleMappingsPath: env.ROLE_MAPPINGS_PATH as string,
    dbPath: env.DB_PATH as string,
  };
}
