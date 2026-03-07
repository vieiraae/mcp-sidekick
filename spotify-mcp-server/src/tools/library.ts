import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SpotifyClient, handleSpotifyError } from "../spotify-client.js";
import type { SpotifyPlaylist, SpotifyTrack } from "../types.js";

export function registerLibraryTools(server: McpServer, client: SpotifyClient): void {

  server.registerTool(
    "spotify_get_playlists",
    {
      title: "Get User Playlists",
      description: `Get the current user's playlists.

Args:
  - limit (number): Max playlists to return, 1-50 (default: 20)
  - offset (number): Pagination offset (default: 0)`,
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20).describe("Max playlists to return"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit, offset }) => {
      try {
        const data = await client.request<{ items: SpotifyPlaylist[]; total: number }>(
          "me/playlists",
          "GET",
          undefined,
          { limit, offset }
        );
        if (!data.items.length) {
          return { content: [{ type: "text", text: "No playlists found." }] };
        }
        const lines = data.items.map(
          (pl) => {
            const cover = pl.images?.[0]?.url ? ` | Cover: ${pl.images[0].url}` : "";
            return `- **${pl.name}** (${pl.tracks.total} tracks) ${pl.public ? "Public" : "Private"} | URI: ${pl.uri}${cover}`;
          }
        );
        return {
          content: [{
            type: "text",
            text: `**Your Playlists (${data.total} total):**\n${lines.join("\n")}${data.total > offset + data.items.length ? `\n\n_More playlists available. Use offset=${offset + limit} to see more._` : ""}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_get_playlist",
    {
      title: "Get Playlist Details",
      description: `Get detailed information about a playlist including its tracks.

Args:
  - playlist_id (string): Spotify playlist ID
  - limit (number): Max tracks to return, 1-100 (default: 50)
  - offset (number): Track pagination offset (default: 0)`,
      inputSchema: {
        playlist_id: z.string().describe("Spotify playlist ID"),
        limit: z.number().int().min(1).max(100).default(50).describe("Max tracks to return"),
        offset: z.number().int().min(0).default(0).describe("Track pagination offset"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ playlist_id, limit, offset }) => {
      try {
        const pl = await client.request<
          SpotifyPlaylist & {
            tracks: {
              items: { track: SpotifyTrack; added_at: string }[];
              total: number;
            };
          }
        >(`playlists/${encodeURIComponent(playlist_id)}`, "GET", undefined, {
          fields: "id,name,description,owner(id,display_name),public,uri,external_urls,images,tracks(total,items(added_at,track(id,name,artists(name),duration_ms,uri)))",
          limit,
          offset,
        });

        const trackLines = pl.tracks.items
          .map((item, i) => {
            const t = item.track;
            const artists = t.artists.map((a) => a.name).join(", ");
            return `  ${offset + i + 1}. ${t.name} - ${artists} | URI: ${t.uri}`;
          })
          .join("\n");

        const text = [
          `**Playlist**: ${pl.name}`,
          `**Owner**: ${pl.owner.display_name}`,
          `**Description**: ${pl.description || "N/A"}`,
          `**Total Tracks**: ${pl.tracks.total}`,
          `**Public**: ${pl.public ? "Yes" : "No"}`,
          `**URI**: ${pl.uri}`,
          ...(pl.images?.length ? [`**Cover**: ${pl.images[0].url}`] : []),
          ``,
          `**Tracks:**`,
          trackLines,
          pl.tracks.total > offset + pl.tracks.items.length
            ? `\n_More tracks available. Use offset=${offset + limit} to see more._`
            : "",
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_get_playlist_cover",
    {
      title: "Get Playlist Cover Image",
      description: `Get the cover image(s) for a playlist.

Args:
  - playlist_id (string): Spotify playlist ID

Returns:
  Cover image URLs at available sizes.`,
      inputSchema: {
        playlist_id: z.string().describe("Spotify playlist ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ playlist_id }) => {
      try {
        const images = await client.request<{ url: string; width: number | null; height: number | null }[]>(
          `playlists/${encodeURIComponent(playlist_id)}/images`
        );

        if (!images.length) {
          return { content: [{ type: "text", text: "No cover image found for this playlist." }] };
        }

        const content = images.map((img) => {
          const size = img.width && img.height ? `${img.width}x${img.height}` : "original";
          return { type: "text" as const, text: `**${size}**: ${img.url}` };
        });

        return { content };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_create_playlist",
    {
      title: "Create Playlist",
      description: `Create a new playlist for the current user.

Args:
  - name (string): Name of the playlist
  - description (string, optional): Description of the playlist
  - public (boolean, optional): Whether the playlist is public (default: false)`,
      inputSchema: {
        name: z.string().min(1).max(200).describe("Playlist name"),
        description: z.string().max(300).optional().describe("Playlist description"),
        public: z.boolean().optional().default(false).describe("Whether the playlist is public"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, description, public: isPublic }) => {
      try {
        // Get current user ID
        const me = await client.request<{ id: string }>("me");
        const playlist = await client.request<SpotifyPlaylist>(
          `users/${encodeURIComponent(me.id)}/playlists`,
          "POST",
          { name, description: description ?? "", public: isPublic }
        );
        return {
          content: [{
            type: "text",
            text: `Playlist created: **${playlist.name}**\nURI: ${playlist.uri}\nURL: ${playlist.external_urls.spotify}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_add_tracks_to_playlist",
    {
      title: "Add Tracks to Playlist",
      description: `Add one or more tracks to a playlist.

Args:
  - playlist_id (string): Spotify playlist ID
  - uris (string[]): Array of Spotify track URIs to add (e.g. ["spotify:track:xxx", "spotify:track:yyy"])
  - position (number, optional): Position to insert at (0-based). Omit to append to the end.`,
      inputSchema: {
        playlist_id: z.string().describe("Spotify playlist ID"),
        uris: z.array(z.string()).min(1).max(100).describe("Track URIs to add"),
        position: z.number().int().min(0).optional().describe("Insert position (0-based)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ playlist_id, uris, position }) => {
      try {
        const body: Record<string, unknown> = { uris };
        if (position !== undefined) {
          body.position = position;
        }
        await client.request(
          `playlists/${encodeURIComponent(playlist_id)}/tracks`,
          "POST",
          body
        );
        return {
          content: [{
            type: "text",
            text: `Added ${uris.length} track(s) to playlist ${playlist_id}.`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_remove_tracks_from_playlist",
    {
      title: "Remove Tracks from Playlist",
      description: `Remove one or more tracks from a playlist.

Args:
  - playlist_id (string): Spotify playlist ID
  - uris (string[]): Array of Spotify track URIs to remove`,
      inputSchema: {
        playlist_id: z.string().describe("Spotify playlist ID"),
        uris: z.array(z.string()).min(1).max(100).describe("Track URIs to remove"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ playlist_id, uris }) => {
      try {
        await client.request(
          `playlists/${encodeURIComponent(playlist_id)}/tracks`,
          "DELETE",
          { tracks: uris.map((uri) => ({ uri })) }
        );
        return {
          content: [{
            type: "text",
            text: `Removed ${uris.length} track(s) from playlist ${playlist_id}.`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_get_saved_tracks",
    {
      title: "Get Saved Tracks",
      description: `Get the user's saved/liked tracks.

Args:
  - limit (number): Max tracks to return, 1-50 (default: 20)
  - offset (number): Pagination offset (default: 0)`,
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20).describe("Max tracks to return"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit, offset }) => {
      try {
        const data = await client.request<{
          items: { track: SpotifyTrack; added_at: string }[];
          total: number;
        }>("me/tracks", "GET", undefined, { limit, offset });

        if (!data.items.length) {
          return { content: [{ type: "text", text: "No saved tracks found." }] };
        }

        const lines = data.items.map(
          (item, i) => {
            const artists = item.track.artists.map((a) => a.name).join(", ");
            return `${offset + i + 1}. **${item.track.name}** by ${artists} | URI: ${item.track.uri}`;
          }
        );

        return {
          content: [{
            type: "text",
            text: `**Saved Tracks (${data.total} total):**\n${lines.join("\n")}${data.total > offset + data.items.length ? `\n\n_More tracks available. Use offset=${offset + limit} to see more._` : ""}`,
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_save_tracks",
    {
      title: "Save Tracks to Library",
      description: `Save (like) one or more tracks to the user's library.

Args:
  - ids (string[]): Array of Spotify track IDs to save`,
      inputSchema: {
        ids: z.array(z.string()).min(1).max(50).describe("Track IDs to save"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ ids }) => {
      try {
        await client.requestNoContent("me/tracks", "PUT", { ids });
        return { content: [{ type: "text", text: `Saved ${ids.length} track(s) to your library.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_remove_saved_tracks",
    {
      title: "Remove Saved Tracks",
      description: `Remove (unlike) one or more tracks from the user's library.

Args:
  - ids (string[]): Array of Spotify track IDs to remove`,
      inputSchema: {
        ids: z.array(z.string()).min(1).max(50).describe("Track IDs to remove"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ ids }) => {
      try {
        await client.requestNoContent("me/tracks", "DELETE", { ids });
        return { content: [{ type: "text", text: `Removed ${ids.length} track(s) from your library.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );
}
