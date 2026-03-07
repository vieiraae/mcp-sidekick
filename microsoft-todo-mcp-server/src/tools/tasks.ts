import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphClient, handleGraphError, formatDateTime, formatStatus, formatImportance } from "../graph-client.js";
import type { TodoTask } from "../types.js";

export function registerTaskTools(server: McpServer, client: GraphClient): void {

  server.registerTool(
    "todo_get_tasks",
    {
      title: "Get Tasks",
      description: `Get tasks from a Microsoft To Do task list.

Args:
  - list_id (string): ID of the task list
  - filter (string, optional): OData filter expression (e.g. "status eq 'notStarted'", "importance eq 'high'")
  - top (number, optional): Max tasks to return, 1-100 (default: 50)
  - skip (number, optional): Number of tasks to skip for pagination (default: 0)

Returns:
  Tasks with title, status, importance, due date, and other details.`,
      inputSchema: {
        list_id: z.string().describe("Task list ID"),
        filter: z.string().optional().describe("OData $filter expression"),
        top: z.number().int().min(1).max(100).default(50).describe("Max tasks to return"),
        skip: z.number().int().min(0).default(0).describe("Pagination offset"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ list_id, filter, top, skip }) => {
      try {
        const params: Record<string, string | number | undefined> = {
          $top: top,
          $skip: skip,
          $orderby: "createdDateTime desc",
        };
        if (filter) {
          params.$filter = filter;
        }

        const data = await client.request<{ value: TodoTask[] }>(
          `me/todo/lists/${encodeURIComponent(list_id)}/tasks`,
          "GET",
          undefined,
          params
        );

        if (!data.value.length) {
          return { content: [{ type: "text", text: "No tasks found in this list." }] };
        }

        const lines = data.value.map((task) => {
          const parts = [
            `- ${task.status === "completed" ? "✅" : "⬜"} **${task.title}**`,
            `  Status: ${formatStatus(task.status)} | Importance: ${formatImportance(task.importance)}`,
          ];
          if (task.dueDateTime) {
            parts.push(`  Due: ${formatDateTime(task.dueDateTime)}`);
          }
          if (task.body?.content) {
            const bodyPreview = task.body.content.substring(0, 100);
            parts.push(`  Notes: ${bodyPreview}${task.body.content.length > 100 ? "..." : ""}`);
          }
          parts.push(`  ID: ${task.id}`);
          return parts.join("\n");
        });

        return { content: [{ type: "text", text: `**Tasks:**\n${lines.join("\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  server.registerTool(
    "todo_get_task",
    {
      title: "Get Task Details",
      description: `Get detailed information about a specific task.

Args:
  - list_id (string): ID of the task list
  - task_id (string): ID of the task`,
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
        const task = await client.request<TodoTask>(
          `me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}`
        );

        const lines = [
          `**Task**: ${task.title}`,
          `**Status**: ${formatStatus(task.status)}`,
          `**Importance**: ${formatImportance(task.importance)}`,
          `**Created**: ${new Date(task.createdDateTime).toLocaleString()}`,
          `**Last Modified**: ${new Date(task.lastModifiedDateTime).toLocaleString()}`,
        ];

        if (task.dueDateTime) lines.push(`**Due**: ${formatDateTime(task.dueDateTime)}`);
        if (task.completedDateTime) lines.push(`**Completed**: ${formatDateTime(task.completedDateTime)}`);
        if (task.isReminderOn && task.reminderDateTime) lines.push(`**Reminder**: ${formatDateTime(task.reminderDateTime)}`);
        if (task.body?.content) lines.push(`**Notes**: ${task.body.content}`);
        if (task.categories.length) lines.push(`**Categories**: ${task.categories.join(", ")}`);
        if (task.recurrence) lines.push(`**Recurrence**: ${task.recurrence.pattern.type} every ${task.recurrence.pattern.interval}`);
        lines.push(`**ID**: ${task.id}`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  server.registerTool(
    "todo_create_task",
    {
      title: "Create Task",
      description: `Create a new task in a Microsoft To Do task list.

Args:
  - list_id (string): ID of the task list to add the task to
  - title (string): Title of the task
  - body (string, optional): Notes/body content for the task
  - importance (string, optional): "low", "normal", or "high" (default: "normal")
  - dueDateTime (string, optional): Due date in ISO 8601 format (e.g. "2025-12-31T23:59:00")
  - timeZone (string, optional): Time zone for dueDateTime (default: "UTC")
  - reminderDateTime (string, optional): Reminder date/time in ISO 8601 format
  - categories (string[], optional): Category labels for the task`,
      inputSchema: {
        list_id: z.string().describe("Task list ID"),
        title: z.string().min(1).max(1024).describe("Task title"),
        body: z.string().max(10000).optional().describe("Task notes/body content"),
        importance: z.enum(["low", "normal", "high"]).default("normal").describe("Task importance"),
        dueDateTime: z.string().optional().describe("Due date in ISO 8601 format"),
        timeZone: z.string().default("UTC").describe("Time zone for dates"),
        reminderDateTime: z.string().optional().describe("Reminder date/time in ISO 8601 format"),
        categories: z.array(z.string()).optional().describe("Category labels"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ list_id, title, body, importance, dueDateTime, timeZone, reminderDateTime, categories }) => {
      try {
        const taskData: Record<string, unknown> = {
          title,
          importance,
        };

        if (body) {
          taskData.body = { content: body, contentType: "text" };
        }
        if (dueDateTime) {
          taskData.dueDateTime = { dateTime: dueDateTime, timeZone };
        }
        if (reminderDateTime) {
          taskData.isReminderOn = true;
          taskData.reminderDateTime = { dateTime: reminderDateTime, timeZone };
        }
        if (categories?.length) {
          taskData.categories = categories;
        }

        const task = await client.request<TodoTask>(
          `me/todo/lists/${encodeURIComponent(list_id)}/tasks`,
          "POST",
          taskData
        );

        return {
          content: [{
            type: "text",
            text: `Task created: **${task.title}**\nID: ${task.id}\nStatus: ${formatStatus(task.status)}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  server.registerTool(
    "todo_update_task",
    {
      title: "Update Task",
      description: `Update an existing task's properties.

Args:
  - list_id (string): Task list ID
  - task_id (string): Task ID to update
  - title (string, optional): New title
  - body (string, optional): New notes/body content
  - importance (string, optional): "low", "normal", or "high"
  - status (string, optional): "notStarted", "inProgress", "completed", "waitingOnOthers", or "deferred"
  - dueDateTime (string, optional): Due date in ISO 8601 format (set to empty string to clear)
  - timeZone (string, optional): Time zone for dates (default: "UTC")
  - reminderDateTime (string, optional): Reminder date/time in ISO 8601 format
  - categories (string[], optional): Category labels`,
      inputSchema: {
        list_id: z.string().describe("Task list ID"),
        task_id: z.string().describe("Task ID"),
        title: z.string().min(1).max(1024).optional().describe("New task title"),
        body: z.string().max(10000).optional().describe("New notes/body"),
        importance: z.enum(["low", "normal", "high"]).optional().describe("Task importance"),
        status: z.enum(["notStarted", "inProgress", "completed", "waitingOnOthers", "deferred"]).optional().describe("Task status"),
        dueDateTime: z.string().optional().describe("Due date in ISO 8601 (empty to clear)"),
        timeZone: z.string().default("UTC").describe("Time zone for dates"),
        reminderDateTime: z.string().optional().describe("Reminder date/time in ISO 8601"),
        categories: z.array(z.string()).optional().describe("Category labels"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ list_id, task_id, title, body, importance, status, dueDateTime, timeZone, reminderDateTime, categories }) => {
      try {
        const patch: Record<string, unknown> = {};

        if (title !== undefined) patch.title = title;
        if (importance !== undefined) patch.importance = importance;
        if (status !== undefined) patch.status = status;
        if (body !== undefined) patch.body = { content: body, contentType: "text" };
        if (categories !== undefined) patch.categories = categories;

        if (dueDateTime !== undefined) {
          patch.dueDateTime = dueDateTime === "" ? null : { dateTime: dueDateTime, timeZone };
        }
        if (reminderDateTime !== undefined) {
          if (reminderDateTime === "") {
            patch.isReminderOn = false;
            patch.reminderDateTime = null;
          } else {
            patch.isReminderOn = true;
            patch.reminderDateTime = { dateTime: reminderDateTime, timeZone };
          }
        }

        const task = await client.request<TodoTask>(
          `me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}`,
          "PATCH",
          patch
        );

        return {
          content: [{
            type: "text",
            text: `Task updated: **${task.title}**\nStatus: ${formatStatus(task.status)} | Importance: ${formatImportance(task.importance)}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  server.registerTool(
    "todo_complete_task",
    {
      title: "Complete Task",
      description: `Mark a task as completed.

Args:
  - list_id (string): Task list ID
  - task_id (string): Task ID to complete`,
      inputSchema: {
        list_id: z.string().describe("Task list ID"),
        task_id: z.string().describe("Task ID to complete"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ list_id, task_id }) => {
      try {
        const task = await client.request<TodoTask>(
          `me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}`,
          "PATCH",
          { status: "completed" }
        );
        return { content: [{ type: "text", text: `✅ Task completed: **${task.title}**` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );

  server.registerTool(
    "todo_delete_task",
    {
      title: "Delete Task",
      description: `Permanently delete a task.

Args:
  - list_id (string): Task list ID
  - task_id (string): Task ID to delete

⚠️ This permanently deletes the task.`,
      inputSchema: {
        list_id: z.string().describe("Task list ID"),
        task_id: z.string().describe("Task ID to delete"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ list_id, task_id }) => {
      try {
        await client.requestNoContent(
          `me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}`,
          "DELETE"
        );
        return { content: [{ type: "text", text: `Task ${task_id} deleted.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleGraphError(error) }] };
      }
    }
  );
}
