# Spotify MCP Server

Part of the [MCP Sidekick](https://github.com/vieiraae/mcp-sidekick) project.

An MCP (Model Context Protocol) server that enables LLMs to interact with the Spotify API — control playback, search music, manage playlists, and explore your library.

## Prerequisites

- Node.js >= 18
- A [Spotify Developer](https://developer.spotify.com/dashboard) application with:
  - **Client ID**
  - **Client Secret**
  - **Redirect URI** set to `http://127.0.0.1:3000/callback` (or your custom value)

## Setup

1. **Create a Spotify App** at https://developer.spotify.com/dashboard
   - Add `http://127.0.0.1:3000/callback` as a Redirect URI
   - Set `Web Playback SDK` and `Web API` as APIs used

2. **Install & Build**
   ```bash
   cd spotify-mcp-server
   npm install
   npm run build
   ```

3. **Configure in your MCP client** — create a `.mcp.json` file in your project:
   ```json
   {
     "inputs": [
       {
         "type": "promptString",
         "id": "spotify-client-id",
         "description": "Spotify Client ID",
         "password": true
       },
       {
         "type": "promptString",
         "id": "spotify-client-secret",
         "description": "Spotify Client Secret",
         "password": true
       }
     ],
     "servers": {
       "spotify": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "@mcp-sidekick/spotify"],
         "env": {
           "SPOTIFY_CLIENT_ID": "${input:spotify-client-id}",
           "SPOTIFY_CLIENT_SECRET": "${input:spotify-client-secret}",
           "SPOTIFY_REDIRECT_URI": "http://127.0.0.1:3000/callback"
         }
       }
     }
   }
   ```

4. **First run** — on the first tool call, the server will open your browser for Spotify authorization. After granting access, tokens are stored locally at `~/.mcp-sidekick-spotify-tokens.json` and auto-refreshed.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | Yes | Your Spotify app Client ID |
| `SPOTIFY_CLIENT_SECRET` | Yes | Your Spotify app Client Secret |
| `SPOTIFY_REDIRECT_URI` | No | OAuth callback URL (default: `http://127.0.0.1:3000/callback`) |
| `SPOTIFY_DEVICE_ID` | No | Default device ID for playback commands (see [Getting Your Device ID](#getting-your-device-id)) |

## Getting Your Device ID

Setting `SPOTIFY_DEVICE_ID` ensures playback commands target a specific device, which avoids errors when no device is currently active.

1. **Start the MCP server** without `SPOTIFY_DEVICE_ID` set
2. **Open Spotify** on the device you want to use and **start playing any track**
3. **Ask the LLM** to get your available devices (this calls the `spotify_get_devices` tool)
4. **Copy the Device ID** from the active device in the response
5. **Add it to your `.mcp.json`** configuration:
   ```json
   "env": {
     "SPOTIFY_CLIENT_ID": "${input:spotify-client-id}",
     "SPOTIFY_CLIENT_SECRET": "${input:spotify-client-secret}",
     "SPOTIFY_REDIRECT_URI": "http://127.0.0.1:3000/callback",
     "SPOTIFY_DEVICE_ID": "your-device-id-here"
   }
   ```
6. **Restart the MCP server** to apply the change

Once configured, all playback commands (play, pause, next, previous, volume, shuffle, repeat, queue, transfer) will default to this device when no explicit `device_id` is provided.

## Available Tools

### Playback
| Tool | Description |
|---|---|
| `spotify_get_playback` | Get current playback state (track, device, progress) |
| `spotify_play` | Start/resume playback, optionally with a specific URI |
| `spotify_pause` | Pause playback |
| `spotify_next` | Skip to next track |
| `spotify_previous` | Skip to previous track |
| `spotify_set_volume` | Set volume (0-100) |
| `spotify_shuffle` | Toggle shuffle on/off |
| `spotify_repeat` | Set repeat mode (track/context/off) |
| `spotify_add_to_queue` | Add a track to the queue |
| `spotify_get_devices` | List available playback devices |
| `spotify_transfer_playback` | Transfer playback to another device |

### Search
| Tool | Description |
|---|---|
| `spotify_search` | Search for tracks, albums, artists, or playlists |

### Info
| Tool | Description |
|---|---|
| `spotify_get_track` | Get track details |
| `spotify_get_album` | Get album details with tracklist |
| `spotify_get_artist` | Get artist details |
| `spotify_get_artist_top_tracks` | Get an artist's top tracks |
| `spotify_get_recently_played` | Get recently played tracks |
| `spotify_get_top_items` | Get user's top tracks or artists |

### Library & Playlists
| Tool | Description |
|---|---|
| `spotify_get_playlists` | Get user's playlists |
| `spotify_get_playlist` | Get playlist details with tracks |
| `spotify_get_playlist_cover` | Get playlist cover image URLs |
| `spotify_create_playlist` | Create a new playlist |
| `spotify_add_tracks_to_playlist` | Add tracks to a playlist |
| `spotify_remove_tracks_from_playlist` | Remove tracks from a playlist |
| `spotify_get_saved_tracks` | Get liked/saved tracks |
| `spotify_save_tracks` | Save (like) tracks |
| `spotify_remove_saved_tracks` | Remove (unlike) tracks |
