import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { getActiveYouTubeVideoId } from "./youtubeMetadata";

export type NoteBlockType =
  | "paragraph"
  | "heading"
  | "equation"
  | "timestamp"
  | "image";

export interface NoteBlock {
  id: string;
  type: NoteBlockType;
  content: string;
  metadata?: {
    source?: "url" | "upload";
    url?: string;
    alt?: string;
  };
}

export interface NoteDocument {
  version: 1;
  blocks: NoteBlock[];
}

export interface VideoNote {
  id: number;
  title: string;
  content: string;
  document?: NoteDocument;
  note_type: string;
  video?: number | null;
  folder?: number | null;
  timestamp_seconds?: number | null;
  created_at?: string;
  updated_at?: string;
}

interface VideoAnalysis {
  id: number;
  video: number;
  summary: string;
  detailed_notes: Record<string, unknown>;
  topics: string[];
  concepts: string[];
  prerequisites: string[];
  upcoming_topics: string[];
  key_points: Array<{ text: string; start: number }>;
  claims: Array<{ text: string; start: number }>;
  questions: string[];
  model: string;
  analysis_version: number;
  created_at: string;
  updated_at: string;
}

interface SidebarProps {
  videoId: string;
  videoTitle: string;
  notes: VideoNote[];
  contextStatus: "loading" | "loaded" | "error";
  transcriptStatus: TranscriptStatus | null;
}

type ViewMode = "LIST" | "READER" | "WRITER" | "AI";

type Theme = "dark" | "light";

type WorkspaceTab = "READ" | "WRITE" | "AI";

export type TranscriptStatus =
  | "NOT_STARTED"
  | "FETCHING"
  | "READY"
  | "FAILED";

interface Position {
  x: number;
  y: number;
}

interface ThemeColors {
  panel: string;
  header: string;
  surface: string;
  input: string;
  border: string;
  text: string;
  primaryText: string;
  muted: string;
  accent: string;
  accentSoft: string;
  danger: string;
  shadow: string;
}

const DARK_THEME: ThemeColors = {
  panel: "#0b1220",
  header: "#0f172a",
  surface: "#101827",
  input: "#111827",
  border: "#263449",
  text: "#dbe4f0",
  primaryText: "#f8fafc",
  muted: "#94a3b8",
  accent: "#67e8f9",
  accentSoft: "#12303a",
  danger: "#f87171",
  shadow: "rgba(0, 0, 0, 0.38)",
};

const LIGHT_THEME: ThemeColors = {
  panel: "#ffffff",
  header: "#f8fafc",
  surface: "#f1f5f9",
  input: "#ffffff",
  border: "#d7dee8",
  text: "#334155",
  primaryText: "#172033",
  muted: "#64748b",
  accent: "#0891b2",
  accentSoft: "#ecfeff",
  danger: "#dc2626",
  shadow: "rgba(15, 23, 42, 0.18)",
};

const POSITION_STORAGE_KEY = "youtubeKnowledgeSidebarPosition";

const THEME_STORAGE_KEY = "youtubeKnowledgeTheme";

const SIDEBAR_WIDTH = 390;
const SIDEBAR_HEIGHT_MARGIN = 30;
const MINIMIZED_SIZE = 46;

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createEmptyDocument(): NoteDocument {
  return {
    version: 1,
    blocks: [
      {
        id: createId(),
        type: "paragraph",
        content: "",
      },
    ],
  };
}

function normalizeDocument(note: VideoNote): NoteDocument {
  if (
    note.document &&
    note.document.version === 1 &&
    Array.isArray(note.document.blocks)
  ) {
    return note.document;
  }

  if (note.content?.trim()) {
    return {
      version: 1,
      blocks: [
        {
          id: createId(),
          type: "paragraph",
          content: note.content,
        },
      ],
    };
  }

  return createEmptyDocument();
}

function documentToPlainText(noteDocument: NoteDocument): string {
  return noteDocument.blocks
    .map((block) => {
      if (block.type === "timestamp") {
        return `[${block.content}]`;
      }

      if (block.type === "image") {
        return block.metadata?.alt
          ? `[Image: ${block.metadata.alt}]`
          : "[Image]";
      }

      return block.content;
    })
    .filter(Boolean)
    .join("\n\n");
}

