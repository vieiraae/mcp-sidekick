import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SpotifyClient, handleSpotifyError, formatDuration } from "../spotify-client.js";
import type { SpotifyTrack, SpotifyAlbum, SpotifyArtist, SpotifyPlaylist } from "../types.js";

interface SearchResponse {
  tracks?: { items: SpotifyTrack[]; total: number };
  albums?: { items: SpotifyAlbum[]; total: number };
  artists?: { items: SpotifyArtist[]; total: number };
  playlists?: { items: SpotifyPlaylist[]; total: number };
}

export function registerSearchTools(server: McpServer, client: SpotifyClient): void {

  server.registerTool(
    "spotify_search",
    {
      title: "Search Spotify",
      description: `Search for tracks, albums, artists, or playlists on Spotify.

Args:
  - query (string): Search query (e.g. "Bohemian Rhapsody", "artist:Queen", "genre:rock")
  - type (string): Comma-separated types to search for: "track", "album", "artist", "playlist" (default: "track")
  - limit (number): Max results per type, 1-50 (default: 10)
  - offset (number): Pagination offset (default: 0)

Returns:
  Matching items with name, artist, URI, and other details.

Examples:
  - Search tracks: query="Bohemian Rhapsody" type="track"
  - Search artists: query="Queen" type="artist"
  - Search everything: query="Queen" type="track,album,artist,playlist"`,
      inputSchema: {
        query: z.string().min(1).max(200).describe("Search query"),
        type: z.string().default("track").describe("Comma-separated types: track, album, artist, playlist"),
        limit: z.number().int().min(1).max(50).default(10).describe("Max results per type"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, type, limit, offset }) => {
      try {
        const data = await client.request<SearchResponse>("search", "GET", undefined, {
          q: query,
          type,
          limit,
          offset,
        });

        const sections: string[] = [];

        if (data.tracks?.items.length) {
          const lines = [`## Tracks (${data.tracks.total} total)`, ""];
          for (const track of data.tracks.items) {
            const artists = track.artists.map((a) => a.name).join(", ");
            lines.push(`- **${track.name}** by ${artists} [${formatDuration(track.duration_ms)}]`);
            lines.push(`  Album: ${track.album.name} | URI: ${track.uri}`);
          }
          sections.push(lines.join("\n"));
        }

        if (data.albums?.items.length) {
          const lines = [`## Albums (${data.albums.total} total)`, ""];
          for (const album of data.albums.items) {
            const artists = album.artists.map((a) => a.name).join(", ");
            lines.push(`- **${album.name}** by ${artists} (${album.release_date})`);
            lines.push(`  Tracks: ${album.total_tracks} | URI: ${album.uri}`);
          }
          sections.push(lines.join("\n"));
        }

        if (data.artists?.items.length) {
          const lines = [`## Artists (${data.artists.total} total)`, ""];
          for (const artist of data.artists.items) {
            const genres = artist.genres.length ? artist.genres.slice(0, 3).join(", ") : "N/A";
            lines.push(`- **${artist.name}** | Followers: ${artist.followers.total.toLocaleString()} | Genres: ${genres}`);
            lines.push(`  URI: ${artist.uri}`);
          }
          sections.push(lines.join("\n"));
        }

        if (data.playlists?.items.length) {
          const lines = [`## Playlists (${data.playlists.total} total)`, ""];
          for (const pl of data.playlists.items) {
            lines.push(`- **${pl.name}** by ${pl.owner.display_name} (${pl.tracks.total} tracks)`);
            lines.push(`  URI: ${pl.uri}`);
          }
          sections.push(lines.join("\n"));
        }

        if (!sections.length) {
          return { content: [{ type: "text", text: `No results found for "${query}".` }] };
        }

        return { content: [{ type: "text", text: `# Search Results: "${query}"\n\n${sections.join("\n\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: handleSpotifyError(error) }] };
      }
    }
  );
}
