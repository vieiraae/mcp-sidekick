import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphClient, handleGraphError } from "../graph-client.js";
import type { ChecklistItem } from "../types.js";

export function registerChecklistTools(server: McpServer, client: GraphClient): void {

  server.registerTool(
    "todo_get_checklist_items",
    {
      title: "Get Checklist Items",
      description: `Get the checklist items (subtasks) of a task.

Args:
  - list_id (string): Task list ID
  - task_id (string): Task ID`,
      inputSchema: {
        list_id: z.string().describe("Task list ID"),
        task_id: z.string().describe("Task ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ list_id, task_id }) => {
      try {
        const data = await client.request<{ value: ChecklistItem[] }>(
          `me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/checklistItems`
        );

        if (!data.value.length) {
          return { content: [{ type: "text", text: "No checklist items found for this task." }] };
        }

        const lines = data.value.map(
          (item) => `- ${item.isChecked ? "☑️" : "⬜"} ${item.displayName} | ID: ${item.id}`
        );
        return { content: [{ type: "text", text: `**Checklist Items:**\n${lines.join("\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  server.registerTool(
    "todo_create_checklist_item",
    {
      title: "Create Checklist Item",
      description: `Add a checklist item (subtask) to a task.

Args:
  - list_id (string): Task list ID
  - task_id (string): Task ID
  - displayName (string): Text of the checklist item
  - isChecked (boolean, optional): Whether the item starts checked (default: false)`,
      inputSchema: {
        list_id: z.string().describe("Task list ID"),
        task_id: z.string().describe("Task ID"),
        displayName: z.string().min(1).max(256).describe("Checklist item text"),
        isChecked: z.boolean().default(false).describe("Whether the item is checked"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ list_id, task_id, displayName, isChecked }) => {
      try {
        const item = await client.request<ChecklistItem>(
          `me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/checklistItems`,
          "POST",
          { displayName, isChecked }
        );
        return {
          content: [{
            type: "text",
            text: `Checklist item created: ${item.isChecked ? "☑️" : "⬜"} **${item.displayName}**\nID: ${item.id}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  server.registerTool(
    "todo_update_checklist_item",
    {
      title: "Update Checklist Item",
      description: `Update a checklist item's text or checked state.

Args:
  - list_id (string): Task list ID
  - task_id (string): Task ID
  - item_id (string): Checklist item ID
  - displayName (string, optional): New text
  - isChecked (boolean, optional): New checked state`,
      inputSchema: {
        list_id: z.string().describe("Task list ID"),
        task_id: z.string().describe("Task ID"),
        item_id: z.string().describe("Checklist item ID"),
        displayName: z.string().min(1).max(256).optional().describe("New text"),
        isChecked: z.boolean().optional().describe("New checked state"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ list_id, task_id, item_id, displayName, isChecked }) => {
      try {
        const patch: Record<string, unknown> = {};
        if (displayName !== undefined) patch.displayName = displayName;
        if (isChecked !== undefined) patch.isChecked = isChecked;

        const item = await client.request<ChecklistItem>(
          `me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/checklistItems/${encodeURIComponent(item_id)}`,
          "PATCH",
          patch
        );
        return {
          content: [{
            type: "text",
            text: `Checklist item updated: ${item.isChecked ? "☑️" : "⬜"} **${item.displayName}**`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  server.registerTool(
    "todo_delete_checklist_item",
    {
      title: "Delete Checklist Item",
      description: `Delete a checklist item from a task.

Args:
  - list_id (string): Task list ID
  - task_id (string): Task ID
  - item_id (string): Checklist item ID to delete`,
      inputSchema: {
        list_id: z.string().describe("Task list ID"),
        task_id: z.string().describe("Task ID"),
        item_id: z.string().describe("Checklist item ID"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ list_id, task_id, item_id }) => {
      try {
        await client.requestNoContent(
          `me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/checklistItems/${encodeURIComponent(item_id)}`,
          "DELETE"
        );
        return { content: [{ type: "text", text: `Checklist item ${item_id} deleted.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );
}
