import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SpotifyClient, handleSpotifyError, formatDuration } from "../spotify-client.js";
import type { SpotifyTrack, SpotifyAlbum, SpotifyArtist } from "../types.js";

export function registerInfoTools(server: McpServer, client: SpotifyClient): void {

  server.registerTool(
    "spotify_get_track",
    {
      title: "Get Track Details",
      description: `Get detailed information about a specific track.

Args:
  - track_id (string): Spotify track ID (e.g. "4iV5W9uYEdYUVa79Axb7Rh")`,
      inputSchema: {
        track_id: z.string().describe("Spotify track ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ track_id }) => {
      try {
        const track = await client.request<SpotifyTrack>(`tracks/${encodeURIComponent(track_id)}`);
        const artists = track.artists.map((a) => a.name).join(", ");
        const text = [
          `**Track**: ${track.name}`,
          `**Artist(s)**: ${artists}`,
          `**Album**: ${track.album.name} (${track.album.release_date})`,
          `**Duration**: ${formatDuration(track.duration_ms)}`,
          `**Popularity**: ${track.popularity}/100`,
          `**URI**: ${track.uri}`,
          `**Spotify URL**: ${track.external_urls.spotify}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_get_album",
    {
      title: "Get Album Details",
      description: `Get detailed information about an album including its tracks.

Args:
  - album_id (string): Spotify album ID`,
      inputSchema: {
        album_id: z.string().describe("Spotify album ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ album_id }) => {
      try {
        const album = await client.request<
          SpotifyAlbum & { tracks: { items: { name: string; track_number: number; duration_ms: number; uri: string }[] } }
        >(`albums/${encodeURIComponent(album_id)}`);
        const artists = album.artists.map((a) => a.name).join(", ");
        const trackList = album.tracks.items
          .map((t) => `  ${t.track_number}. ${t.name} [${formatDuration(t.duration_ms)}] - ${t.uri}`)
          .join("\n");
        const text = [
          `**Album**: ${album.name}`,
          `**Artist(s)**: ${artists}`,
          `**Release Date**: ${album.release_date}`,
          `**Total Tracks**: ${album.total_tracks}`,
          `**URI**: ${album.uri}`,
          `**Spotify URL**: ${album.external_urls.spotify}`,
          ``,
          `**Tracks:**`,
          trackList,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_get_artist",
    {
      title: "Get Artist Details",
      description: `Get detailed information about an artist.

Args:
  - artist_id (string): Spotify artist ID`,
      inputSchema: {
        artist_id: z.string().describe("Spotify artist ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ artist_id }) => {
      try {
        const artist = await client.request<SpotifyArtist>(`artists/${encodeURIComponent(artist_id)}`);
        const text = [
          `**Artist**: ${artist.name}`,
          `**Genres**: ${artist.genres.join(", ") || "N/A"}`,
          `**Followers**: ${artist.followers.total.toLocaleString()}`,
          `**Popularity**: ${artist.popularity}/100`,
          `**URI**: ${artist.uri}`,
          `**Spotify URL**: ${artist.external_urls.spotify}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_get_artist_top_tracks",
    {
      title: "Get Artist Top Tracks",
      description: `Get the top tracks for an artist.

Args:
  - artist_id (string): Spotify artist ID
  - market (string, optional): ISO 3166-1 alpha-2 country code (default: "US")`,
      inputSchema: {
        artist_id: z.string().describe("Spotify artist ID"),
        market: z.string().default("US").describe("Market/country code"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ artist_id, market }) => {
      try {
        const data = await client.request<{ tracks: SpotifyTrack[] }>(
          `artists/${encodeURIComponent(artist_id)}/top-tracks`,
          "GET",
          undefined,
          { market }
        );
        if (!data.tracks.length) {
          return { content: [{ type: "text", text: "No top tracks found for this artist." }] };
        }
        const lines = data.tracks.map(
          (t, i) => `${i + 1}. **${t.name}** [${formatDuration(t.duration_ms)}] - Popularity: ${t.popularity} | URI: ${t.uri}`
        );
        return {
          content: [{ type: "text", text: `**Top Tracks:**\n${lines.join("\n")}` }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_get_recently_played",
    {
      title: "Get Recently Played",
      description: `Get the user's recently played tracks.

Args:
  - limit (number): Number of tracks to return, 1-50 (default: 20)`,
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20).describe("Number of tracks to return"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ limit }) => {
      try {
        const data = await client.request<{
          items: { track: SpotifyTrack; played_at: string }[];
        }>("me/player/recently-played", "GET", undefined, { limit });

        if (!data.items.length) {
          return { content: [{ type: "text", text: "No recently played tracks." }] };
        }

        const lines = data.items.map((item) => {
          const artists = item.track.artists.map((a) => a.name).join(", ");
          const playedAt = new Date(item.played_at).toLocaleString();
          return `- **${item.track.name}** by ${artists} - played at ${playedAt} | URI: ${item.track.uri}`;
        });
        return {
          content: [{ type: "text", text: `**Recently Played:**\n${lines.join("\n")}` }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );

  server.registerTool(
    "spotify_get_top_items",
    {
      title: "Get User Top Items",
      description: `Get the user's top tracks or artists based on listening history.

Args:
  - type: "tracks" or "artists"
  - time_range: "short_term" (last 4 weeks), "medium_term" (last 6 months), or "long_term" (all time). Default: "medium_term"
  - limit (number): Number of items, 1-50 (default: 20)
  - offset (number): Pagination offset (default: 0)`,
      inputSchema: {
        type: z.enum(["tracks", "artists"]).describe("Type of items to get"),
        time_range: z.enum(["short_term", "medium_term", "long_term"]).default("medium_term").describe("Time range"),
        limit: z.number().int().min(1).max(50).default(20).describe("Number of items"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ type, time_range, limit, offset }) => {
      try {
        if (type === "tracks") {
          const data = await client.request<{ items: SpotifyTrack[]; total: number }>(
            `me/top/tracks`,
            "GET",
            undefined,
            { time_range, limit, offset }
          );
          if (!data.items.length) {
            return { content: [{ type: "text", text: "No top tracks found." }] };
          }
          const lines = data.items.map(
            (t, i) => `${offset + i + 1}. **${t.name}** by ${t.artists.map((a) => a.name).join(", ")} | URI: ${t.uri}`
          );
          return { content: [{ type: "text", text: `**Your Top Tracks (${time_range}):**\n${lines.join("\n")}` }] };
        } else {
          const data = await client.request<{ items: SpotifyArtist[]; total: number }>(
            `me/top/artists`,
            "GET",
            undefined,
            { time_range, limit, offset }
          );
          if (!data.items.length) {
            return { content: [{ type: "text", text: "No top artists found." }] };
          }
          const lines = data.items.map(
            (a, i) => `${offset + i + 1}. **${a.name}** | Genres: ${a.genres.slice(0, 3).join(", ") || "N/A"} | URI: ${a.uri}`
          );
          return { content: [{ type: "text", text: `**Your Top Artists (${time_range}):**\n${lines.join("\n")}` }] };
        }
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );
}
