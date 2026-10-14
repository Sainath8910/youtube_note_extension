import { normalizeNote, type DashboardNote } from "./dashboardApi";

export type VideoAvailability =
  | "available"
  | "missing"
  | "processing"
  | "failed";
export type VideoStatusFilter = "all" | VideoAvailability;
export type VideoSortOrder = "added" | "updated" | "title" | "notes";

export interface VideoLibraryPage {
  count: number;
  next: string | null;
  previous: string | null;
  results: LibraryVideo[];
}

export interface VideoLibraryQuery {
  page?: number;
  pageSize?: number;
  query?: string;
  transcriptFilter?: VideoStatusFilter;
  analysisFilter?: VideoStatusFilter;
  sort?: VideoSortOrder;
}

export interface LibraryVideo {
  id: number;
  youtube_id: string;
  title: string;
  channel_name: string;
  thumbnail_url: string;
  youtube_url: string;
  notes_count: number;
  transcript_availability: VideoAvailability;
  analysis_availability: VideoAvailability;
  created_at: string;
  updated_at: string;
}

export interface VideoDetail {
  video: LibraryVideo;
  notes: DashboardNote[];
}

export interface VideoTranscript {
  status: string;
  language: string;
  segments: Array<{ text: string; start: number; duration: number }>;
}

export interface VideoAnalysis {
  status: string;
  analysis: Record<string, unknown> | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAvailability(value: unknown): value is VideoAvailability {
  return (
    value === "available" ||
    value === "missing" ||
    value === "processing" ||
    value === "failed"
  );
}

const pendingVideoListRequests = new Map<
  string,
  Promise<VideoLibraryPage>
>();

function isVideo(value: unknown): value is LibraryVideo {
  return (
    isObject(value) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    typeof value.youtube_id === "string" &&
    /^[A-Za-z0-9_-]{11}$/.test(value.youtube_id) &&
    typeof value.title === "string" &&
    typeof value.channel_name === "string" &&
    typeof value.thumbnail_url === "string" &&
    typeof value.youtube_url === "string" &&
    typeof value.notes_count === "number" &&
    Number.isSafeInteger(value.notes_count) &&
    value.notes_count >= 0 &&
    isAvailability(value.transcript_availability) &&
    isAvailability(value.analysis_availability) &&
    typeof value.created_at === "string" &&
    Number.isFinite(Date.parse(value.created_at)) &&
    typeof value.updated_at === "string" &&
    Number.isFinite(Date.parse(value.updated_at))
  );
}

function apiMessage(value: unknown): string | null {
  if (!isObject(value)) return null;
  if (typeof value.detail === "string") return value.detail;
  if (typeof value.error === "string") return value.error;
  return null;
}

class VideoApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status: number | undefined) {
    super(message);
    this.name = "VideoApiError";
    this.status = status;
  }
}

export function isVideoApiNotFound(error: unknown): boolean {
  return error instanceof VideoApiError && error.status === 404;
}

const ignoredAnalysisFields = new Set([
  "id",
  "video",
  "model",
  "analysis_version",
  "created_at",
  "updated_at",
]);

function hasAnalysisContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasAnalysisContent);
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      !ignoredAnalysisFields.has(key) && hasAnalysisContent(entry),
  );
}

export function hasUsableVideoAnalysis(
  analysis: Record<string, unknown> | null,
): boolean {
  return analysis !== null && hasAnalysisContent(analysis);
}

function sendVideoCommand(message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) {
      reject(
        new Error(
          "Open this workspace from the YouTube Knowledge browser extension to browse videos.",
        ),
      );
      return;
    }

    chrome.runtime.sendMessage(message, (response: unknown) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || "Extension request failed."));
        return;
      }
      if (!isObject(response) || typeof response.success !== "boolean") {
        reject(new Error("The videos service returned an invalid response."));
        return;
      }
      if (!response.success) {
        reject(
          new VideoApiError(
            apiMessage(response.data) ??
              (typeof response.error === "string"
                ? response.error
                : "Could not complete the video request."),
            typeof response.status === "number" ? response.status : undefined,
          ),
        );
        return;
      }
      resolve(response.data);
    });
  });
}

