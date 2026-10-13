import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  Clapperboard,
  Clock3,
  Copy,
  ExternalLink,
  FileText,
  Play,
  RefreshCw,
  Search,
  Video as VideoIcon,
} from "lucide-react";
import type { DashboardNote } from "./dashboardApi";
import {
  getDashboardVideoAnalysis,
  getDashboardVideoDetails,
  getDashboardVideoTranscript,
  generateDashboardVideoAnalysis,
  generateDashboardVideoTranscript,
  hasUsableVideoAnalysis,
  isVideoApiNotFound,
  listDashboardVideos,
  toVideoAvailability,
  type LibraryVideo,
  type VideoLibraryPage,
  type VideoAnalysis,
  type VideoAvailability,
  type VideoSortOrder,
  type VideoStatusFilter,
  type VideoTranscript,
} from "./videoApi";
import "./videos.css";

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; message: string; requestKey?: string }
  | { status: "ready"; data: T; requestKey?: string };

export type VideoTab = "transcript" | "analysis" | "notes";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const EMPTY_VIDEOS: LibraryVideo[] = [];

function isVideoStatusFilter(value: string): value is VideoStatusFilter {
  return (
    value === "all" ||
    value === "available" ||
    value === "missing" ||
    value === "processing" ||
    value === "failed"
  );
}

