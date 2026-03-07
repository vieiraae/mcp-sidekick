export interface SpotifyTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: { id: string; name: string }[];
  album: { id: string; name: string; release_date: string };
  duration_ms: number;
  uri: string;
  external_urls: { spotify: string };
  popularity: number;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  artists: { id: string; name: string }[];
  release_date: string;
  total_tracks: number;
  uri: string;
  external_urls: { spotify: string };
  images: { url: string; width: number; height: number }[];
}

export interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
  popularity: number;
  uri: string;
  external_urls: { spotify: string };
  followers: { total: number };
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string;
  owner: { id: string; display_name: string };
  tracks: { total: number };
  uri: string;
  external_urls: { spotify: string };
  public: boolean;
  images: { url: string; width: number | null; height: number | null }[];
}

export interface SpotifyPlaybackState {
  is_playing: boolean;
  progress_ms: number;
  device: {
    id: string;
    name: string;
    type: string;
    volume_percent: number;
  };
  item: SpotifyTrack | null;
  shuffle_state: boolean;
  repeat_state: string;
}