export function listDashboardVideos(
  query: VideoLibraryQuery = {},
): Promise<VideoLibraryPage> {
  const requestKey = JSON.stringify({
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 10,
    query: query.query ?? "",
    transcriptFilter: query.transcriptFilter ?? "all",
    analysisFilter: query.analysisFilter ?? "all",
    sort: query.sort ?? "updated",
  });
  const pendingRequest = pendingVideoListRequests.get(requestKey);
  if (pendingRequest) return pendingRequest;

  const request = requestDashboardVideos(query);
  pendingVideoListRequests.set(requestKey, request);
  void request.then(
    () => {
      if (pendingVideoListRequests.get(requestKey) === request) {
        pendingVideoListRequests.delete(requestKey);
      }
    },
    () => {
      if (pendingVideoListRequests.get(requestKey) === request) {
        pendingVideoListRequests.delete(requestKey);
      }
    },
  );
  return request;
}

async function requestDashboardVideos(
  query: VideoLibraryQuery,
): Promise<VideoLibraryPage> {
  const data = await sendVideoCommand({
    type: "LIST_VIDEOS",
    ...query,
  });
  if (
    !isObject(data) ||
    !Array.isArray(data.results) ||
    !data.results.every(isVideo) ||
    typeof data.count !== "number" ||
    !Number.isSafeInteger(data.count) ||
    data.count < data.results.length ||
    !(data.next === null || typeof data.next === "string") ||
    !(data.previous === null || typeof data.previous === "string")
  ) {
    throw new Error("The videos API returned an invalid video list.");
  }
  return {
    count: data.count,
    next: data.next,
    previous: data.previous,
    results: data.results,
  };
}

export async function getDashboardVideoDetails(
  youtubeId: string,
): Promise<VideoDetail> {
  const data = await sendVideoCommand({
    type: "GET_VIDEO_DETAILS",
    videoId: youtubeId,
  });
  if (!isObject(data) || !isVideo(data.video) || !Array.isArray(data.notes)) {
    throw new Error("The videos API returned invalid video details.");
  }
  return {
    video: data.video,
    notes: data.notes.map((note, index) => normalizeNote(note, index)),
  };
}

function isTranscriptSegment(
  value: unknown,
): value is VideoTranscript["segments"][number] {
  return (
    isObject(value) &&
    typeof value.text === "string" &&
    typeof value.start === "number" &&
    Number.isFinite(value.start) &&
    typeof value.duration === "number" &&
    Number.isFinite(value.duration)
  );
}

export async function getDashboardVideoTranscript(
  youtubeId: string,
): Promise<VideoTranscript> {
  const data = await sendVideoCommand({
    type: "GET_VIDEO_TRANSCRIPT",
    videoId: youtubeId,
  });
  if (
    !isObject(data) ||
    typeof data.transcript_status !== "string" ||
    (data.transcript !== null &&
      (!isObject(data.transcript) ||
        typeof data.transcript.language !== "string" ||
        !Array.isArray(data.transcript.segments) ||
        !data.transcript.segments.every(isTranscriptSegment)))
  ) {
    throw new Error("The videos API returned an invalid transcript.");
  }
  return {
    status: data.transcript_status,
    language:
      isObject(data.transcript) &&
      typeof data.transcript.language === "string"
        ? data.transcript.language
        : "",
    segments:
      isObject(data.transcript) && Array.isArray(data.transcript.segments)
        ? data.transcript.segments
        : [],
  };
}

export async function getDashboardVideoAnalysis(
  youtubeId: string,
): Promise<VideoAnalysis> {
  const data = await sendVideoCommand({
    type: "GET_VIDEO_ANALYSIS",
    videoId: youtubeId,
  });
  if (
    !isObject(data) ||
    typeof data.status !== "string" ||
    (data.analysis !== null && !isObject(data.analysis))
  ) {
    throw new Error("The videos API returned invalid analysis.");
  }
  return {
    status: data.status,
    analysis: isObject(data.analysis) ? data.analysis : null,
  };
}