function isVideoSortOrder(value: string): value is VideoSortOrder {
  return (
    value === "added" ||
    value === "updated" ||
    value === "title" ||
    value === "notes"
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function statusLabel(status: VideoAvailability): string {
  switch (status) {
    case "available":
      return "Available";
    case "processing":
      return "Processing";
    case "failed":
      return "Failed";
    default:
      return "Missing";
  }
}

function StatusBadge({
  status,
  label,
}: {
  status: VideoAvailability;
  label: string;
}) {
  const Icon =
    status === "available"
      ? Check
      : status === "processing"
        ? RefreshCw
        : status === "failed"
          ? AlertCircle
          : Clock3;
  return (
    <span className={`video-status-badge is-${status}`}>
      <Icon size={13} aria-hidden="true" />
      <span>{label}: {statusLabel(status)}</span>
    </span>
  );
}

export function VideosLibraryPage({
  onOpenVideo,
}: {
  onOpenVideo: (youtubeId: string) => void;
}) {
  const [state, setState] = useState<LoadState<VideoLibraryPage>>({
    status: "loading",
  });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  const [query, setQuery] = useState("");
  const [transcriptFilter, setTranscriptFilter] =
    useState<VideoStatusFilter>("all");
  const [analysisFilter, setAnalysisFilter] =
    useState<VideoStatusFilter>("all");
  const [sort, setSort] = useState<VideoSortOrder>("updated");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const requestKey = JSON.stringify([
    page,
    pageSize,
    query,
    transcriptFilter,
    analysisFilter,
    sort,
  ]);

  useEffect(() => {
    let active = true;
    listDashboardVideos({
      page,
      pageSize,
      query,
      transcriptFilter,
      analysisFilter,
      sort,
    })
      .then((result) => {
        if (active) {
          setState({ status: "ready", data: result, requestKey });
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (page > 1 && isVideoApiNotFound(error)) {
          setPage((currentPage) => Math.max(1, currentPage - 1));
          return;
        }
        setState({
          status: "error",
          message: errorMessage(error, "Could not load your videos."),
          requestKey,
        });
      })
      .finally(() => {
        if (active) setIsRefreshing(false);
      });
    return () => {
      active = false;
    };
  }, [
    page,
    pageSize,
    query,
    transcriptFilter,
    analysisFilter,
    sort,
    refreshCount,
    requestKey,
  ]);

  const currentState =
    isRefreshing ||
    (state.status !== "loading" && state.requestKey !== requestKey)
      ? { status: "loading" as const }
      : state;
  const videos =
    currentState.status === "ready"
      ? currentState.data.results
      : EMPTY_VIDEOS;
  const totalCount =
    currentState.status === "ready" ? currentState.data.count : 0;
  const totalPages = Math.ceil(totalCount / pageSize);
  const firstResult = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastResult = Math.min(page * pageSize, totalCount);
  const hasFilters =
    query.trim() !== "" ||
    transcriptFilter !== "all" ||
    analysisFilter !== "all";
  const refreshing = currentState.status === "loading" || isRefreshing;

  const clearFilters = () => {
    setPage(1);
    setQuery("");
    setTranscriptFilter("all");
    setAnalysisFilter("all");
  };

  return (
    <section className="video-library content-card">
      <div className="video-library-toolbar">
        <div className="video-library-total" aria-live="polite">
          <Clapperboard size={17} aria-hidden="true" />
          <span>
            {currentState.status === "ready"
              ? `${currentState.data.count} ${currentState.data.count === 1 ? "video" : "videos"}`
              : "Your video library"}
          </span>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Refresh videos"
          disabled={refreshing}
          onClick={() => {
            setIsRefreshing(true);
            setRefreshCount((count) => count + 1);
          }}
        >
          <RefreshCw
            className={refreshing ? "is-spinning" : undefined}
            size={16}
            aria-hidden="true"
          />
        </button>
      </div>

      <div className="video-library-controls">
        <label className="video-search-field">
          <span className="visually-hidden">Search videos</span>
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setPage(1);
              setQuery(event.target.value);
            }}
            placeholder="Search titles and channels"
            aria-label="Search videos by title or channel"
          />
        </label>
        <label className="video-filter-field">
          <span>Transcript</span>
          <select
            value={transcriptFilter}
            onChange={(event) => {
              const value = event.target.value;
              if (isVideoStatusFilter(value)) {
                setPage(1);
                setTranscriptFilter(value);
              }
            }}
          >
            <option value="all">All statuses</option>
            <option value="available">Available</option>
            <option value="missing">Missing</option>
            <option value="processing">Processing</option>
            <option value="failed">Failed</option>
          </select>
          <ChevronDown size={13} aria-hidden="true" />
        </label>
        <label className="video-filter-field">
          <span>AI analysis</span>
          <select
            value={analysisFilter}
            onChange={(event) => {
              const value = event.target.value;
              if (isVideoStatusFilter(value)) {
                setPage(1);
                setAnalysisFilter(value);
              }
            }}
          >
            <option value="all">All statuses</option>
            <option value="available">Available</option>
            <option value="missing">Missing</option>
            <option value="processing">Processing</option>
            <option value="failed">Failed</option>
          </select>
          <ChevronDown size={13} aria-hidden="true" />
        </label>
        <label className="video-filter-field video-sort-field">
          <span>Sort</span>
          <select
            value={sort}
            onChange={(event) => {
              const value = event.target.value;
              if (isVideoSortOrder(value)) {
                setPage(1);
                setSort(value);
              }
            }}
          >
            <option value="updated">Recently updated</option>
            <option value="added">Recently added</option>
            <option value="title">Title, A–Z</option>
            <option value="notes">Most notes</option>
          </select>
          <ChevronDown size={13} aria-hidden="true" />
        </label>
      </div>

      {currentState.status === "loading" ? (
        <div className="video-page-state" role="status" aria-busy="true">
          <span className="video-page-spinner" aria-hidden="true" />
          <p>Loading your videos…</p>
        </div>
      ) : currentState.status === "error" ? (
        <div className="video-page-state is-error" role="alert">
          <AlertCircle size={21} aria-hidden="true" />
          <div>
            <strong>Videos could not be loaded</strong>
            <p>{currentState.message}</p>
            <button
              className="inline-action"
              type="button"
              onClick={() => {
                setIsRefreshing(true);
                setRefreshCount((count) => count + 1);
              }}
            >
              Try again
            </button>
          </div>
        </div>
      ) : (
        videos.length === 0 ? (
          <div className="video-page-state">
            {totalCount === 0 && !hasFilters ? (
              <>
                <span className="video-empty-icon">
                  <VideoIcon size={21} aria-hidden="true" />
                </span>
                <div>
                  <strong>No videos found in your library yet.</strong>
                  <p>
                    Save a video note from the YouTube sidebar to add that
                    video to your library.
                  </p>
                  <a href="https://www.youtube.com/" target="_blank" rel="noreferrer">
                    Open YouTube <ArrowUpRight size={13} aria-hidden="true" />
                  </a>
                </div>
              </>
            ) : (
              <div>
                <strong>No videos match these filters.</strong>
                <p>Try another search or clear your current filters.</p>
                {hasFilters && (
                  <button
                    className="inline-action"
                    type="button"
                    onClick={clearFilters}
                  >
                    Clear search and filters
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="video-library-list">
              {videos.map((video) => (
                <article className="video-library-card" key={video.youtube_id}>
                  <button
                    type="button"
                    className="video-thumbnail-button"
                    onClick={() => onOpenVideo(video.youtube_id)}
                    aria-label={`Open ${video.title || "video details"}`}
                  >
                    {video.thumbnail_url ? (
                      <img
                        src={video.thumbnail_url}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <span className="video-thumbnail-placeholder">
                        <VideoIcon size={26} aria-hidden="true" />
                      </span>
                    )}
                    <span className="video-thumbnail-play">
                      <Play size={15} fill="currentColor" aria-hidden="true" />
                    </span>
                  </button>
                  <div className="video-library-card-copy">
                    <button
                      className="video-library-title"
                      type="button"
                      onClick={() => onOpenVideo(video.youtube_id)}
                    >
                      {video.title || "Untitled video"}
                    </button>
                    <p className="video-library-channel">
                      {video.channel_name || "YouTube video"}
                    </p>
                    <div className="video-library-card-meta">
                      <span>
                        <FileText size={13} aria-hidden="true" />
                        {video.notes_count}{" "}
                        {video.notes_count === 1 ? "note" : "notes"}
                      </span>
                      <StatusBadge
                        status={video.transcript_availability}
                        label="Transcript"
                      />
                      <StatusBadge
                        status={video.analysis_availability}
                        label="AI analysis"
                      />
                    </div>
                    <p className="video-library-updated">
                      Updated {formatDate(video.updated_at)}
                    </p>
                  </div>
                  <button
                    className="video-open-button"
                    type="button"
                    onClick={() => onOpenVideo(video.youtube_id)}
                  >
                    View details <ArrowUpRight size={14} aria-hidden="true" />
                  </button>
                </article>
              ))}
            </div>
            <nav className="video-pagination" aria-label="Video library pages">
              <p aria-live="polite">
                Showing {firstResult}–{lastResult} of {totalCount}{" "}
                {totalCount === 1 ? "video" : "videos"}
              </p>
              <div className="video-pagination-controls">
                <label className="video-page-size">
                  <span>Per page</span>
                  <select
                    value={pageSize}
                    onChange={(event) => {
                      const nextPageSize = Number(event.target.value);
                      if ([12, 24, 50].includes(nextPageSize)) {
                        setPage(1);
                        setPageSize(nextPageSize);
                      }
                    }}
                  >
                    <option value={12}>12</option>
                    <option value={24}>24</option>
                    <option value={50}>50</option>
                  </select>
                </label>
                <span className="video-pagination-current">
                  Page {page} of {totalPages}
                </span>
                <button
                  className="workspace-secondary-button"
                  type="button"
                  disabled={page <= 1 || refreshing}
                  onClick={() => setPage((currentPage) => currentPage - 1)}
                >
                  Previous
                </button>
                <button
                  className="workspace-secondary-button"
                  type="button"
                  disabled={page >= totalPages || refreshing}
                  onClick={() => setPage((currentPage) => currentPage + 1)}
                >
                  Next
                </button>
              </div>
            </nav>
          </>
        )
      )}
    </section>
  );
}

function formatDate(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatTimestamp(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function transcriptText(segments: VideoTranscript["segments"]): string {
  return segments.map((segment) => segment.text).join("\n");
}

function highlightedText(text: string, query: string) {
  const needle = query.trim();
  if (!needle) return text;
  const lowerText = text.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const parts = [];
  let cursor = 0;
  let index = lowerText.indexOf(lowerNeedle);
  while (index !== -1) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(
      <mark key={`${index}-${cursor}`}>{text.slice(index, index + needle.length)}</mark>,
    );
    cursor = index + needle.length;
    index = lowerText.indexOf(lowerNeedle, cursor);
  }
  if (cursor === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function TranscriptPanel({
  youtubeId,
  state,
  onRetry,
  onGenerate,
  generating,
  generationError,
}: {
  youtubeId: string;
  state: LoadState<VideoTranscript>;
  onRetry: () => void;
  onGenerate: () => void;
  generating: boolean;
  generationError: string | null;
}) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(100);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const filteredSegments =
    state.status === "ready"
      ? state.data.segments.filter((segment) =>
          segment.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
        )
      : [];
  const plainTranscript =
    state.status === "ready" ? transcriptText(state.data.segments) : "";

  const copyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(plainTranscript);
      setCopied(true);
      setCopyError(null);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      setCopyError(
        error instanceof Error
          ? error.message
          : "Could not copy the transcript.",
      );
    }
  };

  if (state.status === "loading") {
    return <DetailLoading label="Loading transcript…" />;
  }
  if (state.status === "error") {
    return (
      <div className="video-detail-state is-error" role="alert">
        <AlertCircle size={19} aria-hidden="true" />
        <div>
          <strong>Transcript could not be loaded</strong>
          <p>{state.message}</p>
          <button className="inline-action" type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  const availability = toVideoAvailability(
    state.data.status,
    state.data.segments.length > 0,
  );
  if (availability !== "available") {
    return (
      <div className="video-detail-state">
        <BookOpen size={21} aria-hidden="true" />
        <div>
          <strong>
            {availability === "failed"
              ? "Transcript retrieval failed."
              : availability === "processing"
                ? "Transcript is processing."
                : "Transcript is not available yet."}
          </strong>
          <p>
            You can generate a transcript from the saved YouTube video when the
            transcript service is available.
          </p>
          {availability !== "processing" && (
            <button
              className="secondary-link"
              type="button"
              disabled={generating}
              onClick={onGenerate}
            >
              <RefreshCw
                className={generating ? "is-spinning" : undefined}
                size={14}
                aria-hidden="true"
              />
              {generating ? "Generating…" : "Generate transcript"}
            </button>
          )}
          {generationError && (
            <p className="video-inline-error" role="alert">{generationError}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="video-transcript-panel">
      <div className="video-transcript-toolbar">
        <p>
          {state.data.language
            ? `Language: ${state.data.language}`
            : `${state.data.segments.length} transcript segments`}
        </p>
        <button
          className="secondary-link"
          type="button"
          onClick={() => void copyTranscript()}
        >
          <Copy size={14} aria-hidden="true" />
          {copied ? "Copied" : "Copy transcript"}
        </button>
      </div>
      {copyError && <p className="video-inline-error" role="alert">{copyError}</p>}
      <label className="video-search-field transcript-search-field">
        <span className="visually-hidden">Search transcript</span>
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setVisibleCount(100);
          }}
          placeholder="Search this transcript"
          aria-label="Search transcript"
        />
        {query && (
          <button type="button" onClick={() => setQuery("")}>
            Clear
          </button>
        )}
      </label>
      {filteredSegments.length === 0 ? (
        <p className="video-detail-empty" role="status">
          {query ? "No transcript lines match your search." : "Transcript is empty."}
        </p>
      ) : (
        <>
          <ol className="video-transcript-list">
            {filteredSegments.slice(0, visibleCount).map((segment, index) => (
              <li key={`${segment.start}-${index}`}>
                <a
                  className="video-transcript-timestamp"
                  href={`https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}&t=${Math.max(0, Math.floor(segment.start))}s`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {formatTimestamp(segment.start)}
                </a>
                <p>{highlightedText(segment.text, query)}</p>
              </li>
            ))}
          </ol>
          {filteredSegments.length > visibleCount && (
            <button
              className="workspace-secondary-button"
              type="button"
              onClick={() => setVisibleCount((count) => count + 100)}
            >
              Load more transcript
            </button>
          )}
        </>
      )}
    </div>
  );
}

const analysisLabels: Record<string, string> = {
  summary: "Overview",
  detailed_notes: "Detailed notes",
  topics: "Topics covered",
  concepts: "Key concepts",
  prerequisites: "Prerequisites",
  upcoming_topics: "Next topics",
  key_points: "Key takeaways",
  claims: "Claims",
  questions: "Questions",
};

const ignoredAnalysisFields = new Set([
  "id",
  "video",
  "model",
  "analysis_version",
  "created_at",
  "updated_at",
]);

function readableLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toLocaleUpperCase());
}

function AnalysisValue({ value }: { value: unknown }) {
  if (typeof value === "string") return <p>{value}</p>;
  if (typeof value === "number" || typeof value === "boolean") {
    return <p>{String(value)}</p>;
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string" || typeof item === "number")) {
      return (
        <ul>
          {value.map((item, index) => <li key={`${index}-${String(item)}`}>{String(item)}</li>)}
        </ul>
      );
    }
    return (
      <div className="video-analysis-nested-list">
        {value.map((item, index) => (
          <div className="video-analysis-nested-item" key={index}>
            <AnalysisValue value={item} />
          </div>
        ))}
      </div>
    );
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(
      ([key, entry]) =>
        !ignoredAnalysisFields.has(key) &&
        entry !== null &&
        entry !== "" &&
        (!Array.isArray(entry) || entry.length > 0),
    );
    return entries.length ? (
      <dl className="video-analysis-fields">
        {entries.map(([key, entry]) => (
          <div key={key}>
            <dt>{readableLabel(key)}</dt>
            <dd><AnalysisValue value={entry} /></dd>
          </div>
        ))}
      </dl>
    ) : null;
  }
  return null;
}

function AnalysisPanel({
  state,
  onRetry,
  onGenerate,
  generating,
  generationError,
}: {
  state: LoadState<VideoAnalysis>;
  onRetry: () => void;
  onGenerate: () => void;
  generating: boolean;
  generationError: string | null;
}) {
  if (state.status === "loading") {
    return <DetailLoading label="Loading analysis…" />;
  }
  if (state.status === "error") {
    return (
      <div className="video-detail-state is-error" role="alert">
        <AlertCircle size={19} aria-hidden="true" />
        <div>
          <strong>Analysis could not be loaded</strong>
          <p>{state.message}</p>
          <button className="inline-action" type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  const availability = toVideoAvailability(
    state.data.status,
    hasUsableVideoAnalysis(state.data.analysis),
  );
  if (availability !== "available" || !state.data.analysis) {
    return (
      <div className="video-detail-state">
        <BookOpen size={21} aria-hidden="true" />
        <div>
          <strong>
            {availability === "failed"
              ? "Analysis generation failed."
              : availability === "processing"
                ? "Analysis is processing."
                : "AI analysis is not available yet."}
          </strong>
          <p>
            Analysis uses the saved transcript and will not run until you
            request it.
          </p>
          {availability !== "processing" && (
            <button
              className="secondary-link"
              type="button"
              disabled={generating}
              onClick={onGenerate}
            >
              <RefreshCw
                className={generating ? "is-spinning" : undefined}
                size={14}
                aria-hidden="true"
              />
              {generating ? "Generating…" : "Generate analysis"}
            </button>
          )}
          {generationError && (
            <p className="video-inline-error" role="alert">{generationError}</p>
          )}
        </div>
      </div>
    );
  }

  const sections = Object.entries(state.data.analysis).filter(
    ([key, value]) =>
      !ignoredAnalysisFields.has(key) &&
      value !== null &&
      value !== "" &&
      (!Array.isArray(value) || value.length > 0) &&
      (typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length > 0),
  );
  if (sections.length === 0) {
    return <p className="video-detail-empty">No analysis sections are available.</p>;
  }
  return (
    <div className="video-analysis-panel">
      {sections.map(([key, value]) => {
        const label = analysisLabels[key] ?? readableLabel(key);
        return (
          <section className="video-analysis-section" key={key}>
            <h3>{label}</h3>
            <AnalysisValue value={value} />
          </section>
        );
      })}
    </div>
  );
}

function VideoNotesPanel({
  notes,
  onOpenNote,
  onCreateNote,
}: {
  notes: DashboardNote[];
  onOpenNote: (noteId: number) => void;
  onCreateNote: () => void;
}) {
  const [query, setQuery] = useState("");
  const filteredNotes = notes.filter((note) =>
    `${note.title}\n${note.content}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <div className="video-notes-panel">
      <div className="video-notes-toolbar">
        <label className="video-search-field">
          <span className="visually-hidden">Search this video's notes</span>
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search notes for this video"
            aria-label="Search this video's notes"
          />
        </label>
        <button
          className="secondary-link"
          type="button"
          onClick={onCreateNote}
        >
          <FileText size={14} aria-hidden="true" />
          Create note
        </button>
      </div>
      {filteredNotes.length === 0 ? (
        <div className="video-detail-state">
          <FileText size={20} aria-hidden="true" />
          <div>
            <strong>
              {query ? "No notes match your search." : "No notes for this video yet."}
            </strong>
            <p>
              {query
                ? "Try another search or clear the search field."
                : "Create a note to save what you learn from this video."}
            </p>
            {!query && (
              <button
                className="secondary-link"
                type="button"
                onClick={onCreateNote}
              >
                <FileText size={14} aria-hidden="true" />
                Create note
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="video-notes-list">
          {filteredNotes.map((note) => (
            <article className="video-note-card" key={note.id}>
              <div className="video-note-icon">
                <FileText size={16} aria-hidden="true" />
              </div>
              <div className="video-note-copy">
                <button
                  type="button"
                  className="video-note-title"
                  onClick={() => onOpenNote(note.id)}
                >
                  {note.title || "Untitled note"}
                </button>
                <p>{note.content || "No text preview available."}</p>
                <div className="video-note-metadata">
                  {note.folder_path?.length ? (
                    <span>{note.folder_path.map((folder) => folder.name).join(" / ")}</span>
                  ) : null}
                  {note.timestamp_seconds !== null &&
                    note.timestamp_seconds !== undefined && (
                      <span>Video at {formatTimestamp(note.timestamp_seconds)}</span>
                    )}
                  <span>Updated {formatDate(note.updated_at)}</span>
                </div>
              </div>
              <button
                className="video-note-open"
                type="button"
                onClick={() => onOpenNote(note.id)}
              >
                Open <ArrowUpRight size={13} aria-hidden="true" />
              </button>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function DetailLoading({ label }: { label: string }) {
  return (
    <div className="video-page-state" role="status" aria-busy="true">
      <span className="video-page-spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function VideoDetailPage({
  youtubeId,
  activeTab,
  onBack,
  onTabChange,
  onOpenNote,
  onCreateNote,
}: {
  youtubeId: string;
  activeTab: VideoTab;
  onBack: () => void;
  onTabChange: (tab: VideoTab) => void;
  onOpenNote: (noteId: number) => void;
  onCreateNote: (youtubeId: string) => void;
}) {
  const [detail, setDetail] = useState<LoadState<VideoDetailData>>({
    status: "loading",
  });
  const [detailRetry, setDetailRetry] = useState(0);
  const [transcriptState, setTranscriptState] =
    useState<LoadState<VideoTranscript> | null>(null);
  const [analysisState, setAnalysisState] =
    useState<LoadState<VideoAnalysis> | null>(null);
  const [transcriptRetry, setTranscriptRetry] = useState(0);
  const [analysisRetry, setAnalysisRetry] = useState(0);
  const [generatingTranscript, setGeneratingTranscript] = useState(false);
  const [generatingAnalysis, setGeneratingAnalysis] = useState(false);
  const [transcriptGenerationError, setTranscriptGenerationError] =
    useState<string | null>(null);
  const [analysisGenerationError, setAnalysisGenerationError] =
    useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [detailRefreshError, setDetailRefreshError] = useState<string | null>(
    null,
  );
  const transcriptCached = useRef(false);
  const analysisCached = useRef(false);

  useEffect(() => {
    let active = true;
    getDashboardVideoDetails(youtubeId)
      .then((data) => {
        if (active) setDetail({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (active) {
          setDetail({
            status: "error",
            message: errorMessage(error, "Could not load this video."),
          });
        }
      });
    return () => {
      active = false;
    };
  }, [youtubeId, detailRetry]);

  useEffect(() => {
    if (activeTab !== "transcript" || transcriptCached.current) return;
    let active = true;
    getDashboardVideoTranscript(youtubeId)
      .then((data) => {
        if (active) {
          transcriptCached.current = true;
          setTranscriptState({ status: "ready", data });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          transcriptCached.current = true;
          setTranscriptState({
            status: "error",
            message: errorMessage(error, "Could not load the transcript."),
          });
        }
      });
    return () => {
      active = false;
    };
  }, [youtubeId, activeTab, transcriptRetry]);

  useEffect(() => {
    if (activeTab !== "analysis" || analysisCached.current) return;
    let active = true;
    getDashboardVideoAnalysis(youtubeId)
      .then((data) => {
        if (active) {
          analysisCached.current = true;
          setAnalysisState({ status: "ready", data });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          analysisCached.current = true;
          setAnalysisState({
            status: "error",
            message: errorMessage(error, "Could not load the analysis."),
          });
        }
      });
    return () => {
      active = false;
    };
  }, [youtubeId, activeTab, analysisRetry]);

  const refreshDetails = async () => {
    setRefreshing(true);
    setDetailRefreshError(null);
    try {
      const data = await getDashboardVideoDetails(youtubeId);
      setDetail({ status: "ready", data });
    } catch (error) {
      setDetailRefreshError(
        errorMessage(error, "Could not refresh this video."),
      );
    } finally {
      setRefreshing(false);
    }
  };

  const generateTranscript = async () => {
    setGeneratingTranscript(true);
    setTranscriptGenerationError(null);
    try {
      const data = await generateDashboardVideoTranscript(youtubeId);
      setTranscriptState({ status: "ready", data });
      await refreshDetails();
    } catch (error) {
      setTranscriptGenerationError(
        errorMessage(error, "Could not generate the transcript."),
      );
    } finally {
      setGeneratingTranscript(false);
    }
  };

  const generateAnalysis = async () => {
    setGeneratingAnalysis(true);
    setAnalysisGenerationError(null);
    try {
      const data = await generateDashboardVideoAnalysis(youtubeId);
      setAnalysisState({ status: "ready", data });
      await refreshDetails();
    } catch (error) {
      setAnalysisGenerationError(
        errorMessage(error, "Could not generate the analysis."),
      );
    } finally {
      setGeneratingAnalysis(false);
    }
  };

  if (!VIDEO_ID_PATTERN.test(youtubeId)) {
    return (
      <section className="content-card video-detail-error" role="alert">
        <AlertCircle size={19} aria-hidden="true" />
        <p>This video ID is invalid.</p>
        <button className="inline-action" type="button" onClick={onBack}>
          Back to videos
        </button>
      </section>
    );
  }

  if (detail.status === "loading") {
    return <DetailLoading label="Loading video details…" />;
  }
  if (detail.status === "error") {
    return (
      <section className="content-card video-detail-error" role="alert">
        <button className="workspace-back-button" type="button" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" /> Videos
        </button>
        <AlertCircle size={19} aria-hidden="true" />
        <div>
          <strong>Video unavailable</strong>
          <p>{detail.message}</p>
          <button
            className="inline-action"
            type="button"
            onClick={() => setDetailRetry((count) => count + 1)}
          >
            Try again
          </button>
        </div>
      </section>
    );
  }

  const video = detail.data.video;
  return (
    <section className="video-detail-page">
      <button className="workspace-back-button" type="button" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" />
        Back to videos
      </button>
      <section className="content-card video-detail-header">
        {video.thumbnail_url ? (
          <img
            className="video-detail-thumbnail"
            src={video.thumbnail_url}
            alt=""
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="video-detail-thumbnail video-thumbnail-placeholder">
            <VideoIcon size={25} aria-hidden="true" />
          </span>
        )}
        <div className="video-detail-heading">
          <p className="eyebrow">VIDEO DETAILS</p>
          <h2>{video.title || "Untitled video"}</h2>
          <p>{video.channel_name || "YouTube video"}</p>
          <div className="video-detail-statuses">
            <StatusBadge
              status={video.transcript_availability}
              label="Transcript"
            />
            <StatusBadge
              status={video.analysis_availability}
              label="AI analysis"
            />
            <span className="video-detail-note-count">
              <FileText size={13} aria-hidden="true" />
              {video.notes_count} {video.notes_count === 1 ? "note" : "notes"}
            </span>
          </div>
        </div>
        <a
          className="secondary-link video-youtube-link"
          href={video.youtube_url}
          target="_blank"
          rel="noreferrer"
        >
          Open on YouTube <ExternalLink size={13} aria-hidden="true" />
        </a>
      </section>
      <section className="content-card video-detail-content">
        {detailRefreshError && (
          <div className="video-refresh-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" />
            <span>{detailRefreshError}</span>
            <button
              className="inline-action"
              type="button"
              onClick={() => void refreshDetails()}
            >
              Retry
            </button>
          </div>
        )}
        <div className="video-detail-toolbar">
          <nav className="video-detail-tabs" aria-label="Video details">
            {(["transcript", "analysis", "notes"] as const).map((tab) => (
              <button
                className={activeTab === tab ? "is-active" : ""}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                key={tab}
                onClick={() => onTabChange(tab)}
              >
                {tab === "transcript"
                  ? "Transcript"
                  : tab === "analysis"
                    ? "AI Analysis"
                    : `Notes (${detail.data.notes.length})`}
              </button>
            ))}
          </nav>
          <button
            className="icon-button"
            type="button"
            aria-label="Refresh video details"
            disabled={refreshing}
            onClick={() => void refreshDetails()}
          >
            <RefreshCw
              className={refreshing ? "is-spinning" : undefined}
              size={15}
              aria-hidden="true"
            />
          </button>
        </div>
        <div role="tabpanel" className="video-detail-tab-panel">
          {activeTab === "transcript" ? (
            <TranscriptPanel
              youtubeId={youtubeId}
              state={transcriptState ?? { status: "loading" }}
              onRetry={() => {
                transcriptCached.current = false;
                setTranscriptState(null);
                setTranscriptRetry((count) => count + 1);
              }}
              onGenerate={() => void generateTranscript()}
              generating={generatingTranscript}
              generationError={transcriptGenerationError}
            />
          ) : activeTab === "analysis" ? (
            <AnalysisPanel
              state={analysisState ?? { status: "loading" }}
              onRetry={() => {
                analysisCached.current = false;
                setAnalysisState(null);
                setAnalysisRetry((count) => count + 1);
              }}
              onGenerate={() => void generateAnalysis()}
              generating={generatingAnalysis}
              generationError={analysisGenerationError}
            />
          ) : (
            <VideoNotesPanel
              notes={detail.data.notes}
              onOpenNote={onOpenNote}
              onCreateNote={() => onCreateNote(youtubeId)}
            />
          )}
        </div>
      </section>
    </section>
  );
}

interface VideoDetailData {
  video: LibraryVideo;
  notes: DashboardNote[];
}
