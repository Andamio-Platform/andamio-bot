# Andamio Discord Bot

A Discord bot built with Node.js and TypeScript using the discord.js library.

## Features

- Slash command support
- TypeScript for type safety
- Modular command structure
- Environment variable configuration

## Prerequisites

- Node.js 16.9.0 or higher
- npm or yarn
- A Discord account and a Discord application/bot

## Setup

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file based on the `.env.example` template:
   ```
   cp .env.example .env
   ```
4. Fill in your Discord bot token and application ID in the `.env` file

## Creating a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to the "Bot" tab and click "Add Bot"
4. Under the "TOKEN" section, click "Copy" to copy your bot token
5. Paste this token in your `.env` file as `DISCORD_TOKEN`
6. Under "OAuth2" > "URL Generator", select the following scopes:
   - `bot`
   - `applications.commands`
7. Select the following bot permissions:
   - "Send Messages"
   - "Use Slash Commands"
   - Any other permissions your bot needs
8. Copy the generated URL and open it in your browser to add the bot to your server

## Development

1. Build the TypeScript code:
   ```
   npm run build
   ```
2. Deploy slash commands to your test server:
   ```
   npm run deploy
   ```
3. Start the bot in development mode:
   ```
   npm run dev
   ```

## Adding New Commands

1. Create a new file in the `src/commands` directory
2. Export a `data` object with the command definition
3. Export an `execute` function to handle the command
4. The command will be automatically loaded by the bot

## License

MIT
