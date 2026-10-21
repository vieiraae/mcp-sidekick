# MSX MCP Server

An MCP server for Microsoft Dynamics 365 / MSX CRM, adapted from Microsoft's [MSX-IQ `mcp/msx` implementation](https://github.com/mcaps-microsoft/MSX-IQ/tree/main/mcp/msx). It provides CRM search and record access, opportunity and milestone workflows, territory intelligence, task/contact/account management, staged write approvals, and an audit log.

By default, the server gets CRM access tokens from the Azure CLI. Tokens are held only in process memory and are never written to disk or logged. The server calls `az account get-access-token` again when no token is cached, when the cached token expires within two minutes, or when CRM rejects it with HTTP 401.

## Requirements

- Node.js 20 or newer
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), signed in to the MSX tenant
- Access to the relevant Dynamics 365 environment

## Install and run

```bash
cd msx-mcp-server
npm install
az login --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47
npm run auth   # optional: checks that Azure CLI can issue an MSX CRM token
npm start
```

Your active Azure CLI subscription can belong to another tenant. The server always requests the token for `MSX_TENANT_ID`.

### MSAL fallback

To use the MSX-IQ-compatible MSAL cache instead of the Azure CLI, set `MSX_AUTH_SOURCE=msal`. In this mode, `npm run auth` starts device-code sign-in and stores the MSAL cache at `~/.msx-iq/enghub-msal-cache.json` by default. Some Conditional Access policies block device-code sign-in from unmanaged devices.

For development and tests:

```bash
npm test
npm run test:watch
```

## MCP client configuration

For VS Code, add this server to `.vscode/mcp.json`:

```json
{
  "servers": {
    "msx": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@mcp-sidekick/msx"]
    }
  }
}
```

To run from a local checkout instead:

```json
{
  "servers": {
    "msx": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-sidekick/msx-mcp-server/src/index.js"],
      "env": {
        "MSX_CRM_URL": "https://microsoftsales.crm.dynamics.com",
        "MSX_TENANT_ID": "72f988bf-86f1-41af-91ab-2d7cd011db47"
      }
    }
  }
}
```

Do not put access tokens in `mcp.json`. If the MCP client cannot find `az` on its `PATH`, set `MSX_AZ_PATH` to the full executable path, such as `/opt/homebrew/bin/az`.

## Configuration

| Variable | Required | Default | Description |
|---|---:|---|---|
| `MSX_CRM_URL` | No | `https://microsoftsales.crm.dynamics.com` | Dynamics 365 environment URL |
| `MSX_TENANT_ID` | No | Microsoft tenant ID | Entra tenant used for sign-in and token acquisition |
| `MSX_AUTH_SOURCE` | No | `azure-cli` | Token source: `azure-cli` or `msal` |
| `MSX_AZ_PATH` | No | `az` on `PATH` | Azure CLI executable path |
| `MSX_CLIENT_ID` | No | Azure CLI public client ID | MSAL public client ID (`msal` mode only) |
| `MSX_MCP_CACHE_PATH` | No | `~/.msx-iq/enghub-msal-cache.json` | Shared MSAL cache file path (`msal` mode only) |
| `MSX_USER_DATA` | No | `~/.msx-iq-data` | Directory for approval queue and audit log data |

Keep the user data directory, and the MSAL cache if you use `msal` mode, private to your account.

## Safety and approvals

CRM writes are staged in a local approval queue before execution. Review the staged changes and explicitly approve/execute them with the approval tools. The server also stores a local audit log of write activity. The available tools include read-only CRM and territory queries, opportunity and milestone operations, task/contact/account operations, solution-play management, approval queue management, and audit-log queries.

See [SECURITY.md](SECURITY.md) for Microsoft security reporting guidance. This package retains the upstream [MIT license](LICENSE.md).