function formatTimestamp(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));

  const hours = Math.floor(safeSeconds / 3600);

  const minutes = Math.floor((safeSeconds % 3600) / 60);

  const remainingSeconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds
      .toString()
      .padStart(2, "0")}`;
  }

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function parseTimestamp(value: string): number | null {
  const parts = value.split(":").map(Number);

  if (parts.length !== 2 && parts.length !== 3) {
    return null;
  }

  if (parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;

    if (minutes < 0 || seconds < 0 || seconds >= 60) {
      return null;
    }

    return minutes * 60 + seconds;
  }

  const [hours, minutes, seconds] = parts;

  if (
    hours < 0 ||
    minutes < 0 ||
    seconds < 0 ||
    minutes >= 60 ||
    seconds >= 60
  ) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

function getCurrentVideoTime(): number {
  const video = window.document.querySelector(
    "video",
  ) as HTMLVideoElement | null;

  if (!video) {
    return 0;
  }

  return Math.floor(video.currentTime);
}

function jumpToTimestamp(seconds: number): void {
  const video = window.document.querySelector(
    "video",
  ) as HTMLVideoElement | null;

  if (!video) {
    return;
  }

  video.currentTime = seconds;

  void video.play().catch(() => {
    // Browser may block autoplay.
  });
}

function clampPosition(
  position: Position,
  width: number,
  height: number,
): Position {
  const maxX = Math.max(0, window.innerWidth - width);

  const maxY = Math.max(0, window.innerHeight - height);

  return {
    x: Math.min(Math.max(0, position.x), maxX),
    y: Math.min(Math.max(0, position.y), maxY),
  };
}

function getDefaultPosition(): Position {
  return {
    x: Math.max(10, window.innerWidth - SIDEBAR_WIDTH - 20),
    y: 15,
  };
}

async function loadPosition(): Promise<Position> {
  return new Promise((resolve) => {
    chrome.storage.local.get([POSITION_STORAGE_KEY], (result) => {
      const stored = result[POSITION_STORAGE_KEY] as
        | Partial<Position>
        | undefined;

      if (
        stored &&
        typeof stored.x === "number" &&
        typeof stored.y === "number"
      ) {
        resolve(
          clampPosition(
            {
              x: stored.x,
              y: stored.y,
            },
            SIDEBAR_WIDTH,
            window.innerHeight - SIDEBAR_HEIGHT_MARGIN,
          ),
        );

        return;
      }

      resolve(getDefaultPosition());
    });
  });
}

function savePosition(position: Position): void {
  chrome.storage.local.set({
    [POSITION_STORAGE_KEY]: position,
  });
}

async function loadTheme(): Promise<Theme> {
  return new Promise((resolve) => {
    chrome.storage.local.get([THEME_STORAGE_KEY], (result) => {
      const stored = result[THEME_STORAGE_KEY];

      if (stored === "light" || stored === "dark") {
        resolve(stored);
        return;
      }

      resolve("dark");
    });
  });
}

function saveTheme(theme: Theme): void {
  chrome.storage.local.set({
    [THEME_STORAGE_KEY]: theme,
  });
}

function sendCreateNote(data: {
  title: string;
  content: string;
  document: NoteDocument;
  youtube_id: string;
  timestamp_seconds: number | null;
}): Promise<VideoNote> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "CREATE_NOTE",
        data: {
          title: data.title,
          content: data.content,
          document: data.document,
          note_type: "VIDEO",

          youtube_id: data.youtube_id,

          timestamp_seconds: data.timestamp_seconds,
        },
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));

          return;
        }

        if (!response?.success) {
          reject(new Error(response?.error || "Failed to create note."));

          return;
        }

        resolve(response.data.note);
      },
    );
  });
}

function sendUpdateNote(
  noteId: number,
  data: {
    title: string;
    content: string;
    document: NoteDocument;
  },
): Promise<VideoNote> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "UPDATE_NOTE",
        noteId,
        data: {
          title: data.title,
          content: data.content,
          document: data.document,
        },
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));

          return;
        }

        if (!response?.success) {
          reject(new Error(response?.error || "Failed to update note."));

          return;
        }

        resolve(response.data);
      },
    );
  });
}

function sendDeleteNote(noteId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "DELETE_NOTE",
        noteId,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));

          return;
        }

        if (!response?.success) {
          reject(new Error(response?.error || "Failed to delete note."));

          return;
        }

        resolve();
      },
    );
  });
}

export interface AnalyzeVideoResponse {
  success: boolean;
  status: number;
  data: unknown;
  error?: string;
}

export function sendAnalyzeVideo(
  videoId: string,
): Promise<AnalyzeVideoResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "ANALYZE_VIDEO",
        videoId,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));

          return;
        }

        if (!response || typeof response.status !== "number") {
          reject(new Error(response?.error || "Failed to analyze video."));

          return;
        }

        resolve({
          success: response.success === true,
          status: response.status,
          data: response.data,
          ...(typeof response.error === "string" && {
            error: response.error,
          }),
        });
      },
    );
  });
}

export function sendFetchTranscript(
  videoId: string,
): Promise<AnalyzeVideoResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "FETCH_TRANSCRIPT",
        videoId,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));

          return;
        }

        if (!response || typeof response.status !== "number") {
          reject(new Error(response?.error || "Failed to fetch transcript."));

          return;
        }

        resolve({
          success: response.success === true,
          status: response.status,
          data: response.data,
          ...(typeof response.error === "string" && {
            error: response.error,
          }),
        });
      },
    );
  });
}

function isVideoAnalysis(value: unknown): value is VideoAnalysis {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const analysis = value as Record<string, unknown>;
  return (
    typeof analysis.id === "number" &&
    typeof analysis.video === "number" &&
    typeof analysis.summary === "string" &&
    typeof analysis.detailed_notes === "object" &&
    analysis.detailed_notes !== null &&
    Array.isArray(analysis.topics) &&
    analysis.topics.every((topic) => typeof topic === "string") &&
    Array.isArray(analysis.concepts) &&
    analysis.concepts.every((concept) => typeof concept === "string") &&
    Array.isArray(analysis.prerequisites) &&
    analysis.prerequisites.every(
      (prerequisite) => typeof prerequisite === "string",
    ) &&
    Array.isArray(analysis.upcoming_topics) &&
    analysis.upcoming_topics.every((topic) => typeof topic === "string") &&
    Array.isArray(analysis.key_points) &&
    analysis.key_points.every(
      (point) =>
        typeof point === "object" &&
        point !== null &&
        "text" in point &&
        typeof point.text === "string" &&
        "start" in point &&
        typeof point.start === "number" &&
        Number.isFinite(point.start),
    ) &&
    Array.isArray(analysis.claims) &&
    analysis.claims.every(
      (claim) =>
        typeof claim === "object" &&
        claim !== null &&
        "text" in claim &&
        typeof claim.text === "string" &&
        "start" in claim &&
        typeof claim.start === "number" &&
        Number.isFinite(claim.start),
    ) &&
    Array.isArray(analysis.questions) &&
    analysis.questions.every((question) => typeof question === "string") &&
    typeof analysis.model === "string" &&
    typeof analysis.analysis_version === "number" &&
    typeof analysis.created_at === "string" &&
    typeof analysis.updated_at === "string"
  );
}

function AnalysisListSection({
  title,
  colors,
  children,
}: {
  title: string;
  colors: ThemeColors;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <h3
        style={{
          margin: "0 0 5px",
          color: colors.primaryText,
          fontSize: 12,
          fontWeight: 800,
        }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

function AnalysisTextList({
  items,
  colors,
}: {
  items: string[];
  colors: ThemeColors;
}) {
  if (items.length === 0) {
    return <AnalysisEmptyValue colors={colors} />;
  }

  return (
    <ul style={analysisListStyle}>
      {items.map((item, index) => (
        <li key={`${item}-${index}`} style={analysisListItemStyle(colors)}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function AnalysisEmptyValue({ colors }: { colors: ThemeColors }) {
  return (
    <div style={{ color: colors.muted, fontSize: 11 }}>
      No analysis available.
    </div>
  );
}

const analysisListStyle: CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  fontSize: 12,
  lineHeight: 1.55,
};

function analysisListItemStyle(colors: ThemeColors): CSSProperties {
  return {
    marginBottom: 4,
    color: colors.text,
  };
}

/* -------------------------------------------------------------------------- */
/* Block Editor                                                               */
/* -------------------------------------------------------------------------- */

interface BlockEditorProps {
  noteDocument: NoteDocument;
  colors: ThemeColors;
  onChange: (document: NoteDocument) => void;
}

function BlockEditor({ noteDocument, colors, onChange }: BlockEditorProps) {
  const [draggedBlockId, setDraggedBlockId] = useState<string | null>(null);

  const [dragOverBlockId, setDragOverBlockId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const imageInsertAfterRef = useRef<string | undefined>(undefined);

  function updateBlock(blockId: string, changes: Partial<NoteBlock>) {
    onChange({
      ...noteDocument,
      blocks: noteDocument.blocks.map((block) =>
        block.id === blockId
          ? {
              ...block,
              ...changes,
            }
          : block,
      ),
    });
  }

  function removeBlock(blockId: string) {
    const blocks = noteDocument.blocks.filter((block) => block.id !== blockId);

    onChange({
      ...noteDocument,
      blocks:
        blocks.length > 0
          ? blocks
          : [
              {
                id: createId(),
                type: "paragraph",
                content: "",
              },
            ],
    });
  }

  function addBlock(type: NoteBlockType, afterId?: string, content = "") {
    const newBlock: NoteBlock = {
      id: createId(),
      type,
      content,
    };

    const blocks = [...noteDocument.blocks];

    if (!afterId) {
      blocks.push(newBlock);
    } else {
      const index = blocks.findIndex((block) => block.id === afterId);

      if (index === -1) {
        blocks.push(newBlock);
      } else {
        blocks.splice(index + 1, 0, newBlock);
      }
    }

    onChange({
      ...noteDocument,
      blocks,
    });
  }

  function moveBlock(blockId: string, direction: "up" | "down") {
    const blocks = [...noteDocument.blocks];

    const currentIndex = blocks.findIndex((block) => block.id === blockId);

    if (currentIndex === -1) {
      return;
    }

    const newIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;

    if (newIndex < 0 || newIndex >= blocks.length) {
      return;
    }

    const [movedBlock] = blocks.splice(currentIndex, 1);

    blocks.splice(newIndex, 0, movedBlock);

    onChange({
      ...noteDocument,
      blocks,
    });
  }

  function handleDragStart(
    event: React.DragEvent<HTMLDivElement>,
    blockId: string,
  ) {
    setDraggedBlockId(blockId);

    event.dataTransfer.effectAllowed = "move";

    event.dataTransfer.setData("text/plain", blockId);
  }

  function handleDragOver(
    event: React.DragEvent<HTMLDivElement>,
    blockId: string,
  ) {
    event.preventDefault();

    event.dataTransfer.dropEffect = "move";

    if (draggedBlockId !== blockId) {
      setDragOverBlockId(blockId);
    }
  }

  function handleDrop(
    event: React.DragEvent<HTMLDivElement>,
    targetBlockId: string,
  ) {
    event.preventDefault();

    const sourceBlockId =
      draggedBlockId || event.dataTransfer.getData("text/plain");

    if (!sourceBlockId || sourceBlockId === targetBlockId) {
      setDraggedBlockId(null);
      setDragOverBlockId(null);
      return;
    }

    const blocks = [...noteDocument.blocks];

    const sourceIndex = blocks.findIndex((block) => block.id === sourceBlockId);

    const targetIndex = blocks.findIndex((block) => block.id === targetBlockId);

    if (sourceIndex === -1 || targetIndex === -1) {
      return;
    }

    const [movedBlock] = blocks.splice(sourceIndex, 1);

    blocks.splice(targetIndex, 0, movedBlock);

    onChange({
      ...noteDocument,
      blocks,
    });

    setDraggedBlockId(null);
    setDragOverBlockId(null);
  }

  function handleDragEnd() {
    setDraggedBlockId(null);
    setDragOverBlockId(null);
  }

  function addImageFromUrl(afterId?: string) {
    const url = window.prompt("Enter image URL:");

    if (!url?.trim()) {
      return;
    }

    addImageBlock(url.trim(), "url", afterId);
  }

  function addImageBlock(
    source: string,
    sourceType: "url" | "upload",
    afterId?: string,
    alt = "",
  ) {
    const newBlock: NoteBlock = {
      id: createId(),
      type: "image",
      content: source,
      metadata: {
        source: sourceType,
        url: source,
        alt,
      },
    };

    const blocks = [...noteDocument.blocks];

    if (!afterId) {
      blocks.push(newBlock);
    } else {
      const index = blocks.findIndex((block) => block.id === afterId);

      if (index === -1) {
        blocks.push(newBlock);
      } else {
        blocks.splice(index + 1, 0, newBlock);
      }
    }

    onChange({
      ...noteDocument,
      blocks,
    });
  }

  function startImageUpload(afterId?: string) {
    imageInsertAfterRef.current = afterId;

    fileInputRef.current?.click();
  }

  function handleImageUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      window.alert("Please select an image file.");

      event.target.value = "";
      return;
    }

    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result !== "string") {
        return;
      }

      addImageBlock(
        reader.result,
        "upload",
        imageInsertAfterRef.current,
        file.name,
      );

      imageInsertAfterRef.current = undefined;
    };

    reader.readAsDataURL(file);

    event.target.value = "";
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleImageUpload}
        style={{
          display: "none",
        }}
      />

      {noteDocument.blocks.map((block, index) => {
        const isDragging = draggedBlockId === block.id;

        const isDragTarget = dragOverBlockId === block.id;

        return (
          <div
            key={block.id}
            draggable
            onDragStart={(event) => handleDragStart(event, block.id)}
            onDragOver={(event) => handleDragOver(event, block.id)}
            onDrop={(event) => handleDrop(event, block.id)}
            onDragEnd={handleDragEnd}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 7,
              padding: 9,
              borderRadius: 10,
              border: `1px solid ${
                isDragTarget ? colors.accent : colors.border
              }`,
              background: colors.surface,
              opacity: isDragging ? 0.5 : 1,
              boxShadow: isDragTarget
                ? `0 0 0 2px ${colors.accentSoft}`
                : "none",
              transition: "border-color 0.15s, opacity 0.15s",
            }}
          >
            {/* Block toolbar */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 6,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                <span
                  title="Drag to rearrange"
                  style={{
                    cursor: "grab",
                    color: colors.muted,
                    fontSize: 14,
                    userSelect: "none",
                  }}
                >
                  ⋮⋮
                </span>

                <select
                  value={block.type}
                  onChange={(event) =>
                    updateBlock(block.id, {
                      type: event.target.value as NoteBlockType,
                    })
                  }
                  style={{
                    ...editorControlStyle,
                    color: colors.muted,
                    background: colors.surface,
                    borderColor: colors.border,
                  }}
                >
                  <option value="paragraph">Paragraph</option>

                  <option value="heading">Heading</option>

                  <option value="equation">Equation</option>

                  <option value="timestamp">Timestamp</option>

                  <option value="image">Image</option>
                </select>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => moveBlock(block.id, "up")}
                  title="Move block up"
                  style={{
                    ...iconButtonStyle,
                    color: index === 0 ? colors.border : colors.muted,
                    borderColor: colors.border,
                  }}
                >
                  ↑
                </button>

                <button
                  type="button"
                  disabled={index === noteDocument.blocks.length - 1}
                  onClick={() => moveBlock(block.id, "down")}
                  title="Move block down"
                  style={{
                    ...iconButtonStyle,
                    color:
                      index === noteDocument.blocks.length - 1
                        ? colors.border
                        : colors.muted,
                    borderColor: colors.border,
                  }}
                >
                  ↓
                </button>

                <button
                  type="button"
                  onClick={() => removeBlock(block.id)}
                  title="Delete block"
                  style={{
                    ...iconButtonStyle,
                    color: colors.muted,
                    borderColor: colors.border,
                  }}
                >
                  ×
                </button>
              </div>
            </div>

            {/* Block content */}
            {block.type === "timestamp" ? (
              <button
                type="button"
                onClick={() => {
                  const seconds = parseTimestamp(block.content);

                  if (seconds !== null) {
                    jumpToTimestamp(seconds);
                  }
                }}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "12px 13px",
                  borderRadius: 9,
                  border: `1px solid ${colors.border}`,
                  background: colors.accentSoft,
                  color: colors.accent,
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                ▶ {block.content || "0:00"}
              </button>
            ) : block.type === "heading" ? (
              <input
                value={block.content}
                onChange={(event) =>
                  updateBlock(block.id, {
                    content: event.target.value,
                  })
                }
                placeholder="Heading"
                style={{
                  ...editorInputStyle,
                  fontSize: 17,
                  fontWeight: 700,
                  color: colors.primaryText,
                  background: colors.input,
                  borderColor: colors.border,
                }}
              />
            ) : block.type === "image" ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <img
                  src={block.content}
                  alt={block.metadata?.alt || "Note image"}
                  style={{
                    width: "100%",
                    maxHeight: 300,
                    objectFit: "contain",
                    borderRadius: 8,
                    background: colors.input,
                    border: `1px solid ${colors.border}`,
                  }}
                />

                <input
                  value={block.metadata?.alt || ""}
                  onChange={(event) =>
                    updateBlock(block.id, {
                      metadata: {
                        ...block.metadata,
                        alt: event.target.value,
                      },
                    })
                  }
                  placeholder="Image description (optional)"
                  style={{
                    ...editorInputStyle,
                    color: colors.primaryText,
                    background: colors.input,
                    borderColor: colors.border,
                    fontSize: 11,
                  }}
                />
              </div>
            ) : (
              <textarea
                value={block.content}
                onChange={(event) =>
                  updateBlock(block.id, {
                    content: event.target.value,
                  })
                }
                placeholder={
                  block.type === "equation"
                    ? "Write equation, e.g. E = mc^2"
                    : "Write your note..."
                }
                rows={block.type === "equation" ? 2 : 4}
                style={{
                  ...editorTextareaStyle,
                  fontFamily:
                    block.type === "equation"
                      ? "Cambria Math, STIX Two Math, serif"
                      : undefined,
                  fontSize: block.type === "equation" ? 17 : 14,
                  fontStyle: block.type === "equation" ? "italic" : undefined,
                  color: colors.primaryText,
                  background: colors.input,
                  borderColor: colors.border,
                }}
              />
            )}

            {/* Block actions */}
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                onClick={() => addBlock("paragraph", block.id)}
                style={{
                  ...smallToolButton,
                  color: colors.muted,
                  borderColor: colors.border,
                }}
              >
                + Text
              </button>

              <button
                type="button"
                onClick={() => addBlock("heading", block.id)}
                style={{
                  ...smallToolButton,
                  color: colors.muted,
                  borderColor: colors.border,
                }}
              >
                + Heading
              </button>

              <button
                type="button"
                onClick={() => addBlock("equation", block.id)}
                style={{
                  ...smallToolButton,
                  color: colors.muted,
                  borderColor: colors.border,
                }}
              >
                + Equation
              </button>

              <button
                type="button"
                onClick={() =>
                  addBlock(
                    "timestamp",
                    block.id,
                    formatTimestamp(getCurrentVideoTime()),
                  )
                }
                style={{
                  ...smallToolButton,
                  color: colors.accent,
                  borderColor: colors.border,
                }}
              >
                + Timestamp
              </button>

              <button
                type="button"
                onClick={() => startImageUpload(block.id)}
                style={{
                  ...smallToolButton,
                  color: colors.muted,
                  borderColor: colors.border,
                }}
              >
                + Image
              </button>

              <button
                type="button"
                onClick={() => addImageFromUrl(block.id)}
                style={{
                  ...smallToolButton,
                  color: colors.muted,
                  borderColor: colors.border,
                }}
              >
                + Image URL
              </button>
            </div>
          </div>
        );
      })}

      <button
        type="button"
        onClick={() => addBlock("paragraph")}
        style={{
          width: "100%",
          border: `1px dashed ${colors.border}`,
          borderRadius: 8,
          background: "transparent",
          color: colors.muted,
          padding: "8px 10px",
          cursor: "pointer",
          fontSize: 11,
        }}
      >
        + Add block
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Reader                                                                     */
/* -------------------------------------------------------------------------- */

interface NoteReaderProps {
  note: VideoNote;
  colors: ThemeColors;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting: boolean;
  onGenerateExplanation: () => void;
  explanationState: "idle" | "loading" | "unavailable";
}

function NoteReader({
  note,
  colors,
  onBack,
  onEdit,
  onDelete,
  isDeleting,
  onGenerateExplanation,
  explanationState,
}: NoteReaderProps) {
  const noteDocument = normalizeDocument(note);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 10,
          marginBottom: 20,
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{
            ...headerActionButton,
            color: colors.text,
            borderColor: colors.border,
            background: colors.surface,
          }}
        >
          ← Back
        </button>

        <button
          type="button"
          onClick={onEdit}
          style={{
            ...headerActionButton,
            color: colors.accent,
            borderColor: colors.border,
            background: colors.surface,
          }}
        >
          ✎ Edit
        </button>

        <button
          type="button"
          onClick={onDelete}
          disabled={isDeleting}
          style={{
            ...headerActionButton,
            color: colors.danger,
            borderColor: colors.border,
            background: colors.surface,
            opacity: isDeleting ? 0.55 : 1,
          }}
        >
          {isDeleting ? "Deleting…" : "Delete"}
        </button>
      </div>

      <h1
        style={{
          margin: "0 0 18px",
          fontSize: 23,
          lineHeight: 1.25,
          color: colors.primaryText,
        }}
      >
        {note.title}
      </h1>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {noteDocument.blocks.map((block) => {
          if (block.type === "heading") {
            return (
              <h2
                key={block.id}
                style={{
                  margin: 0,
                  fontSize: 19,
                  lineHeight: 1.35,
                  color: colors.primaryText,
                }}
              >
                {block.content || "Untitled heading"}
              </h2>
            );
          }

          if (block.type === "equation") {
            return (
              <div
                key={block.id}
                style={{
                  padding: "14px 16px",
                  borderRadius: 10,
                  background: colors.surface,
                  border: `1px solid ${colors.border}`,
                  fontFamily: "Cambria Math, STIX Two Math, serif",
                  fontSize: 18,
                  fontStyle: "italic",
                  color: colors.primaryText,
                  overflowX: "auto",
                }}
              >
                {block.content || "No equation"}
              </div>
            );
          }

          if (block.type === "timestamp") {
            const seconds = parseTimestamp(block.content);

            return (
              <button
                key={block.id}
                type="button"
                disabled={seconds === null}
                onClick={() => {
                  if (seconds !== null) {
                    jumpToTimestamp(seconds);
                  }
                }}
                style={{
                  alignSelf: "flex-start",
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  padding: "7px 10px",
                  background: colors.accentSoft,
                  color: colors.accent,
                  cursor: seconds !== null ? "pointer" : "default",
                  fontWeight: 700,
                }}
              >
                ▶ {block.content}
              </button>
            );
          }

          if (block.type === "image") {
            return (
              <figure
                key={block.id}
                style={{
                  margin: 0,
                }}
              >
                <img
                  src={block.content}
                  alt={block.metadata?.alt || "Note image"}
                  style={{
                    width: "100%",
                    maxHeight: 420,
                    objectFit: "contain",
                    borderRadius: 10,
                    background: colors.surface,
                    border: `1px solid ${colors.border}`,
                  }}
                />

                {block.metadata?.alt && (
                  <figcaption
                    style={{
                      marginTop: 5,
                      color: colors.muted,
                      fontSize: 10,
                    }}
                  >
                    {block.metadata.alt}
                  </figcaption>
                )}
              </figure>
            );
          }

          return (
            <p
              key={block.id}
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                fontSize: 14,
                lineHeight: 1.75,
                color: colors.text,
              }}
            >
              {block.content || "Empty paragraph"}
            </p>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 24,
          paddingTop: 15,
          borderTop: `1px solid ${colors.border}`,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 800,
            color: colors.primaryText,
            marginBottom: 8,
          }}
        >
          Video Intelligence
        </div>

        <button
          type="button"
          onClick={onGenerateExplanation}
          disabled={explanationState === "loading"}
          style={{
            width: "100%",
            border: `1px solid ${colors.border}`,
            borderRadius: 9,
            padding: "10px 12px",
            background: colors.accentSoft,
            color: colors.accent,
            cursor: explanationState === "loading" ? "default" : "pointer",
            fontSize: 11,
            fontWeight: 800,
          }}
        >
          {explanationState === "loading"
            ? "Preparing explanation..."
            : "✨ Generate detailed explanation from transcript"}
        </button>

        {explanationState === "unavailable" && (
          <div
            style={{
              marginTop: 8,
              padding: 10,
              borderRadius: 8,
              background: colors.surface,
              border: `1px solid ${colors.border}`,
              color: colors.muted,
              fontSize: 11,
              lineHeight: 1.5,
            }}
          >
            Transcript intelligence is not connected yet. This UI is ready for
            the transcript-analysis phase.
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Writer                                                                     */
/* -------------------------------------------------------------------------- */

interface NoteWriterProps {
  note: VideoNote | null;
  videoId: string;
  colors: ThemeColors;
  onBack: () => void;
  onSaved: (note: VideoNote) => void;
  onDelete: () => void;
  isDeleting: boolean;
}

function NoteWriter({
  note,
  videoId,
  colors,
  onBack,
  onSaved,
  onDelete,
  isDeleting,
}: NoteWriterProps) {
  const [title, setTitle] = useState(note?.title ?? "");

  const [noteDocument, setNoteDocument] = useState<NoteDocument>(() =>
    note ? normalizeDocument(note) : createEmptyDocument(),
  );

  const [isSaving, setIsSaving] = useState(false);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(note?.title ?? "");

    setNoteDocument(note ? normalizeDocument(note) : createEmptyDocument());

    setError(null);
  }, [note]);

  async function handleSave() {
    if (!title.trim()) {
      setError("Please enter a note title.");

      return;
    }

    const cleanedDocument: NoteDocument = {
      version: 1,
      blocks: noteDocument.blocks.map((block) => ({
        ...block,
        content: block.type === "image" ? block.content : block.content.trim(),
      })),
    };

    const plainText = documentToPlainText(cleanedDocument);

    if (!plainText.trim()) {
      setError("Please write something in the note.");

      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      let savedNote: VideoNote;

      if (note) {
        savedNote = await sendUpdateNote(note.id, {
          title: title.trim(),
          content: plainText,
          document: cleanedDocument,
        });
      } else {
        const activeVideoId = getActiveYouTubeVideoId();

        if (!activeVideoId) {
          throw new Error("The active YouTube video could not be identified.");
        }

        if (videoId !== activeVideoId) {
          throw new Error(
            "The sidebar is updating for the current video. Please try saving again.",
          );
        }

        savedNote = await sendCreateNote({
          title: title.trim(),
          content: plainText,
          document: cleanedDocument,
          youtube_id: activeVideoId,
          timestamp_seconds: null,
        });
      }

      onSaved(savedNote);
    } catch (saveError) {
      const errorMessage =
        saveError instanceof Error ? saveError.message : "Failed to save note.";

      setError(
        /extension context invalidated/i.test(errorMessage)
          ? "The extension was reloaded. Refresh this YouTube tab, then reopen the sidebar and save your note again."
          : errorMessage,
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 10,
          marginBottom: 18,
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{
            ...headerActionButton,
            color: colors.text,
            borderColor: colors.border,
            background: colors.surface,
          }}
        >
          ← Back
        </button>

        {note && (
          <button
            type="button"
            onClick={onDelete}
            disabled={isDeleting || isSaving}
            style={{
              ...headerActionButton,
              color: colors.danger,
              borderColor: colors.border,
              background: colors.surface,
              opacity: isDeleting || isSaving ? 0.55 : 1,
            }}
          >
            {isDeleting ? "Deleting…" : "Delete"}
          </button>
        )}

        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          title="Save note"
          style={{
            ...headerActionButton,
            color: colors.accent,
            borderColor: colors.border,
            background: colors.surface,
            opacity: isSaving ? 0.55 : 1,
            cursor: isSaving ? "default" : "pointer",
          }}
        >
          {isSaving ? "Saving…" : "💾 Save"}
        </button>
      </div>

      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Note title"
        style={{
          width: "100%",
          boxSizing: "border-box",
          border: `1px solid ${colors.border}`,
          borderRadius: 10,
          background: colors.input,
          color: colors.primaryText,
          padding: "12px 13px",
          fontSize: 18,
          fontWeight: 700,
          outline: "none",
          marginBottom: 16,
        }}
      />

      <BlockEditor
        noteDocument={noteDocument}
        colors={colors}
        onChange={setNoteDocument}
      />

      <div
        style={{
          marginTop: 18,
          padding: 12,
          borderRadius: 9,
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          color: colors.muted,
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        <strong
          style={{
            color: colors.text,
          }}
        >
          Tip:
        </strong>{" "}
        Drag the ⋮⋮ handle to rearrange blocks. You can also use ↑ and ↓ to move
        a block.
      </div>

      {error && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 8,
            background: "rgba(248,113,113,0.10)",
            border: `1px solid ${colors.danger}`,
            color: colors.danger,
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={isSaving}
        style={{
          marginTop: 18,
          width: "100%",
          border: "none",
          borderRadius: 9,
          padding: "11px 14px",
          background: colors.accent,
          color: colors.panel === "#0b1220" ? "#082f49" : "#ffffff",
          fontWeight: 800,
          cursor: isSaving ? "default" : "pointer",
          opacity: isSaving ? 0.6 : 1,
        }}
      >
        {isSaving ? "Saving..." : "Save Note"}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* AI                                                                         */
/* -------------------------------------------------------------------------- */

interface AIWorkspaceProps {
  colors: ThemeColors;
  videoTitle: string;
}

function AIWorkspace({ colors, videoTitle }: AIWorkspaceProps) {
  const [question, setQuestion] = useState("");

  const [message, setMessage] = useState("");

  function handleAsk() {
    if (!question.trim()) {
      setMessage("Please enter a question.");

      return;
    }

    setMessage(
      "AI/RAG is not connected yet. The AI workspace is ready for the RAG phase.",
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div>
        <div
          style={{
            fontSize: 20,
            fontWeight: 800,
            color: colors.primaryText,
          }}
        >
          Ask AI
        </div>

        <div
          style={{
            marginTop: 5,
            fontSize: 11,
            lineHeight: 1.5,
            color: colors.muted,
          }}
        >
          Ask questions about the current video, your notes, or your personal
          knowledge base.
        </div>
      </div>

      <div
        style={{
          padding: 11,
          borderRadius: 9,
          background: colors.surface,
          border: `1px solid ${colors.border}`,
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: colors.muted,
            marginBottom: 4,
          }}
        >
          CURRENT VIDEO
        </div>

        <div
          style={{
            fontSize: 12,
            color: colors.primaryText,
            fontWeight: 700,
          }}
        >
          {videoTitle || "YouTube video"}
        </div>
      </div>

      <textarea
        value={question}
        onChange={(event) => {
          setQuestion(event.target.value);
          setMessage("");
        }}
        placeholder="Ask something about this video..."
        rows={6}
        style={{
          ...editorTextareaStyle,
          color: colors.primaryText,
          background: colors.input,
          borderColor: colors.border,
        }}
      />

      <button
        type="button"
        onClick={handleAsk}
        style={{
          width: "100%",
          border: "none",
          borderRadius: 9,
          padding: "11px 14px",
          background: colors.accent,
          color: colors.panel === "#0b1220" ? "#082f49" : "#ffffff",
          fontWeight: 800,
          cursor: "pointer",
        }}
      >
        Ask AI
      </button>

      {message && (
        <div
          style={{
            padding: 10,
            borderRadius: 8,
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            color: colors.muted,
            fontSize: 11,
            lineHeight: 1.5,
          }}
        >
          {message}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Main Sidebar                                                               */
/* -------------------------------------------------------------------------- */

export default function Sidebar({
  videoId,
  videoTitle,
  notes,
  contextStatus,
  transcriptStatus,
}: SidebarProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("LIST");

  const [currentNotes, setCurrentNotes] = useState(notes);

  const [videoAnalysis, setVideoAnalysis] = useState<{
    videoId: string;
    analysis: VideoAnalysis;
  } | null>(null);

  const [analysisLoadingVideoId, setAnalysisLoadingVideoId] = useState<
    string | null
  >(null);

  const [analysisError, setAnalysisError] = useState<{
    videoId: string;
    message: string;
  } | null>(null);

  const [transcriptState, setTranscriptState] = useState<{
    videoId: string;
    status: TranscriptStatus;
  } | null>(null);

  const [transcriptLoadingVideoId, setTranscriptLoadingVideoId] = useState<
    string | null
  >(null);

  const [transcriptError, setTranscriptError] = useState<{
    videoId: string;
    message: string;
  } | null>(null);

  const [selectedNote, setSelectedNote] = useState<VideoNote | null>(null);

  const [editingNote, setEditingNote] = useState<VideoNote | null>(null);

  const [deletePendingNoteId, setDeletePendingNoteId] = useState<number | null>(
    null,
  );

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [minimized, setMinimized] = useState(false);

  const [position, setPosition] = useState<Position>(getDefaultPosition());

  const [theme, setTheme] = useState<Theme>("dark");

  const [dragging, setDragging] = useState(false);

  const [minimizedDragging, setMinimizedDragging] = useState(false);

  const [explanationState, setExplanationState] = useState<
    "idle" | "loading" | "unavailable"
  >("idle");

  const dragOffset = useRef<Position>({
    x: 0,
    y: 0,
  });

  const minimizedDragOffset = useRef<Position>({
    x: 0,
    y: 0,
  });

  const savePositionTimeout = useRef<number | null>(null);

  const analysisRequestVersion = useRef(0);
  const transcriptRequestVersion = useRef(0);
  const currentVideoIdRef = useRef(videoId);
  currentVideoIdRef.current = videoId;

  useEffect(() => {
    let mounted = true;

    void loadPosition().then((loadedPosition) => {
      if (mounted) {
        setPosition(loadedPosition);
      }
    });

    void loadTheme().then((loadedTheme) => {
      if (mounted) {
        setTheme(loadedTheme);
      }
    });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    setCurrentNotes(notes);
  }, [notes]);

  useEffect(() => {
    analysisRequestVersion.current += 1;
    setVideoAnalysis(null);
    setAnalysisLoadingVideoId(null);
    setAnalysisError(null);
    transcriptRequestVersion.current += 1;
    setTranscriptState(null);
    setTranscriptLoadingVideoId(null);
    setTranscriptError(null);

    return () => {
      analysisRequestVersion.current += 1;
      transcriptRequestVersion.current += 1;
    };
  }, [videoId]);

  useEffect(() => {
    if (
      contextStatus === "loaded" &&
      transcriptStatus !== null
    ) {
      setTranscriptState({ videoId, status: transcriptStatus });
      setTranscriptError(null);
    }
  }, [contextStatus, transcriptStatus, videoId]);

  useEffect(() => {
    return () => {
      if (savePositionTimeout.current !== null) {
        window.clearTimeout(savePositionTimeout.current);
      }
    };
  }, []);

  const colors = theme === "dark" ? DARK_THEME : LIGHT_THEME;
  const currentAnalysis =
    videoAnalysis?.videoId === videoId ? videoAnalysis.analysis : null;
  const currentAnalysisError =
    analysisError?.videoId === videoId ? analysisError.message : null;
  const isAnalyzing = analysisLoadingVideoId === videoId;
  const currentTranscriptStatus =
    transcriptState?.videoId === videoId
      ? transcriptState.status
      : "NOT_STARTED";
  const currentTranscriptError =
    transcriptError?.videoId === videoId ? transcriptError.message : null;
  const isFetchingTranscript = transcriptLoadingVideoId === videoId;

  function updatePosition(nextPosition: Position) {
    const next = clampPosition(
      nextPosition,
      minimized ? MINIMIZED_SIZE : SIDEBAR_WIDTH,
      minimized ? MINIMIZED_SIZE : window.innerHeight - SIDEBAR_HEIGHT_MARGIN,
    );

    setPosition(next);

    if (savePositionTimeout.current !== null) {
      window.clearTimeout(savePositionTimeout.current);
    }

    savePositionTimeout.current = window.setTimeout(() => {
      savePosition(next);
    }, 100);
  }

  function startDragging(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement;

    if (
      target.closest("button") ||
      target.closest("input") ||
      target.closest("select") ||
      target.closest("textarea")
    ) {
      return;
    }

    dragOffset.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y,
    };

    setDragging(true);

    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDragging(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging) {
      return;
    }

    updatePosition({
      x: event.clientX - dragOffset.current.x,
      y: event.clientY - dragOffset.current.y,
    });
  }

  function stopDragging(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging) {
      return;
    }

    setDragging(false);

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released.
    }
  }

  function startMinimizedDragging(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) {
      return;
    }

    minimizedDragOffset.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y,
    };

    setMinimizedDragging(true);

    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveMinimizedDragging(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!minimizedDragging) {
      return;
    }

    updatePosition({
      x: event.clientX - minimizedDragOffset.current.x,
      y: event.clientY - minimizedDragOffset.current.y,
    });
  }

  function stopMinimizedDragging(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!minimizedDragging) {
      return;
    }

    setMinimizedDragging(false);

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released.
    }
  }

  function toggleTheme() {
    const nextTheme: Theme = theme === "dark" ? "light" : "dark";

    setTheme(nextTheme);
    saveTheme(nextTheme);
  }

  function openReader(note: VideoNote) {
    setSelectedNote(note);
    setEditingNote(null);
    setViewMode("READER");
  }

  function openEditor(note: VideoNote | null) {
    setEditingNote(note);
    setSelectedNote(note);
    setViewMode("WRITER");
  }

  function returnToList() {
    setSelectedNote(null);
    setEditingNote(null);
    setViewMode("LIST");
  }

  function handleSaved(savedNote: VideoNote) {
    setCurrentNotes((current) => [
      savedNote,
      ...current.filter((note) => note.id !== savedNote.id),
    ]);
    setSelectedNote(savedNote);
    setEditingNote(null);
    setViewMode("READER");
  }

  async function handleAnalyzeVideo() {
    if (currentTranscriptStatus !== "READY") {
      return;
    }

    const activeVideoId = getActiveYouTubeVideoId();
    if (!videoId.trim() || activeVideoId !== videoId) {
      setAnalysisError({
        videoId,
        message: "The active YouTube video could not be identified. Try again.",
      });
      return;
    }

    const requestVersion = ++analysisRequestVersion.current;
    setAnalysisError(null);
    setAnalysisLoadingVideoId(videoId);

    try {
      const response = await sendAnalyzeVideo(videoId);
      if (
        requestVersion !== analysisRequestVersion.current ||
        currentVideoIdRef.current !== videoId
      ) {
        return;
      }

      if (response.status === 200 && response.success) {
        const payload = response.data;
        if (
          typeof payload === "object" &&
          payload !== null &&
          "analysis" in payload &&
          isVideoAnalysis(payload.analysis)
        ) {
          setVideoAnalysis({
            videoId,
            analysis: payload.analysis,
          });
          return;
        }

        setAnalysisError({
          videoId,
          message: "The analysis response was invalid.",
        });
      } else if (response.status === 409) {
        setAnalysisError({
          videoId,
          message: "A ready transcript is required before analysis.",
        });
      } else if (response.status === 502) {
        setAnalysisError({
          videoId,
          message: "Video analysis failed. Please try again later.",
        });
      } else {
        setAnalysisError({
          videoId,
          message: "The analysis request failed.",
        });
      }
    } catch {
      if (
        requestVersion === analysisRequestVersion.current &&
        currentVideoIdRef.current === videoId
      ) {
        setAnalysisError({
          videoId,
          message: "Could not connect to the analysis service.",
        });
      }
    } finally {
      if (
        requestVersion === analysisRequestVersion.current &&
        currentVideoIdRef.current === videoId
      ) {
        setAnalysisLoadingVideoId(null);
      }
    }
  }

  async function handleFetchTranscript() {
    const activeVideoId = getActiveYouTubeVideoId();
    if (!videoId.trim() || activeVideoId !== videoId) {
      setTranscriptError({
        videoId,
        message: "The active YouTube video could not be identified. Try again.",
      });
      return;
    }
    if (currentTranscriptStatus === "READY" || isFetchingTranscript) {
      return;
    }

    const requestVersion = ++transcriptRequestVersion.current;
    setTranscriptError(null);
    setTranscriptState({ videoId, status: "FETCHING" });
    setTranscriptLoadingVideoId(videoId);

    try {
      const response = await sendFetchTranscript(videoId);
      if (
        requestVersion !== transcriptRequestVersion.current ||
        currentVideoIdRef.current !== videoId
      ) {
        return;
      }

      if (response.status === 200 && response.success) {
        setTranscriptState({ videoId, status: "READY" });
        return;
      }

      setTranscriptState({ videoId, status: "FAILED" });
      if (response.status === 404) {
        setTranscriptError({
          videoId,
          message: "Captions or a transcript are unavailable for this video.",
        });
      } else if (response.status === 502) {
        setTranscriptError({
          videoId,
          message: "Transcript retrieval failed. Please try again later.",
        });
      } else {
        setTranscriptError({
          videoId,
          message: "The transcript request failed.",
        });
      }
    } catch {
      if (
        requestVersion === transcriptRequestVersion.current &&
        currentVideoIdRef.current === videoId
      ) {
        setTranscriptState({ videoId, status: "FAILED" });
        setTranscriptError({
          videoId,
          message: "Could not connect to the transcript service.",
        });
      }
    } finally {
      if (
        requestVersion === transcriptRequestVersion.current &&
        currentVideoIdRef.current === videoId
      ) {
        setTranscriptLoadingVideoId(null);
      }
    }
  }

  async function handleDelete(note: VideoNote) {
    if (deletePendingNoteId !== null) {
      return;
    }

    if (!window.confirm(`Delete "${note.title || "Untitled note"}"?`)) {
      return;
    }

    setDeletePendingNoteId(note.id);
    setDeleteError(null);

    try {
      await sendDeleteNote(note.id);

      setCurrentNotes((current) =>
        current.filter((currentNote) => currentNote.id !== note.id),
      );

      if (
        selectedNote?.id === note.id ||
        editingNote?.id === note.id
      ) {
        setSelectedNote(null);
        setEditingNote(null);
        setViewMode("LIST");
      }

      setExplanationState("idle");
    } catch (deleteFailure) {
      setDeleteError(
        deleteFailure instanceof Error
          ? deleteFailure.message
          : "Failed to delete note.",
      );
    } finally {
      setDeletePendingNoteId(null);
    }
  }

  function closeSidebar() {
    const root = window.document.getElementById("youtube-knowledge-root");

    root?.remove();
  }

  function handleWorkspaceTab(tab: WorkspaceTab) {
    if (!selectedNote) {
      return;
    }

    if (tab === "READ") {
      setViewMode("READER");
      return;
    }

    if (tab === "WRITE") {
      setEditingNote(selectedNote);
      setViewMode("WRITER");
      return;
    }

    setViewMode("AI");
  }

  /*
   * Important:
   * The Read / Write / AI bar is deliberately rendered
   * only when selectedNote exists.
   */

  if (minimized) {
    return (
      <button
        type="button"
        onPointerDown={startMinimizedDragging}
        onPointerMove={moveMinimizedDragging}
        onPointerUp={stopMinimizedDragging}
        onDoubleClick={() => setMinimized(false)}
        title="Drag to move • Double-click to open"
        style={{
          position: "fixed",
          left: position.x,
          top: position.y,
          width: MINIMIZED_SIZE,
          height: MINIMIZED_SIZE,
          zIndex: 2147483647,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          background: colors.panel,
          color: colors.accent,
          cursor: minimizedDragging ? "grabbing" : "grab",
          boxShadow: `0 12px 35px ${colors.shadow}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 21,
          userSelect: "none",
          touchAction: "none",
          padding: 0,
        }}
      >
        🧠
      </button>
    );
  }

  return (
    <aside
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        width: SIDEBAR_WIDTH,
        height: "calc(100vh - 30px)",
        maxHeight: "calc(100vh - 30px)",
        zIndex: 2147483647,
        background: colors.panel,
        color: colors.text,
        border: `1px solid ${colors.border}`,
        borderRadius: 14,
        boxShadow: `0 18px 60px ${colors.shadow}`,
        fontFamily:
          "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
      onPointerMove={moveDragging}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
    >
      {/* Header */}
      <div
        onPointerDown={startDragging}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "12px 14px",
          background: colors.header,
          borderBottom: `1px solid ${colors.border}`,
          cursor: dragging ? "grabbing" : "grab",
          userSelect: "none",
          touchAction: "none",
        }}
      >
        <div
          style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 800,
              color: colors.primaryText,
            }}
          >
            YouTube Knowledge
          </div>

          <div
            style={{
              fontSize: 10,
              color: colors.muted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 190,
            }}
          >
            {videoId}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setMinimized(true)}
            title="Minimize"
            style={{
              ...topIconButton,
              color: colors.muted,
              borderColor: colors.border,
            }}
          >
            −
          </button>

          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={toggleTheme}
            title={
              theme === "dark" ? "Switch to day mode" : "Switch to night mode"
            }
            style={{
              ...topIconButton,
              color: colors.accent,
              borderColor: colors.border,
            }}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>

          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={closeSidebar}
            title="Close"
            style={{
              ...topIconButton,
              color: colors.muted,
              borderColor: colors.border,
            }}
          >
            ×
          </button>
        </div>
      </div>

      {/* Workspace tabs - ONLY after a note is selected */}
      {selectedNote && (
        <div
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 4,
            padding: "7px 10px",
            background: colors.surface,
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          {(
            [
              ["READ", "Read"],
              ["WRITE", "Write"],
              ["AI", "AI"],
            ] as const
          ).map(([value, label]) => {
            const active =
              (value === "READ" && viewMode === "READER") ||
              (value === "WRITE" && viewMode === "WRITER") ||
              (value === "AI" && viewMode === "AI");

            return (
              <button
                key={value}
                type="button"
                onClick={() => handleWorkspaceTab(value)}
                style={{
                  border: `1px solid ${active ? colors.accent : colors.border}`,
                  borderRadius: 7,
                  padding: "7px 8px",
                  background: active ? colors.accentSoft : "transparent",
                  color: active ? colors.accent : colors.muted,
                  cursor: "pointer",
                  fontSize: 10,
                  fontWeight: active ? 800 : 650,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Video title is shown only in the note list, not as a separate section */}
      {!selectedNote && viewMode === "LIST" && (
        <div
          style={{
            padding: "10px 15px",
            background: colors.surface,
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: colors.primaryText,
              lineHeight: 1.4,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {videoTitle || "YouTube video"}
          </div>
        </div>
      )}

      {/* Content */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: 15,
          background: colors.panel,
        }}
      >
        {deleteError && (
          <div
            role="alert"
            style={{
              marginBottom: 12,
              padding: 10,
              borderRadius: 8,
              background: colors.surface,
              border: `1px solid ${colors.danger}`,
              color: colors.danger,
              fontSize: 11,
              lineHeight: 1.5,
            }}
          >
            {deleteError}
          </div>
        )}

        {/* LIST */}
        {viewMode === "LIST" && (
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                marginBottom: 14,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <h2
                  style={{
                    margin: 0,
                    fontSize: 18,
                    fontWeight: 800,
                    color: colors.primaryText,
                  }}
                >
                  My Notes
                </h2>

                <span
                  style={{
                    minWidth: 22,
                    height: 22,
                    padding: "0 6px",
                    borderRadius: 999,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: colors.accentSoft,
                    color: colors.accent,
                    fontSize: 11,
                    fontWeight: 800,
                  }}
                >
                  {currentNotes.length}
                </span>
              </div>

              <button
                type="button"
                onClick={() => openEditor(null)}
                style={{
                  border: "none",
                  borderRadius: 8,
                  padding: "8px 10px",
                  background: colors.accent,
                  color: theme === "dark" ? "#082f49" : "#ffffff",
                  fontSize: 11,
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                + New Note
              </button>
            </div>

            <section
              aria-label="Transcript"
              style={{
                marginBottom: 14,
                padding: 12,
                borderRadius: 10,
                background: colors.surface,
                border: `1px solid ${colors.border}`,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 10,
                }}
              >
                <h2
                  style={{
                    margin: 0,
                    fontSize: 14,
                    fontWeight: 800,
                    color: colors.primaryText,
                  }}
                >
                  Transcript
                </h2>
                <span
                  style={{
                    color:
                      currentTranscriptStatus === "READY"
                        ? colors.accent
                        : colors.muted,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {currentTranscriptStatus === "READY"
                    ? "Ready"
                    : currentTranscriptStatus === "FETCHING"
                      ? "Fetching..."
                      : currentTranscriptStatus === "FAILED"
                        ? "Failed"
                        : "Not available"}
                </span>
              </div>

              {currentTranscriptError && (
                <div
                  role="alert"
                  style={{
                    marginBottom: 10,
                    color: colors.danger,
                    fontSize: 11,
                    lineHeight: 1.5,
                  }}
                >
                  {currentTranscriptError}
                </div>
              )}

              <button
                type="button"
                onClick={() => void handleFetchTranscript()}
                disabled={isFetchingTranscript || currentTranscriptStatus === "READY"}
                style={{
                  width: "100%",
                  border: "none",
                  borderRadius: 8,
                  padding: "9px 12px",
                  background: colors.accent,
                  color: theme === "dark" ? "#082f49" : "#ffffff",
                  fontSize: 11,
                  fontWeight: 800,
                  cursor:
                    isFetchingTranscript || currentTranscriptStatus === "READY"
                      ? "default"
                      : "pointer",
                  opacity:
                    isFetchingTranscript || currentTranscriptStatus === "READY"
                      ? 0.65
                      : 1,
                }}
              >
                {currentTranscriptStatus === "READY"
                  ? "Transcript Ready"
                  : isFetchingTranscript
                    ? "Retrieving Transcript..."
                    : "Retrieve Transcript"}
              </button>
            </section>

            <button
              type="button"
              onClick={() => void handleAnalyzeVideo()}
              disabled={isAnalyzing || currentTranscriptStatus !== "READY"}
              style={{
                width: "100%",
                marginBottom: 14,
                border: "none",
                borderRadius: 8,
                padding: "10px 12px",
                background: colors.accent,
                color: theme === "dark" ? "#082f49" : "#ffffff",
                fontSize: 12,
                fontWeight: 800,
                cursor:
                  isAnalyzing || currentTranscriptStatus !== "READY"
                    ? "default"
                    : "pointer",
                opacity:
                  isAnalyzing || currentTranscriptStatus !== "READY"
                    ? 0.65
                    : 1,
              }}
            >
              {isAnalyzing ? "Analyzing..." : "Analyze Video"}
            </button>

            {currentAnalysisError && (
              <div
                role="alert"
                style={{
                  marginBottom: 14,
                  padding: 10,
                  borderRadius: 8,
                  background: colors.surface,
                  border: `1px solid ${colors.danger}`,
                  color: colors.danger,
                  fontSize: 11,
                  lineHeight: 1.5,
                }}
              >
                {currentAnalysisError}
              </div>
            )}

            {currentAnalysis && (
              <section
                aria-label="AI Video Analysis"
                style={{
                  marginBottom: 18,
                  padding: 12,
                  borderRadius: 10,
                  background: colors.surface,
                  border: `1px solid ${colors.border}`,
                }}
              >
                <h2
                  style={{
                    margin: "0 0 12px",
                    fontSize: 15,
                    fontWeight: 800,
                    color: colors.primaryText,
                  }}
                >
                  AI Video Analysis
                </h2>

                <AnalysisListSection
                  title="Summary"
                  colors={colors}
                >
                  <p
                    style={{
                      margin: 0,
                      color: colors.text,
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {currentAnalysis.summary}
                  </p>
                </AnalysisListSection>

                <AnalysisListSection title="Topics" colors={colors}>
                  <AnalysisTextList items={currentAnalysis.topics} colors={colors} />
                </AnalysisListSection>

                <AnalysisListSection title="Concepts" colors={colors}>
                  <AnalysisTextList
                    items={currentAnalysis.concepts}
                    colors={colors}
                  />
                </AnalysisListSection>

                <AnalysisListSection title="Key Points" colors={colors}>
                  {currentAnalysis.key_points.length === 0 ? (
                    <AnalysisEmptyValue colors={colors} />
                  ) : (
                    <ul style={analysisListStyle}>
                      {currentAnalysis.key_points.map((point, index) => (
                        <li
                          key={`${point.start}-${index}`}
                          style={analysisListItemStyle(colors)}
                        >
                          <span style={{ color: colors.accent, fontWeight: 700 }}>
                            {formatTimestamp(point.start)}
                          </span>
                          {" — "}
                          {point.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </AnalysisListSection>

                <AnalysisListSection title="Questions" colors={colors}>
                  <AnalysisTextList
                    items={currentAnalysis.questions}
                    colors={colors}
                  />
                </AnalysisListSection>
              </section>
            )}

            {contextStatus === "loading" ? (
              <div
                style={{
                  padding: "50px 15px",
                  textAlign: "center",
                  color: colors.muted,
                  fontSize: 12,
                }}
              >
                Loading notes for this video...
              </div>
            ) : contextStatus === "error" ? (
              <div
                role="alert"
                style={{
                  padding: "50px 15px",
                  textAlign: "center",
                  color: colors.danger,
                  fontSize: 12,
                }}
              >
                Could not load notes for this video.
              </div>
            ) : currentNotes.length === 0 ? (
              <div
                style={{
                  padding: "50px 15px",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontSize: 30,
                    marginBottom: 12,
                  }}
                >
                  📝
                </div>

                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 800,
                    color: colors.primaryText,
                    marginBottom: 6,
                  }}
                >
                  No notes yet
                </div>

                <div
                  style={{
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: colors.muted,
                  }}
                >
                  Create your first note for this video.
                </div>
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {currentNotes.map((note) => (
                  <div
                    key={note.id}
                    style={{
                      display: "flex",
                      alignItems: "stretch",
                      gap: 6,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => openReader(note)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        textAlign: "left",
                        padding: 13,
                        border: `1px solid ${colors.border}`,
                        borderRadius: 10,
                        background: colors.surface,
                        color: colors.text,
                        cursor: "pointer",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          justifyContent: "space-between",
                          gap: 10,
                        }}
                      >
                        <div
                          style={{
                            minWidth: 0,
                            flex: 1,
                          }}
                        >
                          <div
                            style={{
                              fontSize: 14,
                              fontWeight: 800,
                              lineHeight: 1.35,
                              color: colors.primaryText,
                              marginBottom: 7,
                            }}
                          >
                            {note.title || "Untitled note"}
                          </div>

                          <div
                            style={{
                              fontSize: 12,
                              lineHeight: 1.55,
                              color: colors.muted,
                              display: "-webkit-box",
                              WebkitLineClamp: 3,
                              WebkitBoxOrient: "vertical",
                              overflow: "hidden",
                              whiteSpace: "pre-wrap",
                            }}
                          >
                            {note.content ||
                              documentToPlainText(normalizeDocument(note)) ||
                              "Empty note"}
                          </div>
                        </div>

                        {note.timestamp_seconds !== null &&
                          note.timestamp_seconds !== undefined && (
                            <span
                              onClick={(event) => {
                                event.stopPropagation();

                                jumpToTimestamp(note.timestamp_seconds!);
                              }}
                              style={{
                                flexShrink: 0,
                                padding: "4px 7px",
                                borderRadius: 6,
                                background: colors.accentSoft,
                                color: colors.accent,
                                fontSize: 10,
                                fontWeight: 800,
                                cursor: "pointer",
                              }}
                            >
                              {formatTimestamp(note.timestamp_seconds)}
                            </span>
                          )}
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleDelete(note)}
                      disabled={deletePendingNoteId !== null}
                      title={`Delete ${note.title || "note"}`}
                      aria-label={`Delete ${note.title || "note"}`}
                      style={{
                        ...iconButtonStyle,
                        alignSelf: "center",
                        flexShrink: 0,
                        color: colors.danger,
                        borderColor: colors.border,
                        opacity: deletePendingNoteId !== null ? 0.55 : 1,
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* READER */}
        {viewMode === "READER" && selectedNote && (
          <NoteReader
            note={selectedNote}
            colors={colors}
            onBack={returnToList}
            onEdit={() => openEditor(selectedNote)}
            onDelete={() => void handleDelete(selectedNote)}
            isDeleting={deletePendingNoteId === selectedNote.id}
            onGenerateExplanation={() => {
              setExplanationState("loading");

              window.setTimeout(() => {
                setExplanationState("unavailable");
              }, 500);
            }}
            explanationState={explanationState}
          />
        )}

        {/* WRITER */}
        {viewMode === "WRITER" && (
          <NoteWriter
            note={editingNote}
            videoId={videoId}
            colors={colors}
            onBack={() => {
              if (editingNote) {
                setSelectedNote(editingNote);
                setViewMode("READER");
              } else {
                returnToList();
              }
            }}
            onSaved={handleSaved}
            onDelete={() => {
              if (editingNote) {
                void handleDelete(editingNote);
              }
            }}
            isDeleting={
              editingNote !== null &&
              deletePendingNoteId === editingNote.id
            }
          />
        )}

        {/* AI */}
        {viewMode === "AI" && selectedNote && (
          <AIWorkspace colors={colors} videoTitle={videoTitle} />
        )}
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

const topIconButton: CSSProperties = {
  width: 29,
  height: 29,
  padding: 0,
  borderRadius: 7,
  border: "1px solid",
  background: "transparent",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 15,
  cursor: "pointer",
};

const headerActionButton: CSSProperties = {
  border: "1px solid",
  borderRadius: 8,
  padding: "7px 10px",
  fontSize: 11,
  fontWeight: 800,
  cursor: "pointer",
};

const iconButtonStyle: CSSProperties = {
  width: 27,
  height: 27,
  padding: 0,
  border: "1px solid",
  borderRadius: 7,
  background: "transparent",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 15,
  cursor: "pointer",
};

const editorControlStyle: CSSProperties = {
  border: "1px solid",
  borderRadius: 7,
  padding: "5px 7px",
  fontSize: 10,
  outline: "none",
};

const editorInputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid",
  borderRadius: 9,
  padding: "10px 11px",
  outline: "none",
};

const editorTextareaStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid",
  borderRadius: 9,
  padding: "10px 11px",
  resize: "vertical",
  outline: "none",
  lineHeight: 1.55,
};

const smallToolButton: CSSProperties = {
  border: "1px solid",
  borderRadius: 6,
  background: "transparent",
  padding: "4px 7px",
  fontSize: 9,
  fontWeight: 700,
  cursor: "pointer",
};
