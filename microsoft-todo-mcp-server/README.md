# Microsoft To Do MCP Server

Part of the [MCP Sidekick](https://github.com/vieiraae/mcp-sidekick) project.

An MCP (Model Context Protocol) server that enables LLMs to manage Microsoft To Do — create and organize task lists, manage tasks, set reminders, and work with checklist items via the Microsoft Graph API.

## Prerequisites

- Node.js >= 18
- A **Microsoft Entra ID (Azure AD)** app registration with:
  - **Application (client) ID**
  - **Client Secret**
  - **Redirect URI** set to `http://localhost:3333/callback`
  - **API permissions**: `Tasks.ReadWrite` and `User.Read` (delegated)

## Setup

1. **Register an app** at https://portal.azure.com → Azure Active Directory → App registrations → New registration
   - Set **Redirect URI** to `http://localhost:3333/callback` (type: Web)
   - Under **Certificates & secrets**, create a new client secret
   - Under **API permissions**, add Microsoft Graph delegated permissions:
     - `Tasks.ReadWrite`
     - `User.Read`

2. **Install & Build**
   ```bash
   cd microsoft-todo-mcp-server
   npm install
   npm run build
   ```

3. **Configure in your MCP client** — create a `.vscode/mcp.json` file in your project (add it to `.gitignore` to keep secrets out of source control):
   ```json
   {
     "inputs": [
       {
         "type": "promptString",
         "id": "todo-client-id",
         "description": "Microsoft To Do Client ID",
         "password": true
       },
       {
         "type": "promptString",
         "id": "todo-client-secret",
         "description": "Microsoft To Do Client Secret",
         "password": true
       }
     ],
     "servers": {
       "microsoft-todo": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "@mcp-sidekick/microsoft-todo"],
         "env": {
           "MICROSOFT_TODO_CLIENT_ID": "${input:todo-client-id}",
           "MICROSOFT_TODO_CLIENT_SECRET": "${input:todo-client-secret}",
           "MICROSOFT_TODO_REDIRECT_URI": "http://localhost:3333/callback"
         }
       }
     }
   }
   ```

4. **First run** — on the first tool call, the server will open your browser for Microsoft sign-in. After granting access, tokens are stored locally at `~/.microsoft-todo-mcp-tokens.json` and auto-refreshed.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MICROSOFT_TODO_CLIENT_ID` | Yes | Azure AD app Client ID |
| `MICROSOFT_TODO_CLIENT_SECRET` | Yes | Azure AD app Client Secret |
| `MICROSOFT_TODO_REDIRECT_URI` | No | OAuth callback URL (default: `http://localhost:3333/callback`) |
| `MICROSOFT_TODO_TENANT_ID` | No | Azure AD tenant ID (default: `common` for multi-tenant) |

## Available Tools

### Task Lists
| Tool | Description |
|---|---|
| `todo_get_lists` | Get all task lists |
| `todo_create_list` | Create a new task list |
| `todo_update_list` | Rename a task list |
| `todo_delete_list` | Delete a task list and all its tasks |

### Tasks
| Tool | Description |
|---|---|
| `todo_get_tasks` | Get tasks from a list (with optional OData filter) |
| `todo_get_task` | Get detailed info about a specific task |
| `todo_create_task` | Create a task with title, body, importance, due date, reminder, categories |
| `todo_update_task` | Update any task properties |
| `todo_complete_task` | Mark a task as completed |
| `todo_delete_task` | Permanently delete a task |

### Checklist Items (Subtasks)
| Tool | Description |
|---|---|
| `todo_get_checklist_items` | Get checklist items for a task |
| `todo_create_checklist_item` | Add a checklist item to a task |
| `todo_update_checklist_item` | Update a checklist item's text or checked state |
| `todo_delete_checklist_item` | Delete a checklist item |

## Filtering Tasks

The `todo_get_tasks` tool supports OData `$filter` expressions:

```
status eq 'notStarted'
importance eq 'high'
status ne 'completed'
contains(title, 'meeting')
dueDateTime/dateTime lt '2025-12-31'
```
