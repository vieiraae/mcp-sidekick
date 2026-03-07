# MCP Sidekick

A collection of [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) servers that give LLMs superpowers — letting them interact with real-world services on your behalf.

## Servers

| Server | npm Package | Description |
|---|---|---|
| [Microsoft To Do](microsoft-todo-mcp-server/) | `@mcp-sidekick/microsoft-todo` | Manage task lists, tasks, reminders, and checklist items via Microsoft Graph |
| [Spotify](spotify-mcp-server/) | `@mcp-sidekick/spotify` | Control playback, search music, manage playlists, and explore your library |

## Quick Start

Each server can be installed and run independently. Pick the one you need:

```bash
# Microsoft To Do
cd microsoft-todo-mcp-server
npm install && npm run build

# Spotify
cd spotify-mcp-server
npm install && npm run build
```

Then configure your MCP client (e.g. VS Code) — see the individual server READMEs for full setup instructions including OAuth configuration.

## Prerequisites

- Node.js >= 18
- OAuth credentials for each service you want to use (see individual READMEs)

## Repository Structure

```
mcp-sidekick/
├── microsoft-todo-mcp-server/   # Microsoft To Do MCP server
│   └── src/
└── spotify-mcp-server/          # Spotify MCP server
    └── src/
```

## License

See individual server directories for license details.
