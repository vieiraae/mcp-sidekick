import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphClient, handleGraphError } from "../graph-client.js";
import type { TodoTaskList } from "../types.js";

export function registerListTools(server: McpServer, client: GraphClient): void {

  server.registerTool(
    "todo_get_lists",
    {
      title: "Get Task Lists",
      description: `Get all of the user's Microsoft To Do task lists.

Returns:
  All task lists with their ID, name, and whether they are owned or shared.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const data = await client.request<{ value: TodoTaskList[] }>("me/todo/lists");
        if (!data.value.length) {
          return { content: [{ type: "text", text: "No task lists found." }] };
        }
        const lines = data.value.map(
          (list) => `- **${list.displayName}** | ID: ${list.id} | ${list.wellknownListName === "defaultList" ? "📌 Default" : ""} ${list.isShared ? "🔗 Shared" : ""}`
        );
        return { content: [{ type: "text", text: `**Your Task Lists:**\n${lines.join("\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  server.registerTool(
    "todo_create_list",
    {
      title: "Create Task List",
      description: `Create a new Microsoft To Do task list.

Args:
  - displayName (string): Name of the new task list`,
      inputSchema: {
        displayName: z.string().min(1).max(256).describe("Name of the new task list"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ displayName }) => {
      try {
        const list = await client.request<TodoTaskList>("me/todo/lists", "POST", { displayName });
        return {
          content: [{
            type: "text",
            text: `Task list created: **${list.displayName}**\nID: ${list.id}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  server.registerTool(
    "todo_update_list",
    {
      title: "Update Task List",
      description: `Rename a Microsoft To Do task list.

Args:
  - list_id (string): ID of the task list to update
  - displayName (string): New name for the task list`,
      inputSchema: {
        list_id: z.string().describe("Task list ID"),
        displayName: z.string().min(1).max(256).describe("New name for the task list"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ list_id, displayName }) => {
      try {
        const list = await client.request<TodoTaskList>(
          `me/todo/lists/${encodeURIComponent(list_id)}`,
          "PATCH",
          { displayName }
        );
        return {
          content: [{
            type: "text",
            text: `Task list renamed to: **${list.displayName}**`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  server.registerTool(
    "todo_delete_list",
    {
      title: "Delete Task List",
      description: `Delete a Microsoft To Do task list and all its tasks.

Args:
  - list_id (string): ID of the task list to delete

⚠️ This will permanently delete the list and all tasks in it.`,
      inputSchema: {
        list_id: z.string().describe("Task list ID to delete"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ list_id }) => {
      try {
        await client.requestNoContent(`me/todo/lists/${encodeURIComponent(list_id)}`, "DELETE");
        return { content: [{ type: "text", text: `Task list ${list_id} deleted.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );
}
