# MCP Sidekick

A collection of [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) servers that give LLMs superpowers — letting them interact with real-world services on your behalf.

## Servers

| Server | npm Package | Description |
|---|---|---|
| [Microsoft To Do](microsoft-todo-mcp-server/) | `@mcp-sidekick/microsoft-todo` | Manage task lists, tasks, reminders, and checklist items via Microsoft Graph |
| [MSX CRM](msx-mcp-server/) | `@mcp-sidekick/msx` | Search and manage Dynamics 365 / MSX CRM opportunities, milestones, accounts, tasks, approvals, and audit history |
| [Spotify](spotify-mcp-server/) | `@mcp-sidekick/spotify` | Control playback, search music, manage playlists, and explore your library |

## Quick Start

Each server can be installed and run independently. Pick the one you need:

```bash
# Microsoft To Do
cd microsoft-todo-mcp-server
npm install && npm run build

# MSX CRM
cd ../msx-mcp-server
npm install && npm test
az login --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47

# Spotify
cd ../spotify-mcp-server
npm install && npm run build
```

Then configure your MCP client (e.g. VS Code) — see the individual server READMEs for setup instructions and authentication requirements.

## Prerequisites

- Node.js >= 18
- Service-specific authentication (see individual READMEs)

## Repository Structure

```
mcp-sidekick/
├── microsoft-todo-mcp-server/   # Microsoft To Do MCP server
│   └── src/
├── msx-mcp-server/              # Dynamics 365 / MSX CRM MCP server
│   └── src/
└── spotify-mcp-server/          # Spotify MCP server
    └── src/
```

## Publishing

Packages are published to npm by the `Publish to npm` GitHub Actions workflow, which uses the `NPM_TOKEN` repository secret. Bump the package version, then push a tag of the form `<name>-v<version>`, such as `msx-v1.0.0` for `msx-mcp-server`. You can also run the workflow manually from the Actions tab.

## License

See individual server directories for license details.
