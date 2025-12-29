# gauntlet-draft
Draft bot for for the Discord guild: Arena Gauntlet League

## Prerequisites

- [Deno](https://deno.land/) OR [Nix](https://nixos.org/)

## Setup

1. **Discord Credentials**: Create a `.env` file with your Discord bot token:
   ```
   DISCORD_TOKEN=your_discord_bot_token_here
   ```

2. **Configuration**: Copy `config.json.example` to `private/config.json` and
   fill in the required IDs (OWNER_ID and GUILD_ID).

## Run

Using Deno:

```bash
deno task start bot
```

Using Nix (if available):

```bash
nix run . bot
```

## Development

For development with auto-reload:

```bash
deno task dev
```