function normalizeTranscript(data: unknown): VideoTranscript {
  if (
    !isObject(data) ||
    typeof data.transcript_status !== "string" ||
    (data.transcript !== null &&
      (!isObject(data.transcript) ||
        typeof data.transcript.language !== "string" ||
        !Array.isArray(data.transcript.segments) ||
        !data.transcript.segments.every(isTranscriptSegment)))
  ) {
    throw new Error("The videos API returned an invalid transcript.");
  }
  return {
    status: data.transcript_status,
    language:
      isObject(data.transcript) &&
      typeof data.transcript.language === "string"
        ? data.transcript.language
        : "",
    segments:
      isObject(data.transcript) && Array.isArray(data.transcript.segments)
        ? data.transcript.segments
        : [],
  };
}

export async function generateDashboardVideoTranscript(
  youtubeId: string,
): Promise<VideoTranscript> {
  const data = await sendVideoCommand({
    type: "FETCH_TRANSCRIPT",
    videoId: youtubeId,
  });
  return normalizeTranscript(data);
}

export async function generateDashboardVideoAnalysis(
  youtubeId: string,
): Promise<VideoAnalysis> {
  const data = await sendVideoCommand({
    type: "ANALYZE_VIDEO",
    videoId: youtubeId,
  });
  if (
    !isObject(data) ||
    typeof data.status !== "string" ||
    (data.analysis !== null && !isObject(data.analysis))
  ) {
    throw new Error("The videos API returned invalid analysis.");
  }
  return {
    status: data.status,
    analysis: isObject(data.analysis) ? data.analysis : null,
  };
}

export function matchesVideoSearch(video: LibraryVideo, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return (
    !normalizedQuery ||
    video.title.toLocaleLowerCase().includes(normalizedQuery) ||
    video.channel_name.toLocaleLowerCase().includes(normalizedQuery)
  );
}

function compareDatesDescending(left: string, right: string): number {
  const leftDate = Date.parse(left);
  const rightDate = Date.parse(right);
  const validLeft = Number.isFinite(leftDate);
  const validRight = Number.isFinite(rightDate);
  if (validLeft && validRight) return rightDate - leftDate;
  if (validLeft) return -1;
  if (validRight) return 1;
  return 0;
}

function compareVideoTitle(left: LibraryVideo, right: LibraryVideo): number {
  return (
    left.title.localeCompare(right.title, undefined, {
      sensitivity: "base",
    }) || left.youtube_id.localeCompare(right.youtube_id)
  );
}

export function filterAndSortDashboardVideos(
  videos: LibraryVideo[],
  query: string,
  transcriptFilter: VideoStatusFilter,
  analysisFilter: VideoStatusFilter,
  sort: VideoSortOrder,
): LibraryVideo[] {
  return videos
    .filter((video) => matchesVideoSearch(video, query))
    .filter(
      (video) =>
        transcriptFilter === "all" ||
        video.transcript_availability === transcriptFilter,
    )
    .filter(
      (video) =>
        analysisFilter === "all" ||
        video.analysis_availability === analysisFilter,
    )
    .sort((left, right) => {
      if (sort === "title") return compareVideoTitle(left, right);
      if (sort === "notes") {
        return (
          (right.notes_count ?? 0) - (left.notes_count ?? 0) ||
          compareVideoTitle(left, right)
        );
      }
      const dateOrder =
        sort === "added"
          ? compareDatesDescending(left.created_at, right.created_at)
          : compareDatesDescending(left.updated_at, right.updated_at);
      return dateOrder || compareVideoTitle(left, right);
    });
}

export function toVideoAvailability(
  status: string,
  hasUsableData = false,
): VideoAvailability {
  switch (status) {
    case "READY":
      return hasUsableData ? "available" : "missing";
    case "FETCHING":
    case "ANALYZING":
      return "processing";
    case "FAILED":
      return "failed";
    default:
      return "missing";
  }
}
