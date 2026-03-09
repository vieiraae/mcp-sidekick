import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SpotifyClient, handleSpotifyError, formatDuration } from "../spotify-client.js";
import type { SpotifyPlaybackState } from "../types.js";

export function registerPlaybackTools(server: McpServer, client: SpotifyClient, defaultDeviceId?: string): void {

  server.registerTool(
    "spotify_get_playback",
    {
      title: "Get Current Playback",
      description: `Get information about the user's current playback state including track, device, progress, and shuffle/repeat status.

Returns:
  Current track name, artist, album, progress, device info, shuffle and repeat state.
  Returns a message if nothing is currently playing.`,
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
        const state = await client.request<SpotifyPlaybackState>("me/player");
        if (!state || !state.item) {
          return { content: [{ type: "text", text: "Nothing is currently playing." }] };
        }
        const track = state.item;
        const artists = track.artists.map((a) => a.name).join(", ");
        const text = [
          `**Now Playing**: ${track.name}`,
          `**Artist**: ${artists}`,
          `**Album**: ${track.album.name}`,
          `**Progress**: ${formatDuration(state.progress_ms)} / ${formatDuration(track.duration_ms)}`,
          `**Device**: ${state.device.name} (${state.device.type})`,
          `**Volume**: ${state.device.volume_percent}%`,
          `**Shuffle**: ${state.shuffle_state ? "On" : "Off"}`,
          `**Repeat**: ${state.repeat_state}`,
          `**Track URI**: ${track.uri}`,
          `**Spotify URL**: ${track.external_urls.spotify}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_play",
    {
      title: "Play / Resume",
      description: `Start or resume playback. Optionally play a specific track, album, artist, or playlist by URI.

Args:
  - uri (string, optional): Spotify URI to play (e.g. "spotify:track:xxx", "spotify:album:xxx", "spotify:playlist:xxx")
  - device_id (string, optional): Device ID to play on. If omitted, uses the active device.

Examples:
  - Resume current playback: no params needed
  - Play a specific track: uri="spotify:track:4iV5W9uYEdYUVa79Axb7Rh"
  - Play an album: uri="spotify:album:1DFixLWuPkv3KT3TnV35m3"`,
      inputSchema: {
        uri: z.string().optional().describe("Spotify URI to play (track, album, artist, or playlist)"),
        device_id: z.string().optional().describe("Target device ID"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ uri, device_id }) => {
      try {
        const body: Record<string, unknown> = {};
        if (uri) {
          if (uri.startsWith("spotify:track:")) {
            body.uris = [uri];
          } else {
            body.context_uri = uri;
          }
        }
        const params: Record<string, string | undefined> = { device_id: device_id ?? defaultDeviceId };
        await client.requestNoContent("me/player/play", "PUT", Object.keys(body).length ? body : undefined, params);
        return { content: [{ type: "text", text: uri ? `Playing: ${uri}` : "Playback resumed." }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_pause",
    {
      title: "Pause Playback",
      description: "Pause the current playback on the active device.",
      inputSchema: {
        device_id: z.string().optional().describe("Target device ID"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ device_id }) => {
      try {
        await client.requestNoContent("me/player/pause", "PUT", undefined, { device_id: device_id ?? defaultDeviceId });
        return { content: [{ type: "text", text: "Playback paused." }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_next",
    {
      title: "Skip to Next Track",
      description: "Skip to the next track in the queue.",
      inputSchema: {
        device_id: z.string().optional().describe("Target device ID"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ device_id }) => {
      try {
        await client.requestNoContent("me/player/next", "POST", undefined, { device_id: device_id ?? defaultDeviceId });
        return { content: [{ type: "text", text: "Skipped to next track." }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_previous",
    {
      title: "Skip to Previous Track",
      description: "Skip to the previous track.",
      inputSchema: {
        device_id: z.string().optional().describe("Target device ID"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ device_id }) => {
      try {
        await client.requestNoContent("me/player/previous", "POST", undefined, { device_id: device_id ?? defaultDeviceId });
        return { content: [{ type: "text", text: "Skipped to previous track." }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_set_volume",
    {
      title: "Set Volume",
      description: `Set the playback volume (0-100).

Args:
  - volume_percent (number): Volume level from 0 to 100`,
      inputSchema: {
        volume_percent: z.number().int().min(0).max(100).describe("Volume level (0-100)"),
        device_id: z.string().optional().describe("Target device ID"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ volume_percent, device_id }) => {
      try {
        await client.requestNoContent("me/player/volume", "PUT", undefined, {
          volume_percent,
          device_id: device_id ?? defaultDeviceId,
        });
        return { content: [{ type: "text", text: `Volume set to ${volume_percent}%.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_shuffle",
    {
      title: "Toggle Shuffle",
      description: `Turn shuffle on or off.

Args:
  - state (boolean): true to enable shuffle, false to disable`,
      inputSchema: {
        state: z.boolean().describe("true = shuffle on, false = shuffle off"),
        device_id: z.string().optional().describe("Target device ID"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ state, device_id }) => {
      try {
        await client.requestNoContent("me/player/shuffle", "PUT", undefined, {
          state,
          device_id: device_id ?? defaultDeviceId,
        });
        return { content: [{ type: "text", text: `Shuffle ${state ? "enabled" : "disabled"}.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_repeat",
    {
      title: "Set Repeat Mode",
      description: `Set the repeat mode for playback.

Args:
  - state: "track" to repeat the current track, "context" to repeat the current context (album/playlist), or "off" to disable repeat`,
      inputSchema: {
        state: z.enum(["track", "context", "off"]).describe("Repeat mode: 'track', 'context', or 'off'"),
        device_id: z.string().optional().describe("Target device ID"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ state, device_id }) => {
      try {
        await client.requestNoContent("me/player/repeat", "PUT", undefined, {
          state,
          device_id: device_id ?? defaultDeviceId,
        });
        return { content: [{ type: "text", text: `Repeat mode set to "${state}".` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_add_to_queue",
    {
      title: "Add to Queue",
      description: `Add a track to the end of the user's playback queue.

Args:
  - uri (string): Spotify track URI (e.g. "spotify:track:4iV5W9uYEdYUVa79Axb7Rh")`,
      inputSchema: {
        uri: z.string().describe("Spotify track URI to add to the queue"),
        device_id: z.string().optional().describe("Target device ID"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ uri, device_id }) => {
      try {
        await client.requestNoContent("me/player/queue", "POST", undefined, { uri, device_id: device_id ?? defaultDeviceId });
        return { content: [{ type: "text", text: `Added ${uri} to the queue.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_get_devices",
    {
      title: "Get Available Devices",
      description: "Get a list of the user's available Spotify devices.",
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
        const data = await client.request<{
          devices: { id: string; name: string; type: string; is_active: boolean; volume_percent: number }[];
        }>("me/player/devices");

        if (!data.devices.length) {
          return { content: [{ type: "text", text: "No active Spotify devices found. Open Spotify on a device first." }] };
        }

        const lines = data.devices.map(
          (d) => `- **${d.name}** (${d.type}) ${d.is_active ? "✓ Active" : ""} | Volume: ${d.volume_percent}% | ID: ${d.id}`
        );
        return { content: [{ type: "text", text: `**Available Devices:**\n${lines.join("\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_transfer_playback",
    {
      title: "Transfer Playback",
      description: `Transfer playback to a different device.

Args:
  - device_id (string): The ID of the device to transfer to (use spotify_get_devices to find IDs)
  - play (boolean, optional): true to start playing on the new device, false to keep current state`,
      inputSchema: {
        device_id: z.string().describe("Target device ID"),
        play: z.boolean().optional().default(true).describe("Whether to start playing on the new device"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ device_id, play }) => {
      try {
        const targetDevice = device_id ?? defaultDeviceId;
        if (!targetDevice) {
          return { content: [{ type: "text", text: "Error: device_id is required for transfer playback." }] };
        }
        await client.requestNoContent("me/player", "PUT", {
          device_ids: [targetDevice],
          play,
        });
        return { content: [{ type: "text", text: `Playback transferred to device ${device_id}.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );
}
