import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ImagePlus,
  ListVideo,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  addDashboardPlaylistVideos,
  createDashboardPlaylist,
  deleteDashboardPlaylist,
  getDashboardPlaylist,
  listDashboardPlaylists,
  removeDashboardPlaylistVideo,
  updateDashboardPlaylistTitle,
  updateDashboardPlaylistCover,
  type DashboardPlaylist,
  type PlaylistLibraryPage,
} from "./playlistApi";
import {
  listDashboardVideos,
  type LibraryVideo,
  type PlaylistVideoFilter,
  type VideoSortOrder,
} from "./videoApi";
import { Video as VideoIcon, FileText } from "lucide-react";
import "./playlists.css";

type PickerMode = "create" | "add" | null;
type LoadState =
  | { status: "loading" }
  | { status: "error"; key: string; message: string }
  | { status: "ready"; key: string; data: PlaylistLibraryPage };

const pageSize = 10;

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function PlaylistsPage({
  playlistId,
  onOpenPlaylist,
  onBackToPlaylists,
  onOpenVideo,
}: {
  playlistId: number | null;
  onOpenPlaylist: (playlistId: number) => void;
  onBackToPlaylists: () => void;
  onOpenVideo: (youtubeId: string, playlistId: number) => void;
}) {
  const [listState, setListState] = useState<LoadState>({ status: "loading" });
  const [selected, setSelected] = useState<DashboardPlaylist | null>(null);
  const [detailLoadError, setDetailLoadError] = useState<{ id: number; message: string } | null>(null);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "YOUTUBE" | "CUSTOM">("all");
  const [sort, setSort] = useState<"updated" | "added" | "title" | "videos">("updated");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [title, setTitle] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [coverDraft, setCoverDraft] = useState("");
  const [editingCover, setEditingCover] = useState(false);
  const [pendingCreatedPlaylist, setPendingCreatedPlaylist] = useState<DashboardPlaylist | null>(null);
  const [videoPage, setVideoPage] = useState(1);
  const [videoQuery, setVideoQuery] = useState("");
  const [playlistVideoFilter, setPlaylistVideoFilter] =
    useState<PlaylistVideoFilter>("all");
  const [videoSort, setVideoSort] = useState<VideoSortOrder>("updated");
  const [videoPageData, setVideoPageData] = useState<LibraryVideo[]>([]);
  const [videoCount, setVideoCount] = useState(0);
  const [videoLoading, setVideoLoading] = useState(false);
  const [selectedVideos, setSelectedVideos] = useState<Record<string, LibraryVideo>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const listRequestKey = JSON.stringify([page, query, kind, sort]);
  const pickerPlaylistId =
    pickerMode === "add" ? selected?.id : undefined;

  useEffect(() => {
    let active = true;
    const requestKey = JSON.stringify([page, query, kind, sort]);
    listDashboardPlaylists({
      page,
      pageSize,
      query: query.trim(),
      kind,
      sort,
    })
      .then((data) => {
        if (active) setListState({ status: "ready", key: requestKey, data });
      })
      .catch((requestError: unknown) => {
        if (active) {
          setListState({
            status: "error",
            key: requestKey,
            message: requestError instanceof Error ? requestError.message : "Could not load playlists.",
          });
        }
      });
    return () => { active = false; };
  }, [page, query, kind, sort, refreshVersion]);

  useEffect(() => {
    if (playlistId === null) return;
    let active = true;
    getDashboardPlaylist(playlistId)
      .then((playlist) => {
        if (active) {
          setSelected(playlist);
          setDetailLoadError(null);
        }
      })
      .catch((requestError: unknown) => {
        if (active) {
          setDetailLoadError({
            id: playlistId,
            message: requestError instanceof Error ? requestError.message : "Could not load this playlist.",
          });
        }
      });
    return () => { active = false; };
  }, [playlistId, detailRefresh]);

  useEffect(() => {
    if (pickerMode === null) return;
    let active = true;
    listDashboardVideos({
      page: videoPage,
      pageSize: 8,
      query: videoQuery.trim(),
      playlistFilter: pickerMode === "add" ? playlistVideoFilter : "all",
      ...(pickerPlaylistId ? { playlistId: pickerPlaylistId } : {}),
      sort: videoSort,
    })
      .then((data) => {
        if (active) {
          setVideoPageData(data.results);
          setVideoCount(data.count);
        }
      })
      .catch((requestError: unknown) => {
        if (active) {
          setError(requestError instanceof Error ? requestError.message : "Could not load videos.");
        }
      })
      .finally(() => {
        if (active) setVideoLoading(false);
      });
    return () => { active = false; };
  }, [pickerMode, videoPage, videoQuery, playlistVideoFilter, pickerPlaylistId, videoSort]);

  const openPicker = (mode: Exclude<PickerMode, null>) => {
    setError("");
    setTitle("");
    setPendingCreatedPlaylist(null);
    setVideoQuery("");
    setVideoPage(1);
    setPlaylistVideoFilter("all");
    setVideoSort("updated");
    setSelectedVideos({});
    setVideoLoading(true);
    setPickerMode(mode);
  };

  const savePlaylistSelection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      let target = selected;
      if (pickerMode === "create") {
        if (!title.trim()) return;
        target = pendingCreatedPlaylist ?? await createDashboardPlaylist(title);
        setPendingCreatedPlaylist(target);
      }
      if (!target) return;
      const videos = Object.values(selectedVideos).map((video) => ({
        youtube_id: video.youtube_id,
        title: video.title,
        channel_name: video.channel_name,
        thumbnail_url: video.thumbnail_url,
      }));
      if (videos.length) await addDashboardPlaylistVideos(target.id, videos);
      setPickerMode(null);
      setPendingCreatedPlaylist(null);
      setRefreshVersion((version) => version + 1);
      if (pickerMode === "create") onOpenPlaylist(target.id);
      else setDetailRefresh((version) => version + 1);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not save this playlist.");
    } finally {
      setBusy(false);
    }
  };

  const removeVideo = async (youtubeId: string) => {
    if (!selected || busy) return;
    setError("");
    setBusy(true);
    try {
      await removeDashboardPlaylistVideo(selected.id, youtubeId);
      setDetailRefresh((version) => version + 1);
      setRefreshVersion((version) => version + 1);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not remove video.");
    } finally {
      setBusy(false);
    }
  };

  const savePlaylistTitle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || busy || !titleDraft.trim()) return;
    setError("");
    setBusy(true);
    try {
      const updated = await updateDashboardPlaylistTitle(selected.id, titleDraft);
      setSelected((current) =>
        current ? { ...current, ...updated, videos: current.videos } : updated,
      );
      setTitleDraft(updated.title);
      setEditingTitle(false);
      setRefreshVersion((version) => version + 1);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not rename playlist.");
    } finally {
      setBusy(false);
    }
  };

  const savePlaylistCover = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || busy) return;
    setError("");
    setBusy(true);
    try {
      const updated = await updateDashboardPlaylistCover(selected.id, coverDraft);
      setSelected((current) =>
        current ? { ...current, ...updated, videos: current.videos } : updated,
      );
      setEditingCover(false);
      setRefreshVersion((version) => version + 1);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not update playlist cover.");
    } finally {
      setBusy(false);
    }
  };

  const deletePlaylist = async () => {
    if (!selected || busy || !window.confirm(`Move "${selected.title}" to Trash? Its videos and notes will stay in your library.`)) return;
    setError("");
    setBusy(true);
    try {
      await deleteDashboardPlaylist(selected.id);
      setRefreshVersion((version) => version + 1);
      onBackToPlaylists();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not delete playlist.");
    } finally {
      setBusy(false);
    }
  };

  const toggleVideo = (video: LibraryVideo, checked: boolean) => {
    setSelectedVideos((current) => {
      const next = { ...current };
      if (checked) next[video.youtube_id] = video;
      else delete next[video.youtube_id];
      return next;
    });
  };

  const totalPages = listState.status === "ready"
    ? Math.max(1, Math.ceil(listState.data.count / pageSize))
    : 1;
  const videoTotalPages = Math.max(1, Math.ceil(videoCount / 8));

  return (
    <section className="content-card playlists-page" aria-labelledby="playlists-heading">
      {playlistId !== null ? (
        selected?.id === playlistId ? (
          <>
            <header className="playlist-detail-header">
              <div className="playlist-detail-heading">
                <button className="workspace-secondary-button" type="button" onClick={onBackToPlaylists}>
                  <ArrowLeft size={14} aria-hidden="true" /> Playlists
                </button>
                {editingTitle ? (
                  <form className="playlist-title-edit" onSubmit={(event) => void savePlaylistTitle(event)}>
                    <input
                      aria-label="Playlist title"
                      autoFocus
                      maxLength={255}
                      required
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                    />
                    <button className="workspace-secondary-button" type="submit" disabled={busy || !titleDraft.trim()}>
                      <Check size={14} aria-hidden="true" /> Save
                    </button>
                    <button
                      className="workspace-secondary-button"
                      type="button"
                      disabled={busy}
                      onClick={() => setEditingTitle(false)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div className="playlist-title-display">
                    <h2 id="playlists-heading">{selected.title}</h2>
                    <button
                      className="workspace-secondary-button playlist-rename-button"
                      type="button"
                      onClick={() => {
                        setTitleDraft(selected.title);
                        setEditingTitle(true);
                      }}
                    >
                      <Pencil size={13} aria-hidden="true" /> Rename
                    </button>
                  </div>
                )}
                <p>{selected.channel_name || (selected.kind === "YOUTUBE" ? "YouTube playlist" : "Custom playlist")} · {selected.videos_count} videos</p>
              </div>
              <div className="playlist-actions">
                <button
                  className="workspace-secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setCoverDraft(selected.thumbnail_url);
                    setEditingCover((current) => !current);
                  }}
                >
                  <ImagePlus size={14} aria-hidden="true" /> Edit cover
                </button>
                {selected.playlist_url && (
                  <a className="workspace-secondary-button" href={selected.playlist_url} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} aria-hidden="true" /> YouTube
                  </a>
                )}
                <button className="workspace-secondary-button" type="button" disabled={busy} onClick={() => openPicker("add")}>
                  <Plus size={14} aria-hidden="true" /> Add videos
                </button>
                <button className="folder-delete-button" type="button" disabled={busy} onClick={() => void deletePlaylist()}>
                  <Trash2 size={14} aria-hidden="true" /> Move to Trash
                </button>
              </div>
            </header>
            {editingCover && (
              <form className="playlist-cover-edit" onSubmit={(event) => void savePlaylistCover(event)}>
                {coverDraft.trim() ? (
                  <img src={coverDraft} alt="Playlist cover preview" />
                ) : (
                  <span className="playlist-cover-preview-placeholder">
                    <ListVideo size={22} aria-hidden="true" />
                  </span>
                )}
                <label>
                  <span>Cover image URL</span>
                  <input
                    type="url"
                    maxLength={500}
                    value={coverDraft}
                    onChange={(event) => setCoverDraft(event.target.value)}
                    placeholder="https://example.com/playlist-cover.jpg"
                  />
                </label>
                <button className="primary-link" type="submit" disabled={busy || (coverDraft.trim() !== "" && !isValidHttpUrl(coverDraft))}>
                  <Check size={14} aria-hidden="true" /> Save cover
                </button>
                <button
                  className="workspace-secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => setEditingCover(false)}
                >
                  Cancel
                </button>
              </form>
            )}
            {selected.videos?.length ? (
              <div className="video-library-list playlist-video-list">
                {selected.videos.map((video, index) => (
                  <article className="video-library-card playlist-video-library-card" key={video.youtube_id}>
                    <button
                      type="button"
                      className="video-thumbnail-button"
                      onClick={() => onOpenVideo(video.youtube_id, selected.id)}
                      aria-label={`Open ${video.title || "video details"}`}
                    >
                      {video.thumbnail_url ? (
                        <img src={video.thumbnail_url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="video-thumbnail-placeholder"><VideoIcon size={26} aria-hidden="true" /></span>
                      )}
                      <span className="video-thumbnail-play">
                        <Play size={15} fill="currentColor" aria-hidden="true" />
                      </span>
                    </button>
                    <div className="video-library-card-copy">
                      <button
                        className="video-library-title"
                        type="button"
                        onClick={() => onOpenVideo(video.youtube_id, selected.id)}
                      >
                        {video.title || "Untitled video"}
                      </button>
                      <p className="video-library-channel">
                        {video.channel_name || "YouTube video"} · Video {index + 1}
                      </p>
                      <div className="video-library-card-meta">
                        <span>
                          <FileText size={13} aria-hidden="true" />
                          {video.notes_count} {video.notes_count === 1 ? "note" : "notes"}
                        </span>
                        <span className={`playlist-visit-status ${video.notes_count ? "is-visited" : "is-unvisited"}`}>
                          {video.notes_count ? <Check size={13} aria-hidden="true" /> : null}
                          {video.notes_count ? "Visited" : "Not visited"}
                        </span>
                      </div>
                    </div>
                    <button
                      className="video-open-button"
                      type="button"
                      onClick={() => onOpenVideo(video.youtube_id, selected.id)}
                    >
                      View details <ArrowUpRight size={14} aria-hidden="true" />
                    </button>
                    <button
                      className="workspace-secondary-button playlist-video-remove"
                      type="button"
                      disabled={busy}
                      onClick={() => void removeVideo(video.youtube_id)}
                    >
                      Remove
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <p className="folder-empty-state">No videos in this playlist yet.</p>
            )}
          </>
        ) : (
          <p role="status">
            {detailLoadError?.id === playlistId
              ? detailLoadError.message
              : "Loading playlist…"}
          </p>
        )
      ) : (
        <>
          <header className="playlist-list-header">
            <div>
              <h2 id="playlists-heading">Playlists</h2>
              <p>Organize and revisit videos from YouTube or your own playlists.</p>
            </div>
            <button className="primary-link" type="button" onClick={() => openPicker("create")}>
              <Plus size={16} aria-hidden="true" /> New playlist
            </button>
          </header>
          <div className="playlist-library-controls">
            <label className="video-search-field">
              <Search size={15} aria-hidden="true" />
              <input aria-label="Search playlists" placeholder="Search playlists or channels" value={query} onChange={(event) => { setPage(1); setQuery(event.target.value); }} />
            </label>
            <select aria-label="Filter playlists" value={kind} onChange={(event) => { setPage(1); setKind(event.target.value as typeof kind); }}>
              <option value="all">All playlists</option>
              <option value="YOUTUBE">YouTube playlists</option>
              <option value="CUSTOM">Custom playlists</option>
            </select>
            <select aria-label="Sort playlists" value={sort} onChange={(event) => { setPage(1); setSort(event.target.value as typeof sort); }}>
              <option value="updated">Recently updated</option>
              <option value="added">Recently added</option>
              <option value="title">Title</option>
              <option value="videos">Video count</option>
            </select>
          </div>
          {listState.status === "loading" || listState.key !== listRequestKey ? (
            <p role="status">Loading playlists…</p>
          ) : listState.status === "error" ? (
            <div role="alert" className="folder-empty-state">
              <p>{listState.message}</p>
              <button className="workspace-secondary-button" type="button" onClick={() => setRefreshVersion((version) => version + 1)}>Try again</button>
            </div>
          ) : listState.data.results.length ? (
            <>
              <ul className="playlist-library-list">
                {listState.data.results.map((playlist) => (
                  <li key={playlist.id}>
                    <button className="playlist-library-card" type="button" onClick={() => onOpenPlaylist(playlist.id)}>
                      {playlist.thumbnail_url ? (
                        <img className="playlist-library-thumbnail" src={playlist.thumbnail_url} alt="" />
                      ) : (
                        <span className="playlist-library-thumbnail playlist-thumbnail-placeholder"><ListVideo size={23} aria-hidden="true" /></span>
                      )}
                      <span className="playlist-library-copy">
                        <strong>{playlist.title}</strong>
                        <span>{playlist.channel_name || (playlist.kind === "YOUTUBE" ? "YouTube playlist" : "Custom playlist")}</span>
                      </span>
                      <span className="playlist-library-count">{playlist.videos_count} videos</span>
                      <span className={`playlist-kind-badge ${playlist.kind === "YOUTUBE" ? "is-youtube" : "is-custom"}`}>
                        {playlist.kind === "YOUTUBE" ? "YouTube" : "Custom"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="playlist-pagination">
                <span>{listState.data.count} playlists · Page {page} of {totalPages}</span>
                <div>
                  <button className="workspace-secondary-button" type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
                    <ChevronLeft size={14} aria-hidden="true" /> Previous
                  </button>
                  <button className="workspace-secondary-button" type="button" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>
                    Next <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="folder-empty-state">No playlists found. Save a note from a YouTube playlist video or create a custom playlist.</p>
          )}
        </>
      )}
      {error && playlistId !== null && <p className="trash-page-error" role="alert">{error}</p>}

      {pickerMode && (
        <div className="playlist-picker-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) setPickerMode(null);
        }}>
          <form className={`playlist-picker-dialog ${pickerMode === "create" ? "is-create" : ""}`} role="dialog" aria-modal="true" aria-labelledby="playlist-picker-title" onSubmit={(event) => void savePlaylistSelection(event)}>
            <header>
              <div>
                <p className="eyebrow">{pickerMode === "create" ? "NEW PLAYLIST" : "EDIT PLAYLIST"}</p>
                <h2 id="playlist-picker-title">{pickerMode === "create" ? "Create a playlist" : "Add videos"}</h2>
              </div>
              <button className="playlist-picker-close" type="button" aria-label="Close dialog" disabled={busy} onClick={() => setPickerMode(null)}>
                <X size={18} aria-hidden="true" />
              </button>
            </header>
            {pickerMode === "create" && (
              <label className="playlist-title-field">
                <span>Playlist title</span>
                <input autoFocus maxLength={255} required disabled={Boolean(pendingCreatedPlaylist)} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. React fundamentals" />
              </label>
            )}
            <div className="playlist-picker-controls">
              <label className="video-search-field">
                <Search size={15} aria-hidden="true" />
                <input aria-label="Search videos" placeholder="Search your videos" value={videoQuery} onChange={(event) => { setVideoLoading(true); setVideoPage(1); setVideoQuery(event.target.value); }} />
              </label>
              {pickerMode === "add" && (
                <select
                  aria-label="Filter videos by playlist membership"
                  value={playlistVideoFilter}
                  onChange={(event) => {
                    setVideoLoading(true);
                    setVideoPage(1);
                    setPlaylistVideoFilter(event.target.value as PlaylistVideoFilter);
                  }}
                >
                  <option value="all">All videos</option>
                  <option value="in_playlist">Videos in playlist</option>
                  <option value="not_in_playlist">Videos not in playlist</option>
                </select>
              )}
              <select aria-label="Sort videos" value={videoSort} onChange={(event) => { setVideoLoading(true); setVideoPage(1); setVideoSort(event.target.value as VideoSortOrder); }}>
                <option value="updated">Recently updated</option>
                <option value="added">Recently added</option>
                <option value="title">Title</option>
                <option value="notes">Most notes</option>
              </select>
            </div>
            <div className="playlist-picker-results">
              {videoLoading ? (
                <p role="status">Loading videos…</p>
              ) : videoPageData.length ? (
                videoPageData.map((video) => (
                  <label
                    className={`playlist-picker-video${pickerMode === "add" && selected?.videos?.some((item) => item.youtube_id === video.youtube_id) ? " is-already-in-playlist" : ""}`}
                    key={video.youtube_id}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(selectedVideos[video.youtube_id])}
                      disabled={pickerMode === "add" && Boolean(selected?.videos?.some((item) => item.youtube_id === video.youtube_id))}
                      onChange={(event) => toggleVideo(video, event.target.checked)}
                    />
                    {video.thumbnail_url ? <img src={video.thumbnail_url} alt="" /> : <span className="playlist-picker-no-thumbnail"><ListVideo size={18} aria-hidden="true" /></span>}
                    <span>
                      <strong>{video.title || "Untitled video"}</strong>
                      <small className="playlist-picker-video-meta">
                        {video.channel_name || "YouTube video"} · {video.notes_count} notes
                        {pickerMode === "add" && selected?.videos?.some((item) => item.youtube_id === video.youtube_id) && (
                          <span className="playlist-picker-existing">
                            <CheckCircle2 size={12} aria-hidden="true" /> Already in playlist
                          </span>
                        )}
                      </small>
                    </span>
                  </label>
                ))
              ) : (
                <p className="folder-empty-state">No videos match your search and filters.</p>
              )}
            </div>
            <footer>
              <span>{Object.keys(selectedVideos).length} selected · {videoCount} videos</span>
              <div className="playlist-picker-pagination">
                <button className="workspace-secondary-button" type="button" disabled={videoPage <= 1 || videoLoading} onClick={() => { setVideoLoading(true); setVideoPage((current) => current - 1); }}>
                  <ChevronLeft size={14} aria-hidden="true" /> Previous
                </button>
                <span>{videoPage} / {videoTotalPages}</span>
                <button className="workspace-secondary-button" type="button" disabled={videoPage >= videoTotalPages || videoLoading} onClick={() => { setVideoLoading(true); setVideoPage((current) => current + 1); }}>
                  Next <ChevronRight size={14} aria-hidden="true" />
                </button>
              </div>
              <button className="primary-link" type="submit" disabled={busy || videoLoading || (pickerMode === "create" && !title.trim())}>
                <Plus size={15} aria-hidden="true" /> {busy ? "Saving…" : pickerMode === "create" ? "Create playlist" : "Add selected"}
              </button>
            </footer>
          </form>
        </div>
      )}
    </section>
  );
}
