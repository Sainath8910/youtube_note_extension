import {
  normalizeFolderPath,
  type FolderPathItem,
  type NoteBlock,
  type NoteDocument,
  type VideoNote,
} from "./noteDocument";

const RECENT_NOTES_LIMIT = 4;
const RECENT_CREATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface DashboardVideoMetadata {
  id?: number;
  youtube_id?: string;
  title?: string;
  channel_name?: string;
  channel_handle?: string;
  thumbnail_url?: string;
}

export type DashboardFolderPathItem = FolderPathItem;

export interface DashboardNote extends VideoNote {
  video_detail?: DashboardVideoMetadata | null;
  folder_path: DashboardFolderPathItem[];
}

export interface DashboardData {
  notes: DashboardNote[];
  totalNotes: number;
  recentlyCreatedNotes: number;
  videoAssociatedNotes: number;
  standaloneNotes: number;
  recentNotes: DashboardNote[];
}

export function matchesDashboardNoteSearch(
  note: Pick<DashboardNote, "title">,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;

  return note.title.toLocaleLowerCase().includes(normalizedQuery);
}

export interface DashboardTranscriptSegment {
  text: string;
  start: number;
  duration: number;
}

export interface DashboardVideoContext {
  transcriptStatus: string;
  transcriptLanguage: string;
  transcript: DashboardTranscriptSegment[] | null;
  analysisStatus: string;
  analysis: Record<string, unknown> | null;
}

let inFlightDashboardRequest: Promise<DashboardData> | null = null;

export function invalidateDashboardDataRequest(): void {
  inFlightDashboardRequest = null;
}

export function isDashboardRequestCurrent(
  active: boolean,
  requestVersion: number,
  currentVersion: number,
): boolean {
  return active && requestVersion === currentVersion;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTranscriptSegment(value: unknown): value is DashboardTranscriptSegment {
  return (
    isObject(value) &&
    typeof value.text === "string" &&
    typeof value.start === "number" &&
    Number.isFinite(value.start) &&
    typeof value.duration === "number" &&
    Number.isFinite(value.duration)
  );
}

function isValidDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNoteBlock(value: unknown): value is NoteBlock {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    (value.type === "paragraph" ||
      value.type === "heading" ||
      value.type === "equation" ||
      value.type === "timestamp" ||
      value.type === "image" ||
      value.type === "url" ||
      value.type === "code" ||
      value.type === "command" ||
      value.type === "bullet_list" ||
      value.type === "numbered_list" ||
      value.type === "screenshot") &&
    typeof value.content === "string"
  );
}

function normalizeDocument(value: unknown): VideoNote["document"] | undefined {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.blocks)) {
    return undefined;
  }

  const blocks = value.blocks;
  if (!blocks.every(isNoteBlock)) return undefined;

  return {
    ...value,
    version: 1,
    blocks,
  };
}

function normalizeVideoMetadata(
  value: unknown,
): DashboardVideoMetadata | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;

  const metadata: DashboardVideoMetadata = {};
  if (
    typeof value.id === "number" &&
    Number.isInteger(value.id) &&
    value.id > 0
  ) {
    metadata.id = value.id;
  }
  for (const field of [
    "youtube_id",
    "title",
    "channel_name",
    "channel_handle",
    "thumbnail_url",
  ] as const) {
    if (typeof value[field] === "string") {
      metadata[field] = value[field];
    }
  }
  return metadata;
}

