import { sendDashboardApiMessage } from "./dashboardApi";

export interface DashboardPlaylistVideo {
  youtube_id: string;
  title: string;
  channel_name: string;
  thumbnail_url: string;
  position: number;
  notes_count: number;
}

export interface DashboardPlaylist {
  id: number;
  kind: "YOUTUBE" | "CUSTOM";
  title: string;
  channel_name: string;
  youtube_playlist_id: string | null;
  thumbnail_url: string;
  playlist_url: string;
  videos_count: number;
  videos?: DashboardPlaylistVideo[];
}

export interface PlaylistLibraryPage {
  count: number;
  next: string | null;
  previous: string | null;
  results: DashboardPlaylist[];
}

export interface PlaylistLibraryQuery {
  page?: number;
  pageSize?: number;
  query?: string;
  kind?: "all" | "YOUTUBE" | "CUSTOM";
  sort?: "updated" | "added" | "title" | "videos";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlaylistVideo(value: unknown): value is DashboardPlaylistVideo {
  return (
    isObject(value) &&
    typeof value.youtube_id === "string" &&
    /^[A-Za-z0-9_-]{11}$/.test(value.youtube_id) &&
    typeof value.title === "string" &&
    typeof value.channel_name === "string" &&
    typeof value.thumbnail_url === "string" &&
    typeof value.position === "number" &&
    Number.isSafeInteger(value.position) &&
    typeof value.notes_count === "number" &&
    Number.isSafeInteger(value.notes_count)
  );
}

function isPlaylist(value: unknown): value is DashboardPlaylist {
  return (
    isObject(value) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    (value.kind === "YOUTUBE" || value.kind === "CUSTOM") &&
    typeof value.title === "string" &&
    typeof value.channel_name === "string" &&
    (value.youtube_playlist_id === null ||
      typeof value.youtube_playlist_id === "string") &&
    typeof value.thumbnail_url === "string" &&
    typeof value.playlist_url === "string" &&
    typeof value.videos_count === "number" &&
    Number.isSafeInteger(value.videos_count) &&
    (value.videos === undefined ||
      (Array.isArray(value.videos) && value.videos.every(isPlaylistVideo)))
  );
}

function apiError(value: unknown): string {
  if (isObject(value)) {
    if (typeof value.detail === "string") return value.detail;
    for (const field of Object.values(value)) {
      if (typeof field === "string") return field;
      if (Array.isArray(field) && typeof field[0] === "string") {
        return field[0];
      }
    }
  }
  return "The playlists service returned an error.";
}

async function playlistCommand(
  message: Record<string, unknown>,
): Promise<unknown> {
  const response = await sendDashboardApiMessage(message);
  if (!isObject(response) || typeof response.success !== "boolean") {
    throw new Error("The playlists service returned an invalid response.");
  }
  if (!response.success) throw new Error(apiError(response.data));
  return response.data;
}

export async function listDashboardPlaylists(
  query: PlaylistLibraryQuery = {},
): Promise<PlaylistLibraryPage> {
  const data = await playlistCommand({ type: "LIST_PLAYLISTS", ...query });
  if (
    !isObject(data) ||
    !Array.isArray(data.results) ||
    !data.results.every(isPlaylist) ||
    typeof data.count !== "number" ||
    !Number.isSafeInteger(data.count) ||
    !(data.next === null || typeof data.next === "string") ||
    !(data.previous === null || typeof data.previous === "string")
  ) {
    throw new Error("The playlists service returned an invalid playlist page.");
  }
  return {
    count: data.count,
    next: data.next,
    previous: data.previous,
    results: data.results,
  };
}

export async function getDashboardPlaylist(
  playlistId: number,
): Promise<DashboardPlaylist> {
  const data = await playlistCommand({ type: "GET_PLAYLIST", playlistId });
  if (!isPlaylist(data) || !Array.isArray(data.videos)) {
    throw new Error("The playlists service returned invalid details.");
  }
  return data;
}

export async function createDashboardPlaylist(title: string): Promise<DashboardPlaylist> {
  const data = await playlistCommand({
    type: "CREATE_PLAYLIST",
    data: { kind: "CUSTOM", title: title.trim() },
  });
  if (!isPlaylist(data)) throw new Error("The playlists service returned invalid details.");
  return data;
}

export async function updateDashboardPlaylistTitle(
  playlistId: number,
  title: string,
): Promise<DashboardPlaylist> {
  const data = await playlistCommand({
    type: "UPDATE_PLAYLIST",
    playlistId,
    data: { title: title.trim() },
  });
  if (!isPlaylist(data)) throw new Error("The playlists service returned invalid details.");
  return data;
}

export async function updateDashboardPlaylistCover(
  playlistId: number,
  thumbnailUrl: string,
): Promise<DashboardPlaylist> {
  const data = await playlistCommand({
    type: "UPDATE_PLAYLIST",
    playlistId,
    data: { thumbnail_url: thumbnailUrl.trim() },
  });
  if (!isPlaylist(data)) throw new Error("The playlists service returned invalid details.");
  return data;
}

export async function addDashboardPlaylistVideo(
  playlistId: number,
  video: {
    youtube_id: string;
    title: string;
    channel_name: string;
    thumbnail_url: string;
  },
): Promise<void> {
  await playlistCommand({
    type: "ADD_PLAYLIST_VIDEO",
    playlistId,
    data: video,
  });
}

export async function addDashboardPlaylistVideos(
  playlistId: number,
  videos: Array<{
    youtube_id: string;
    title: string;
    channel_name: string;
    thumbnail_url: string;
  }>,
): Promise<void> {
  await playlistCommand({
    type: "ADD_PLAYLIST_VIDEO",
    playlistId,
    data: { videos },
  });
}

export async function removeDashboardPlaylistVideo(
  playlistId: number,
  youtubeId: string,
): Promise<void> {
  await playlistCommand({
    type: "REMOVE_PLAYLIST_VIDEO",
    playlistId,
    youtubeId,
  });
}

export async function deleteDashboardPlaylist(playlistId: number): Promise<void> {
  await playlistCommand({ type: "DELETE_PLAYLIST", playlistId });
}