export function normalizeNote(value: unknown, index: number): DashboardNote {
  if (!isObject(value)) {
    throw new Error(`Note ${index + 1} has an invalid format.`);
  }

  const isNullableId = (id: unknown): id is number | null =>
    id === null || (typeof id === "number" && Number.isInteger(id) && id > 0);

  if (
    typeof value.id !== "number" ||
    !Number.isInteger(value.id) ||
    value.id <= 0 ||
    typeof value.title !== "string" ||
    typeof value.content !== "string" ||
    (value.note_type !== "VIDEO" && value.note_type !== "STANDALONE") ||
    !isNullableId(value.video) ||
    !isNullableId(value.folder) ||
    (value.timestamp_seconds !== null &&
      value.timestamp_seconds !== undefined &&
      (typeof value.timestamp_seconds !== "number" ||
        !Number.isInteger(value.timestamp_seconds) ||
        value.timestamp_seconds < 0))
  ) {
    throw new Error(`Note ${index + 1} contains invalid or unsupported data.`);
  }

  return {
    id: value.id,
    title: value.title,
    content: value.content,
    document: normalizeDocument(value.document),
    video_detail: normalizeVideoMetadata(value.video_detail),
    folder_path: normalizeFolderPath(value.folder_path),
    note_type: value.note_type,
    video: value.video,
    folder: value.folder,
    timestamp_seconds:
      typeof value.timestamp_seconds === "number"
        ? value.timestamp_seconds
        : null,
    created_at: isValidDateString(value.created_at)
      ? value.created_at
      : undefined,
    updated_at: isValidDateString(value.updated_at)
      ? value.updated_at
      : undefined,
  };
}

function normalizeSavedNote(value: unknown): DashboardNote {
  return normalizeNote(value, 0);
}

function sendNoteCommand(
  message: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) {
      reject(
        new Error(
          "Open this workspace from the YouTube Knowledge browser extension to save notes.",
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
        reject(new Error("The notes service returned an invalid response."));
        return;
      }
      if (!response.success) {
        reject(
          new Error(
            typeof response.error === "string"
              ? response.error
              : "Could not save the note.",
          ),
        );
        return;
      }
      resolve(response.data);
    });
  });
}

export async function updateDashboardNote(
  noteId: number,
  data: { title: string; content: string; document: NoteDocument },
): Promise<DashboardNote> {
  const savedNote = await sendNoteCommand({
    type: "UPDATE_NOTE",
    noteId,
    data,
  });
  return normalizeSavedNote(savedNote);
}

export async function updateDashboardNoteFolder(
  noteId: number,
  folder: number | null,
): Promise<DashboardNote> {
  const savedNote = await sendNoteCommand({
    type: "UPDATE_NOTE",
    noteId,
    data: { folder },
  });
  return normalizeSavedNote(savedNote);
}

export async function deleteDashboardNote(noteId: number): Promise<void> {
  await sendNoteCommand({ type: "DELETE_NOTE", noteId });
}

export async function getDashboardVideoContext(
  youtubeId: string,
): Promise<DashboardVideoContext> {
  const response = await sendNoteCommand({
    type: "GET_VIDEO_CONTEXT",
    videoId: youtubeId,
  });
  if (!isObject(response) || !isObject(response.video)) {
    throw new Error("The video service returned invalid video details.");
  }

  const video = response.video;
  let transcript: DashboardTranscriptSegment[] | null = null;
  if (video.transcript !== null && video.transcript !== undefined) {
    if (
      !Array.isArray(video.transcript) ||
      !video.transcript.every(isTranscriptSegment)
    ) {
      throw new Error("The video service returned an invalid transcript.");
    }
    transcript = video.transcript;
  }

  if (
    video.analysis !== null &&
    video.analysis !== undefined &&
    !isObject(video.analysis)
  ) {
    throw new Error("The video service returned invalid analysis.");
  }

  return {
    transcriptStatus:
      typeof video.transcript_status === "string"
        ? video.transcript_status
        : "UNKNOWN",
    transcriptLanguage:
      typeof video.transcript_language === "string"
        ? video.transcript_language
        : "",
    transcript,
    analysisStatus:
      typeof video.analysis_status === "string"
        ? video.analysis_status
        : "UNKNOWN",
    analysis: isObject(video.analysis) ? video.analysis : null,
  };
}

export function upsertDashboardNote(
  data: DashboardData,
  note: DashboardNote,
): DashboardData {
  const notes = [
    ...data.notes.filter((existingNote) => existingNote.id !== note.id),
    note,
  ];
  return deriveDashboardData(notes, Date.now());
}

export function removeDashboardNote(
  data: DashboardData,
  noteId: number,
): DashboardData {
  return deriveDashboardData(
    data.notes.filter((note) => note.id !== noteId),
    Date.now(),
  );
}

export async function createStandaloneDashboardNote(data: {
  title: string;
  content: string;
  document: NoteDocument;
  folder: number | null;
}): Promise<DashboardNote> {
  const savedNote = await sendNoteCommand({
    type: "CREATE_STANDALONE_NOTE",
    data: {
      ...data,
      note_type: "STANDALONE",
      video: null,
      timestamp_seconds: null,
    },
  });
  return normalizeSavedNote(savedNote);
}

export async function createVideoDashboardNote(data: {
  youtubeId: string;
  title: string;
  content: string;
  document: NoteDocument;
  folder: number | null;
}): Promise<DashboardNote> {
  const response = await sendNoteCommand({
    type: "CREATE_NOTE",
    data: {
      youtube_id: data.youtubeId,
      title: data.title,
      content: data.content,
      document: data.document,
      note_type: "VIDEO",
      folder: data.folder,
      timestamp_seconds: null,
    },
  });
  if (!isObject(response) || !isObject(response.note)) {
    throw new Error("The notes API returned invalid video note data.");
  }
  return normalizeSavedNote(response.note);
}

function parseNotesResponse(data: unknown): DashboardNote[] {
  if (!Array.isArray(data)) {
    if (isObject(data) && Array.isArray(data.results)) {
      throw new Error(
        "The notes API returned a paginated response. Dashboard totals require the complete note list.",
      );
    }
    throw new Error("The notes API returned an invalid note list.");
  }

  return data.map(normalizeNote);
}

function requestNotes(): Promise<DashboardNote[]> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) {
      reject(
        new Error(
          "Open this workspace from the YouTube Knowledge browser extension to load saved notes.",
        ),
      );
      return;
    }

    chrome.runtime.sendMessage(
      { type: "GET_NOTES" },
      (response: unknown) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || "Extension request failed."));
          return;
        }

        if (!isObject(response) || typeof response.success !== "boolean") {
          reject(new Error("The notes service returned an invalid response."));
          return;
        }

        if (response.success === false) {
          reject(
            new Error(
              typeof response.error === "string"
                ? response.error
                : "Could not load saved notes.",
            ),
          );
          return;
        }

        try {
          resolve(parseNotesResponse(response.data));
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("The notes service returned invalid note data."),
          );
        }
      },
    );
  });
}

function updatedAt(note: VideoNote): number {
  const updatedDate = note.updated_at ? Date.parse(note.updated_at) : NaN;
  if (Number.isFinite(updatedDate)) return updatedDate;
  return note.created_at ? Date.parse(note.created_at) : NaN;
}

function deriveDashboardData(notes: DashboardNote[], now: number): DashboardData {
  const recentlyUpdatedNotes = [...notes].sort((left, right) => {
    const leftUpdated = updatedAt(left);
    const rightUpdated = updatedAt(right);
    if (!Number.isFinite(leftUpdated)) return Number.isFinite(rightUpdated) ? 1 : 0;
    if (!Number.isFinite(rightUpdated)) return -1;
    return rightUpdated - leftUpdated;
  });
  const recentWindowStart = now - RECENT_CREATION_WINDOW_MS;

  return {
    notes: recentlyUpdatedNotes,
    totalNotes: notes.length,
    recentlyCreatedNotes: notes.filter((note) => {
      if (!note.created_at) return false;
      const createdAt = Date.parse(note.created_at);
      return createdAt >= recentWindowStart && createdAt <= now;
    }).length,
    videoAssociatedNotes: notes.filter(
      (note) => note.video !== null && note.video !== undefined,
    ).length,
    standaloneNotes: notes.filter(
      (note) =>
        note.note_type === "STANDALONE" &&
        (note.video === null || note.video === undefined),
    ).length,
    recentNotes: recentlyUpdatedNotes.slice(0, RECENT_NOTES_LIMIT),
  };
}

export function loadDashboardData(): Promise<DashboardData> {
  if (inFlightDashboardRequest) return inFlightDashboardRequest;

  const request = requestNotes().then((notes) =>
    deriveDashboardData(notes, Date.now()),
  );
  inFlightDashboardRequest = request;

  const clearRequest = () => {
    if (inFlightDashboardRequest === request) {
      inFlightDashboardRequest = null;
    }
  };
  void request.then(clearRequest, clearRequest);

  return request;
}
