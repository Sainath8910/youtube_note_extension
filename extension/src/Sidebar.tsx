import {
  useEffect,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  BadgeCheck,
  BookOpen,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Brain,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FileText,
  GraduationCap,
  GripVertical,
  Lightbulb,
  ListChecks,
  Minus,
  Moon,
  Play,
  Plus,
  Route,
  Save,
  Sun,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { getActiveYouTubeVideoId } from "./youtubeMetadata";
import {
  isPreviousContextData,
  sendPreviousContext,
  sendAskRAG,
  type AskRAGScope,
  type PreviousContextData,
  type RAGAnswer,
  type RAGSource,
} from "./ragApi";
import {
  createEmptyDocument,
  documentToPlainText,
  getListItems,
  normalizeListContent,
  normalizeDocument,
  normalizeFolderPath,
  type NoteBlock,
  type NoteBlockType,
  type NoteDocument,
  type VideoNote,
} from "./noteDocument";
import { CopyButton } from "./CopyButton";
import {
  captureCurrentVideoScreenshot,
  isCurrentVideoPlayerAvailable,
} from "./videoScreenshot";
export type {
  NoteBlock,
  NoteBlockType,
  NoteDocument,
  VideoNote,
} from "./noteDocument";

export interface VideoAnalysis {
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
  analysisStatus: "NOT_STARTED" | "ANALYZING" | "READY" | "FAILED" | null;
  persistedAnalysis: VideoAnalysis | null;
  transcriptStatus: TranscriptStatus | null;
}

type PreviousContextLoadState =
  | { videoId: string; status: "loading" }
  | { videoId: string; status: "error" }
  | {
      videoId: string;
      status: "loaded";
      data: PreviousContextData | null;
    };

type ViewMode = "LIST" | "READER" | "WRITER" | "AI";

type Theme = "dark" | "light";

type PrimaryWorkspace = "NOTES" | "ANALYSIS";

type NoteNavigationTab = "READ" | "WRITE" | "AI";

export type TranscriptStatus =
  | "NOT_STARTED"
  | "FETCHING"
  | "READY"
  | "FAILED";

interface Position {
  x: number;
  y: number;
}

export interface ThemeColors {
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

function formatTimestamp(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds)
    ? Math.max(0, Math.round(seconds))
    : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;
  const formattedMinutes = minutes.toString().padStart(2, "0");
  const formattedSeconds = remainingSeconds.toString().padStart(2, "0");

  return hours > 0
    ? `${hours.toString().padStart(2, "0")}:${formattedMinutes}:${formattedSeconds}`
    : `${formattedMinutes}:${formattedSeconds}`;
}

function formatUpdatedAt(updatedAt?: string): string | null {
  if (!updatedAt) {
    return null;
  }

  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleDateString()
    : null;
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

function isRAGSource(value: unknown): value is RAGSource {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const source = value as Record<string, unknown>;
  const nullableInteger = (field: unknown) =>
    field === null ||
    (typeof field === "number" && Number.isInteger(field));
  return (
    typeof source.chunk_id === "number" &&
    Number.isInteger(source.chunk_id) &&
    typeof source.content === "string" &&
    typeof source.distance === "number" &&
    Number.isFinite(source.distance) &&
    nullableInteger(source.note_id) &&
    nullableInteger(source.video_id) &&
    nullableInteger(source.folder_id) &&
    (source.source_block_id === null ||
      typeof source.source_block_id === "string") &&
    typeof source.chunk_index === "number" &&
    Number.isInteger(source.chunk_index) &&
    typeof source.metadata === "object" &&
    source.metadata !== null &&
    !Array.isArray(source.metadata)
  );
}

function isRAGAnswer(value: unknown): value is RAGAnswer {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const answer = value as Record<string, unknown>;
  return (
    typeof answer.answer === "string" &&
    Array.isArray(answer.sources) &&
    answer.sources.every(isRAGSource)
  );
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

function AnalysisCard({
  id,
  title,
  icon,
  colors,
  expanded,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  colors: ThemeColors;
  expanded: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        padding: 11,
        borderRadius: 10,
        background: colors.surface,
        border: `1px solid ${colors.border}`,
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onToggle(id)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: 0,
          border: "none",
          background: "transparent",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            color: colors.accent,
          }}
        >
          {icon}
        </span>
        <h3
          style={{
            margin: 0,
            color: colors.primaryText,
            fontSize: 12,
            fontWeight: 800,
            flex: 1,
          }}
        >
          {title}
        </h3>
        <span
          style={{
            display: "inline-flex",
            color: colors.muted,
          }}
        >
          {expanded ? (
            <ChevronDown size={15} aria-hidden="true" />
          ) : (
            <ChevronRight size={15} aria-hidden="true" />
          )}
        </span>
      </button>
      {expanded && <div style={{ marginTop: 8 }}>{children}</div>}
    </section>
  );
}

function AnalysisTextList({ items, colors }: { items: string[]; colors: ThemeColors }) {
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

function getNonEmptyStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function getDetailedNotesSections(
  value: unknown,
): Array<{ heading: string; content: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (section): section is { heading: string; content: string } =>
      typeof section === "object" &&
      section !== null &&
      "heading" in section &&
      typeof section.heading === "string" &&
      section.heading.trim().length > 0 &&
      "content" in section &&
      typeof section.content === "string" &&
      section.content.trim().length > 0,
  );
}

function analysisSubsectionTitleStyle(colors: ThemeColors): CSSProperties {
  return {
    margin: "0 0 4px",
    color: colors.primaryText,
    fontSize: 11,
    fontWeight: 750,
  };
}

function AnalysisTimestampList({
  items,
  colors,
}: {
  items: Array<{ text: string; start: number }>;
  colors: ThemeColors;
}) {
  const [hoveredItem, setHoveredItem] = useState<number | null>(null);
  const [focusedItem, setFocusedItem] = useState<number | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {items.map((item, index) => {
        const isHighlighted = hoveredItem === index || focusedItem === index;

        return (
          <button
            key={`${item.start}-${index}`}
            type="button"
            onClick={() => jumpToTimestamp(item.start)}
            onMouseEnter={() => setHoveredItem(index)}
            onMouseLeave={() => setHoveredItem(null)}
            onFocus={() => setFocusedItem(index)}
            onBlur={() => setFocusedItem(null)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              padding: "7px 8px",
              border: "none",
              borderRadius: 7,
              background: isHighlighted ? colors.accentSoft : "transparent",
              color: colors.text,
              textAlign: "left",
              cursor: "pointer",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            <Play
              size={13}
              aria-hidden="true"
              style={{
                flexShrink: 0,
                marginTop: 2,
                color: colors.accent,
              }}
            />
            <span
              style={{
                flexShrink: 0,
                color: colors.accent,
                fontWeight: 750,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {formatTimestamp(item.start)}
            </span>
            <span>{item.text}</span>
          </button>
        );
      })}
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

function getResourceDomain(value: string): string {
  if (!value.trim()) return "";

  try {
    const parsed = new URL(value);
    return parsed.hostname || "";
  } catch {
    return value.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] || value;
  }
}

function getSafeResourceUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function getResourceTitle(value: string): string {
  const domain = getResourceDomain(value).toLocaleLowerCase();
  if (domain === "youtube.com" || domain.endsWith(".youtube.com") || domain === "youtu.be") {
    return "YouTube video";
  }
  if (domain === "drive.google.com" || domain.endsWith(".drive.google.com")) {
    return "Google Drive resource";
  }
  if (domain === "github.com" || domain.endsWith(".github.com")) {
    return "GitHub resource";
  }
  return getResourceDomain(value) || "Resource";
}

/* -------------------------------------------------------------------------- */
/* Block Editor                                                               */
/* -------------------------------------------------------------------------- */

interface BlockEditorProps {
  noteDocument: NoteDocument;
  colors: ThemeColors;
  onChange: (document: NoteDocument) => void;
  onCaptureScreenshot?: () => Promise<NoteBlock>;
  renderBlockAssistance?: (block: NoteBlock) => ReactNode;
  enableTimestampJump?: boolean;
  timestampContent?: () => string;
}

export function BlockEditor({
  noteDocument,
  colors,
  onChange,
  onCaptureScreenshot,
  renderBlockAssistance,
  enableTimestampJump = true,
  timestampContent = () => formatTimestamp(getCurrentVideoTime()),
}: BlockEditorProps) {
  const [draggedBlockId, setDraggedBlockId] = useState<string | null>(null);

  const [dragOverBlockId, setDragOverBlockId] = useState<string | null>(null);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [screenshotCaptureMessage, setScreenshotCaptureMessage] = useState<{
    text: string;
    isError: boolean;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const imageInsertAfterRef = useRef<string | undefined>(undefined);

  const replaceImageBlockIdRef = useRef<string | undefined>(undefined);

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
      blocks,
    });
  }

  function insertBlock(newBlock: NoteBlock, afterId?: string) {
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

  function addBlock(type: NoteBlockType, afterId?: string, content = "") {
    insertBlock(
      {
        id: createId(),
        type,
        content,
      },
      afterId,
    );
  }

  async function captureScreenshot(afterId?: string) {
    if (!onCaptureScreenshot || isCapturingScreenshot) return;
    setIsCapturingScreenshot(true);
    setScreenshotCaptureMessage({ text: "Capturing screenshot...", isError: false });
    try {
      const block = await onCaptureScreenshot();
      if (
        block.type !== "screenshot" ||
        typeof block.metadata?.image !== "string" ||
        !block.metadata.image.startsWith("data:image/jpeg;base64,")
      ) {
        throw new Error("The captured screenshot was not a valid image.");
      }
      insertBlock(block, afterId);
      setScreenshotCaptureMessage({
        text: "Screenshot captured.",
        isError: false,
      });
      window.setTimeout(() => setScreenshotCaptureMessage(null), 2500);
    } catch (captureError) {
      setScreenshotCaptureMessage({
        text:
          captureError instanceof Error
            ? captureError.message
            : "Screenshot capture failed. Check that the YouTube player is visible and retry.",
        isError: true,
      });
    } finally {
      setIsCapturingScreenshot(false);
    }
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

  function startImageUpload(afterId?: string, replaceBlockId?: string) {
    imageInsertAfterRef.current = afterId;
    replaceImageBlockIdRef.current = replaceBlockId;

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

      const replaceBlockId = replaceImageBlockIdRef.current;
      if (replaceBlockId) {
        updateBlock(replaceBlockId, {
          content: reader.result,
          metadata: {
            ...noteDocument.blocks.find((block) => block.id === replaceBlockId)
              ?.metadata,
            source: "upload",
            url: reader.result,
            alt: file.name,
          },
        });
      } else {
        addImageBlock(
          reader.result,
          "upload",
          imageInsertAfterRef.current,
          file.name,
        );
      }

      imageInsertAfterRef.current = undefined;
      replaceImageBlockIdRef.current = undefined;
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
                    display: "inline-flex",
                    userSelect: "none",
                  }}
                >
                  <GripVertical size={16} aria-hidden="true" />
                </span>

                <select
                  value={block.type}
                  aria-label={`Block type for block ${index + 1}`}
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

                  <option value="bullet_list">Bulleted Points</option>

                  <option value="numbered_list">Numbered Points</option>

                  <option value="code">Code</option>

                  <option value="command">Command</option>

                  <option value="url">URL / Resource</option>

                  <option value="equation">Equation</option>

                  <option value="timestamp">Timestamp</option>

                  <option value="image">Image</option>
                  {block.type === "screenshot" && (
                    <option value="screenshot">Video Screenshot</option>
                  )}
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
                  aria-label={`Move block ${index + 1} up`}
                  style={{
                    ...iconButtonStyle,
                    color: index === 0 ? colors.border : colors.muted,
                    borderColor: colors.border,
                  }}
                >
                  <ArrowUp size={14} aria-hidden="true" />
                </button>

                <button
                  type="button"
                  disabled={index === noteDocument.blocks.length - 1}
                  onClick={() => moveBlock(block.id, "down")}
                  title="Move block down"
                  aria-label={`Move block ${index + 1} down`}
                  style={{
                    ...iconButtonStyle,
                    color:
                      index === noteDocument.blocks.length - 1
                        ? colors.border
                        : colors.muted,
                    borderColor: colors.border,
                  }}
                >
                  <ArrowDown size={14} aria-hidden="true" />
                </button>

                <button
                  type="button"
                  onClick={() => removeBlock(block.id)}
                  title="Delete block"
                  aria-label={`Delete block ${index + 1}`}
                  style={{
                    ...iconButtonStyle,
                    color: colors.muted,
                    borderColor: colors.border,
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            </div>

            {/* Block content */}
            {block.type === "timestamp" ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 7,
                }}
              >
                <input
                  value={block.content}
                  onChange={(event) =>
                    updateBlock(block.id, { content: event.target.value })
                  }
                  aria-label={`Timestamp for block ${index + 1}`}
                  placeholder="Timestamp (for example, 1:25)"
                  style={{
                    ...editorInputStyle,
                    color: colors.primaryText,
                    background: colors.input,
                    borderColor: colors.border,
                  }}
                />
                {enableTimestampJump && (
                  <button
                    type="button"
                    disabled={parseTimestamp(block.content) === null}
                    onClick={() => {
                      const seconds = parseTimestamp(block.content);
                      if (seconds !== null) jumpToTimestamp(seconds);
                    }}
                    aria-label={`Jump to timestamp ${block.content || "not set"}`}
                    style={{
                      alignSelf: "flex-start",
                      padding: "7px 10px",
                      borderRadius: 8,
                      border: `1px solid ${colors.border}`,
                      background: colors.accentSoft,
                      color: colors.accent,
                      cursor: "pointer",
                      fontWeight: 700,
                    }}
                  >
                    <Play size={13} aria-hidden="true" />
                    Jump to timestamp
                  </button>
                )}
              </div>
            ) : block.type === "heading" ? (
              <input
                value={block.content}
                aria-label={`Heading text for block ${index + 1}`}
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

                {block.metadata?.source !== "upload" && (
                  <input
                    value={block.content}
                    onChange={(event) =>
                      updateBlock(block.id, {
                        content: event.target.value,
                        metadata: {
                          ...block.metadata,
                          source: "url",
                          url: event.target.value,
                        },
                      })
                    }
                    aria-label={`Image URL for block ${index + 1}`}
                    placeholder="Image URL"
                    style={{
                      ...editorInputStyle,
                      color: colors.primaryText,
                      background: colors.input,
                      borderColor: colors.border,
                      fontSize: 11,
                    }}
                  />
                )}

                <input
                  value={block.metadata?.alt || ""}
                  aria-label={`Image description for block ${index + 1}`}
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
                {block.metadata?.source === "upload" && (
                  <button
                    type="button"
                    onClick={() => startImageUpload(undefined, block.id)}
                    aria-label={`Replace image in block ${index + 1}`}
                    style={{
                      ...smallToolButton,
                      color: colors.muted,
                      borderColor: colors.border,
                    }}
                  >
                    Replace uploaded image
                  </button>
                )}
              </div>
            ) : block.type === "screenshot" ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {block.metadata?.image ? (
                  <img
                    src={block.metadata.image}
                    alt="YouTube video screenshot"
                    style={{
                      width: "100%",
                      maxWidth: 500,
                      maxHeight: 300,
                      objectFit: "contain",
                      borderRadius: 8,
                      background: colors.input,
                      border: `1px solid ${colors.border}`,
                    }}
                  />
                ) : (
                  <div style={{ color: colors.muted, fontSize: 11 }}>
                    Screenshot unavailable
                  </div>
                )}
                {typeof block.metadata?.timestamp_seconds === "number" && (
                  <span style={{ color: colors.muted, fontSize: 11 }}>
                    Captured at{" "}
                    {formatTimestamp(block.metadata.timestamp_seconds)}
                  </span>
                )}
              </div>
            ) : block.type === "url" ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <input
                  value={block.content}
                  aria-label={`URL for block ${index + 1}`}
                  onChange={(event) =>
                    updateBlock(block.id, {
                      content: event.target.value,
                      metadata: {
                        ...block.metadata,
                        url: event.target.value,
                        domain: getResourceDomain(event.target.value),
                      },
                    })
                  }
                  placeholder="https://example.com"
                  style={{
                    ...editorInputStyle,
                    color: colors.primaryText,
                    background: colors.input,
                    borderColor: colors.border,
                    fontSize: 12,
                  }}
                />
                <input
                  value={block.metadata?.title || ""}
                  aria-label={`Resource title for block ${index + 1}`}
                  onChange={(event) =>
                    updateBlock(block.id, {
                      metadata: {
                        ...block.metadata,
                        title: event.target.value,
                      },
                    })
                  }
                  placeholder="Resource title (optional)"
                  style={{
                    ...editorInputStyle,
                    color: colors.primaryText,
                    background: colors.input,
                    borderColor: colors.border,
                    fontSize: 11,
                  }}
                />
                <textarea
                  value={block.metadata?.description || ""}
                  aria-label={`Resource description for block ${index + 1}`}
                  onChange={(event) =>
                    updateBlock(block.id, {
                      metadata: {
                        ...block.metadata,
                        description: event.target.value,
                      },
                    })
                  }
                  placeholder="Short description (optional)"
                  rows={2}
                  style={{
                    ...editorTextareaStyle,
                    color: colors.primaryText,
                    background: colors.input,
                    borderColor: colors.border,
                    fontSize: 12,
                  }}
                />
              </div>
            ) : block.type === "code" || block.type === "command" ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <textarea
                  value={block.content}
                  aria-label={`${block.type === "code" ? "Code" : "Command"} content for block ${index + 1}`}
                  onChange={(event) =>
                    updateBlock(block.id, {
                      content: event.target.value,
                    })
                  }
                  placeholder={
                    block.type === "code"
                      ? "Paste or write source code..."
                      : "Enter a terminal command..."
                  }
                  rows={8}
                  style={{
                    ...editorTextareaStyle,
                    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
                    fontSize: 12,
                    color: colors.primaryText,
                    background: colors.input,
                    borderColor: colors.border,
                    whiteSpace: "pre",
                  }}
                />
                <input
                  value={block.metadata?.[block.type === "code" ? "language" : "shell"] || ""}
                  aria-label={`${block.type === "code" ? "Language" : "Shell"} for block ${index + 1}`}
                  onChange={(event) =>
                    updateBlock(block.id, {
                      metadata: {
                        ...block.metadata,
                        ...(block.type === "code"
                          ? { language: event.target.value }
                          : { shell: event.target.value }),
                      },
                    })
                  }
                  placeholder={
                    block.type === "code" ? "Language (for example, python)" : "Shell (for example, bash)"
                  }
                  style={{
                    ...editorInputStyle,
                    color: colors.primaryText,
                    background: colors.input,
                    borderColor: colors.border,
                    fontSize: 11,
                  }}
                />
              </div>
            ) : block.type === "bullet_list" || block.type === "numbered_list" ? (
              <textarea
                value={normalizeListContent(block.content)}
                aria-label={`${block.type === "bullet_list" ? "Bulleted" : "Numbered"} list for block ${index + 1}`}
                onChange={(event) =>
                  updateBlock(block.id, {
                    content: event.target.value,
                  })
                }
                placeholder={
                  block.type === "bullet_list"
                    ? "One item per line"
                    : "One item per line"
                }
                rows={5}
                style={{
                  ...editorTextareaStyle,
                  color: colors.primaryText,
                  background: colors.input,
                  borderColor: colors.border,
                }}
              />
            ) : (
              <textarea
                value={block.content}
                aria-label={`${block.type === "equation" ? "Equation" : "Paragraph"} content for block ${index + 1}`}
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
                onClick={() => addBlock("bullet_list", block.id)}
                style={{
                  ...smallToolButton,
                  color: colors.muted,
                  borderColor: colors.border,
                }}
              >
                + Bullets
              </button>

              <button
                type="button"
                onClick={() => addBlock("numbered_list", block.id)}
                style={{
                  ...smallToolButton,
                  color: colors.muted,
                  borderColor: colors.border,
                }}
              >
                + Numbers
              </button>

              <button
                type="button"
                onClick={() => addBlock("code", block.id)}
                style={{
                  ...smallToolButton,
                  color: colors.muted,
                  borderColor: colors.border,
                }}
              >
                + Code
              </button>

              <button
                type="button"
                onClick={() => addBlock("command", block.id)}
                style={{
                  ...smallToolButton,
                  color: colors.muted,
                  borderColor: colors.border,
                }}
              >
                + Command
              </button>

              <button
                type="button"
                onClick={() => addBlock("url", block.id)}
                style={{
                  ...smallToolButton,
                  color: colors.muted,
                  borderColor: colors.border,
                }}
              >
                + URL
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
                  addBlock("timestamp", block.id, timestampContent())
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
                <Plus size={12} aria-hidden="true" />
                Image
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
                <Plus size={12} aria-hidden="true" />
                Image URL
              </button>

              {onCaptureScreenshot && (
                <button
                  type="button"
                  disabled={isCapturingScreenshot}
                  onClick={() => void captureScreenshot(block.id)}
                  style={{
                    ...smallToolButton,
                    color: colors.accent,
                    borderColor: colors.border,
                    opacity: isCapturingScreenshot ? 0.6 : 1,
                  }}
                >
                  <Camera size={12} aria-hidden="true" />
                  {isCapturingScreenshot
                    ? "Capturing..."
                    : "Capture Screenshot"}
                </button>
              )}
            </div>
            {renderBlockAssistance?.(block)}
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
        <Plus size={12} aria-hidden="true" />
        Add block
      </button>
      {screenshotCaptureMessage && (
        <div
          role={screenshotCaptureMessage.isError ? "alert" : "status"}
          style={{
            color: screenshotCaptureMessage.isError
              ? colors.danger
              : colors.accent,
            fontSize: 11,
            lineHeight: 1.5,
          }}
        >
          {screenshotCaptureMessage.text}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Reader                                                                     */
/* -------------------------------------------------------------------------- */

interface NoteReaderProps {
  note: VideoNote;
  colors: ThemeColors;
  showTitle?: boolean;
  showFolderPath?: boolean;
  enableTimestampJump?: boolean;
  onTimestampClick?: (seconds: number) => void;
}

export function NoteReader({
  note,
  colors,
  showTitle = true,
  showFolderPath = false,
  enableTimestampJump = true,
  onTimestampClick,
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
      {showTitle && (
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
      )}
      {showFolderPath && <FolderPathMetadata note={note} colors={colors} />}

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
                disabled={
                  seconds === null ||
                  (!enableTimestampJump && !onTimestampClick)
                }
                onClick={() => {
                  if (seconds === null) return;
                  if (onTimestampClick) {
                    onTimestampClick(seconds);
                  } else if (enableTimestampJump) {
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
                  cursor:
                    seconds !== null &&
                    (enableTimestampJump || onTimestampClick)
                      ? "pointer"
                      : "default",
                  fontWeight: 700,
                }}
              >
                <Play size={13} aria-hidden="true" />
                {block.content}
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

          if (block.type === "screenshot") {
            const screenshotImage =
              block.metadata?.image || block.content || "";
            const timestampSeconds =
              typeof block.metadata?.timestamp_seconds === "number" &&
              Number.isFinite(block.metadata.timestamp_seconds) &&
              block.metadata.timestamp_seconds >= 0
                ? block.metadata.timestamp_seconds
                : null;

            return (
              <figure
                key={block.id}
                style={{
                  margin: 0,
                  maxWidth: "100%",
                }}
              >
                {screenshotImage.startsWith("data:image/") ? (
                  <img
                    src={screenshotImage}
                    alt={
                      timestampSeconds === null
                        ? "YouTube video screenshot"
                        : `YouTube video screenshot at ${formatTimestamp(timestampSeconds)}`
                    }
                    style={{
                      display: "block",
                      width: "100%",
                      maxWidth: 720,
                      maxHeight: 420,
                      objectFit: "contain",
                      borderRadius: 10,
                      background: colors.surface,
                      border: `1px solid ${colors.border}`,
                    }}
                  />
                ) : (
                  <div
                    role="img"
                    aria-label="Screenshot unavailable"
                    style={{
                      padding: 14,
                      borderRadius: 10,
                      border: `1px solid ${colors.border}`,
                      background: colors.surface,
                      color: colors.muted,
                      fontSize: 12,
                    }}
                  >
                    Screenshot unavailable
                  </div>
                )}
                {timestampSeconds !== null && (
                  <figcaption
                    style={{
                      marginTop: 6,
                      color: colors.muted,
                      fontSize: 11,
                    }}
                  >
                    {formatTimestamp(timestampSeconds)}
                    {(onTimestampClick || enableTimestampJump) && (
                      <>
                        {" · "}
                        <button
                          type="button"
                          onClick={() => {
                            if (onTimestampClick) {
                              onTimestampClick(timestampSeconds);
                            } else {
                              jumpToTimestamp(timestampSeconds);
                            }
                          }}
                          style={{
                            border: 0,
                            padding: 0,
                            background: "transparent",
                            color: colors.accent,
                            cursor: "pointer",
                            font: "inherit",
                            fontWeight: 700,
                          }}
                        >
                          Open at {formatTimestamp(timestampSeconds)}
                        </button>
                      </>
                    )}
                  </figcaption>
                )}
              </figure>
            );
          }

          if (block.type === "url") {
            const resourceUrl = (block.content || block.metadata?.url || "").trim();
            const safeResourceUrl = getSafeResourceUrl(resourceUrl);
            const title = block.metadata?.title || getResourceTitle(resourceUrl);
            const description = block.metadata?.description || "";
            const domain = block.metadata?.domain || getResourceDomain(resourceUrl) || "";

            return (
              <a
                key={block.id}
                href={safeResourceUrl || undefined}
                target="_blank"
                rel="noreferrer noopener"
                style={{
                  display: "block",
                  textDecoration: "none",
                  border: `1px solid ${colors.border}`,
                  borderRadius: 10,
                  background: colors.surface,
                  padding: 12,
                  color: colors.text,
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 8,
                      background: colors.accentSoft,
                      color: colors.accent,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 700,
                    }}
                  >
                    🔗
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 700, color: colors.primaryText, marginBottom: 2 }}>
                      {title || "Resource"}
                    </div>
                    {domain ? (
                      <div style={{ fontSize: 11, color: colors.muted, marginBottom: 4 }}>{domain}</div>
                    ) : null}
                    {description ? (
                      <div style={{ fontSize: 12, color: colors.text, lineHeight: 1.5 }}>{description}</div>
                    ) : null}
                    <div style={{ marginTop: 6, fontSize: 11, color: colors.accent, wordBreak: "break-word" }}>
                      {resourceUrl || "No URL"}
                    </div>
                  </div>
                </div>
              </a>
            );
          }

          if (block.type === "code" || block.type === "command") {
            const value = block.content || "";
            const languageLabel =
              block.type === "code"
                ? block.metadata?.language || "code"
                : block.metadata?.shell || "command";

            return (
              <div
                key={block.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  borderRadius: 10,
                  border: `1px solid ${colors.border}`,
                  background: colors.surface,
                  padding: 10,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 11, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>
                    {block.type === "code" ? "Code" : "Command"}
                    {languageLabel ? ` · ${languageLabel}` : ""}
                  </span>
                  <CopyButton value={value} colors={colors} label="Copy" />
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: 10,
                    borderRadius: 8,
                    background: colors.input,
                    color: colors.text,
                    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
                    fontSize: 12,
                    lineHeight: 1.55,
                    overflowX: "auto",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {value || "Empty content"}
                </pre>
              </div>
            );
          }

          if (block.type === "bullet_list" || block.type === "numbered_list") {
            const items = getListItems(block.content);
            const Element = block.type === "bullet_list" ? "ul" : "ol";

            return (
              <Element
                key={block.id}
                style={{
                  margin: 0,
                  paddingLeft: 20,
                  color: colors.text,
                  lineHeight: 1.7,
                }}
              >
                {items.length > 0 ? (
                  items.map((item, itemIndex) => (
                    <li key={`${block.id}-${itemIndex}`}>{item}</li>
                  ))
                ) : (
                  <li>Empty list</li>
                )}
              </Element>
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

    </div>
  );
}

function FolderPathMetadata({
  note,
  colors,
  compact = false,
}: {
  note: VideoNote;
  colors: ThemeColors;
  compact?: boolean;
}) {
  const folderPath = normalizeFolderPath(note.folder_path);
  const label =
    folderPath.length > 0
      ? folderPath.map((folder) => folder.name).join(" / ")
      : "No Folder";

  return (
    <div
      title={label}
      aria-label={`Folder path: ${label}`}
      style={{
        minWidth: 0,
        maxWidth: "100%",
        overflow: "hidden",
        margin: compact ? "7px 0 0" : "-10px 0 18px",
        color: colors.muted,
        fontSize: 10,
        lineHeight: 1.4,
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {label}
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
  onSaved: (note: VideoNote) => void;
}

function NoteWriter({
  note,
  videoId,
  colors,
  onSaved,
}: NoteWriterProps) {
  const [title, setTitle] = useState(note?.title ?? "");

  const [noteDocument, setNoteDocument] = useState<NoteDocument>(() =>
    note ? normalizeDocument(note) : createEmptyDocument(),
  );

  const [isSaving, setIsSaving] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const screenshotCaptureEligible =
    note === null || (note.note_type === "VIDEO" && note.video != null);
  const subscribeToScreenshotAvailability = useCallback(
    (onStoreChange: () => void) => {
      if (!screenshotCaptureEligible) return () => {};
      const interval = window.setInterval(onStoreChange, 500);
      return () => window.clearInterval(interval);
    },
    [screenshotCaptureEligible],
  );
  const getScreenshotAvailability = useCallback(
    () =>
      screenshotCaptureEligible && isCurrentVideoPlayerAvailable(videoId),
    [screenshotCaptureEligible, videoId],
  );
  const canCaptureScreenshot = useSyncExternalStore(
    subscribeToScreenshotAvailability,
    getScreenshotAvailability,
    () => false,
  );

  async function captureScreenshotBlock(): Promise<NoteBlock> {
    if (getActiveYouTubeVideoId() !== videoId) {
      throw new Error("The active YouTube video changed. Try capturing again.");
    }
    const captured = await captureCurrentVideoScreenshot(videoId);
    return {
      id: createId(),
      type: "screenshot",
      content: "",
      metadata: {
        source: "youtube",
        timestamp_seconds: captured.timestampSeconds,
        image: captured.image,
      },
    };
  }

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
        content:
          block.type === "bullet_list" ||
          block.type === "numbered_list"
            ? normalizeListContent(block.content)
            : block.type === "image" ||
          block.type === "code" ||
          block.type === "command"
            ? block.content
            : block.content.trim(),
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
          justifyContent: "flex-end",
          marginBottom: 18,
        }}
      >
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
          {isSaving ? "Saving…" : <><Save size={14} aria-hidden="true" /> Save</>}
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
        onCaptureScreenshot={canCaptureScreenshot ? captureScreenshotBlock : undefined}
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
        Drag the handle to rearrange blocks. You can also use the move buttons.
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
  videoId: string;
  videoTitle: string;
  videoDatabaseId: number | null;
  notes: VideoNote[];
}

function AIWorkspace({
  colors,
  videoId,
  videoTitle,
  videoDatabaseId,
  notes,
}: AIWorkspaceProps) {
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<AskRAGScope>("CURRENT_VIDEO");
  const [answer, setAnswer] = useState<RAGAnswer | null>(null);
  const [answeredScope, setAnsweredScope] = useState<AskRAGScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const requestInProgress = useRef(false);
  const requestVersion = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestVersion.current += 1;
    };
  }, []);

  async function handleAsk() {
    if (requestInProgress.current) {
      return;
    }

    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) {
      setError("Please enter a question.");
      return;
    }

    requestInProgress.current = true;
    const currentRequestVersion = ++requestVersion.current;
    setAnswer(null);
    setAnsweredScope(null);
    setError(null);
    setIsLoading(true);

    try {
      const response = await sendAskRAG(trimmedQuestion, scope, videoId);
      if (
        !mounted.current ||
        currentRequestVersion !== requestVersion.current ||
        getActiveYouTubeVideoId() !== videoId
      ) {
        return;
      }

      if (!response.success) {
        setError(
          response.status === 400
            ? "Please check your question and try again."
            : response.status === 502
              ? "The AI service could not generate an answer. Please try again."
              : "The AI service is temporarily unavailable. Please try again.",
        );
        return;
      }

      if (!isRAGAnswer(response.data)) {
        setError("The AI service returned an unexpected response.");
        return;
      }

      setAnswer(response.data);
      setAnsweredScope(scope);
    } catch {
      if (
        mounted.current &&
        currentRequestVersion === requestVersion.current &&
        getActiveYouTubeVideoId() === videoId
      ) {
        setError("Could not reach the AI service. Please try again.");
      }
    } finally {
      requestInProgress.current = false;
      if (
        mounted.current &&
        currentRequestVersion === requestVersion.current &&
        getActiveYouTubeVideoId() === videoId
      ) {
        setIsLoading(false);
      }
    }
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
          Ask about knowledge from the selected scope.
        </div>
      </div>

      <div
        role="group"
        aria-label="Knowledge scope"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 5,
          padding: 4,
          border: `1px solid ${colors.border}`,
          borderRadius: 10,
          background: colors.surface,
        }}
      >
        {(
          [
            ["CURRENT_VIDEO", "This Video"],
            ["PERSONAL_KB", "My Knowledge"],
            ["COMBINED", "Everything"],
          ] as const
        ).map(([value, label]) => {
          const isSelected = scope === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={isSelected}
              disabled={isLoading}
              onClick={() => setScope(value)}
              style={{
                minWidth: 0,
                border: `1px solid ${isSelected ? colors.accent : "transparent"}`,
                borderRadius: 7,
                padding: "8px 5px",
                background: isSelected ? colors.input : "transparent",
                color: isSelected ? colors.primaryText : colors.muted,
                fontSize: 11,
                fontWeight: isSelected ? 750 : 600,
                cursor: isLoading ? "default" : "pointer",
                opacity: isLoading ? 0.7 : 1,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <textarea
        value={question}
        onChange={(event) => {
          setQuestion(event.target.value);
          setError(null);
        }}
        placeholder="Ask something about your notes..."
        rows={6}
        disabled={isLoading}
        style={{
          ...editorTextareaStyle,
          color: colors.primaryText,
          background: colors.input,
          borderColor: colors.border,
          opacity: isLoading ? 0.7 : 1,
        }}
      />

      <button
        type="button"
        onClick={() => void handleAsk()}
        disabled={isLoading}
        style={{
          width: "100%",
          border: "none",
          borderRadius: 9,
          padding: "11px 14px",
          background: colors.accent,
          color: colors.panel === "#0b1220" ? "#082f49" : "#ffffff",
          fontWeight: 800,
          cursor: isLoading ? "default" : "pointer",
          opacity: isLoading ? 0.7 : 1,
        }}
      >
        {isLoading ? "Generating answer..." : "Ask AI"}
      </button>

      {isLoading && (
        <div
          role="status"
          style={{
            color: colors.muted,
            fontSize: 11,
          }}
        >
          Searching your knowledge and generating an answer...
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            padding: 10,
            borderRadius: 8,
            background: colors.surface,
            border: `1px solid ${colors.danger}`,
            color: colors.danger,
            fontSize: 11,
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      )}

      {answer && (
        <section
          aria-label="AI answer"
          style={{
            padding: 12,
            borderRadius: 9,
            background: colors.surface,
            border: `1px solid ${colors.border}`,
          }}
        >
          <h3
            style={{
              margin: "0 0 7px",
              color: colors.primaryText,
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            Answer
          </h3>
          <p
            style={{
              margin: 0,
              color: colors.text,
              fontSize: 12,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
            }}
          >
            {answer.answer}
          </p>
          {answer.sources.length > 0 && (
            <div
              style={{
                marginTop: 12,
                paddingTop: 9,
                borderTop: `1px solid ${colors.border}`,
              }}
            >
              <div
                style={{
                  marginBottom: 8,
                  color: colors.muted,
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                {answeredScope === "CURRENT_VIDEO"
                  ? "This Video"
                  : answeredScope === "PERSONAL_KB"
                    ? "My Knowledge"
                    : "Everything"}{" "}
                · {answer.sources.length}{" "}
                {answer.sources.length === 1 ? "source" : "sources"}
              </div>
              <h4
                style={{
                  margin: "0 0 6px",
                  color: colors.muted,
                  fontSize: 10,
                  fontWeight: 800,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                Sources
              </h4>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {answer.sources.map((source, index) => {
                  const sourceType = source.metadata.source_type;
                  const isNote =
                    source.note_id !== null || sourceType === "NOTE";
                  const sourceLabel = isNote
                    ? "Note"
                    : sourceType === "VIDEO_TRANSCRIPT"
                      ? "Video Transcript"
                      : sourceType === "VIDEO_ANALYSIS"
                        ? "Video Analysis"
                        : source.video_id !== null
                          ? "Video source"
                          : "Source";
                  const noteTitle = isNote
                    ? notes.find((note) => note.id === source.note_id)?.title
                    : null;
                  const videoLabel =
                    !isNote &&
                    source.video_id !== null &&
                    source.video_id === videoDatabaseId &&
                    videoTitle.trim()
                      ? videoTitle
                      : !isNote && source.video_id !== null
                        ? "Video source"
                        : null;
                  const SourceIcon = isNote
                    ? FileText
                    : sourceType === "VIDEO_TRANSCRIPT"
                      ? BookOpen
                      : sourceType === "VIDEO_ANALYSIS"
                        ? Brain
                        : FileText;

                  return (
                    <div
                      key={`${source.chunk_id}-${index}`}
                      style={{
                        padding: "7px 8px",
                        borderRadius: 7,
                        background: colors.panel,
                        color: colors.muted,
                        fontSize: 11,
                        lineHeight: 1.5,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          marginBottom: 4,
                          color: colors.text,
                          fontSize: 10,
                          fontWeight: 700,
                        }}
                      >
                        <SourceIcon size={12} aria-hidden="true" />
                        <span>{sourceLabel}</span>
                        {(noteTitle || videoLabel) && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{noteTitle || videoLabel}</span>
                          </>
                        )}
                      </div>
                      <div style={{ whiteSpace: "pre-wrap" }}>
                        {source.content}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

interface AnalysisWorkspaceProps {
  colors: ThemeColors;
  analysis: VideoAnalysis | null;
  error: string | null;
  isAnalyzing: boolean;
  canAnalyze: boolean;
  onAnalyze: () => void;
}

function AnalysisWorkspace({
  colors,
  analysis,
  error,
  isAnalyzing,
  canAnalyze,
  onAnalyze,
}: AnalysisWorkspaceProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(["summary"]),
  );

  function toggleSection(id: string) {
    setExpandedSections((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  if (!analysis) {
    return (
      <div>
        <h2
          style={{
            margin: "0 0 12px",
            fontSize: 18,
            fontWeight: 800,
            color: colors.primaryText,
          }}
        >
          Video Analysis
        </h2>

        {error && (
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
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={onAnalyze}
          disabled={isAnalyzing || !canAnalyze}
          style={{
            width: "100%",
            border: "none",
            borderRadius: 8,
            padding: "10px 12px",
            background: colors.accent,
            color: colors.panel === DARK_THEME.panel ? "#082f49" : "#ffffff",
            fontSize: 12,
            fontWeight: 800,
            cursor: isAnalyzing || !canAnalyze ? "default" : "pointer",
            opacity: isAnalyzing || !canAnalyze ? 0.65 : 1,
          }}
        >
          {isAnalyzing ? "Analyzing..." : "Analyze Video"}
        </button>
      </div>
    );
  }

  const detailedNotes =
    typeof analysis.detailed_notes === "object" &&
    analysis.detailed_notes !== null &&
    !Array.isArray(analysis.detailed_notes)
      ? analysis.detailed_notes
      : {};
  const noteSections = getDetailedNotesSections(detailedNotes.sections);
  const definitions = getNonEmptyStrings(detailedNotes.definitions);
  const examples = getNonEmptyStrings(detailedNotes.examples);
  const topics = getNonEmptyStrings(analysis.topics);
  const concepts = getNonEmptyStrings(analysis.concepts);
  const prerequisites = getNonEmptyStrings(analysis.prerequisites);
  const upcomingTopics = getNonEmptyStrings(analysis.upcoming_topics);
  const keyPoints = Array.isArray(analysis.key_points)
    ? analysis.key_points.filter(
        (point) =>
          typeof point?.text === "string" &&
          point.text.trim().length > 0 &&
          typeof point.start === "number" &&
          Number.isFinite(point.start),
      )
    : [];
  const claims = Array.isArray(analysis.claims)
    ? analysis.claims.filter(
        (claim) =>
          typeof claim?.text === "string" &&
          claim.text.trim().length > 0 &&
          typeof claim.start === "number" &&
          Number.isFinite(claim.start),
      )
    : [];
  const questions = getNonEmptyStrings(analysis.questions);

  return (
    <div aria-label="AI Video Analysis">
      <h2
        style={{
          margin: "0 0 10px",
          fontSize: 16,
          fontWeight: 800,
          color: colors.primaryText,
        }}
      >
        AI Video Analysis
      </h2>

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {analysis.summary.trim() && (
          <AnalysisCard
            id="summary"
            title="Summary"
            icon={<FileText size={14} />}
            colors={colors}
            expanded={expandedSections.has("summary")}
            onToggle={toggleSection}
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
              {analysis.summary}
            </p>
          </AnalysisCard>
        )}

        {(noteSections.length > 0 ||
          definitions.length > 0 ||
          examples.length > 0) && (
          <AnalysisCard
            id="detailed-notes"
            title="Detailed Notes"
            icon={<BookOpen size={14} />}
            colors={colors}
            expanded={expandedSections.has("detailed-notes")}
            onToggle={toggleSection}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {noteSections.map((section, index) => (
                <div key={`${section.heading}-${index}`}>
                  <h4
                    style={{
                      margin: "0 0 4px",
                      color: colors.primaryText,
                      fontSize: 11,
                      fontWeight: 750,
                    }}
                  >
                    {section.heading}
                  </h4>
                  <p
                    style={{
                      margin: 0,
                      color: colors.text,
                      fontSize: 12,
                      lineHeight: 1.55,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {section.content}
                  </p>
                </div>
              ))}
              {definitions.length > 0 && (
                <div>
                  <h4 style={analysisSubsectionTitleStyle(colors)}>
                    Definitions
                  </h4>
                  <AnalysisTextList items={definitions} colors={colors} />
                </div>
              )}
              {examples.length > 0 && (
                <div>
                  <h4 style={analysisSubsectionTitleStyle(colors)}>Examples</h4>
                  <AnalysisTextList items={examples} colors={colors} />
                </div>
              )}
            </div>
          </AnalysisCard>
        )}

        {topics.length > 0 && (
          <AnalysisCard
            id="topics"
            title="Topics"
            icon={<Tags size={14} />}
            colors={colors}
            expanded={expandedSections.has("topics")}
            onToggle={toggleSection}
          >
            <AnalysisTextList items={topics} colors={colors} />
          </AnalysisCard>
        )}

        {concepts.length > 0 && (
          <AnalysisCard
            id="concepts"
            title="Concepts"
            icon={<Lightbulb size={14} />}
            colors={colors}
            expanded={expandedSections.has("concepts")}
            onToggle={toggleSection}
          >
            <AnalysisTextList items={concepts} colors={colors} />
          </AnalysisCard>
        )}

        {prerequisites.length > 0 && (
          <AnalysisCard
            id="prerequisites"
            title="Prerequisites"
            icon={<GraduationCap size={14} />}
            colors={colors}
            expanded={expandedSections.has("prerequisites")}
            onToggle={toggleSection}
          >
            <AnalysisTextList items={prerequisites} colors={colors} />
          </AnalysisCard>
        )}

        {upcomingTopics.length > 0 && (
          <AnalysisCard
            id="upcoming-topics"
            title="Upcoming Topics"
            icon={<Route size={14} />}
            colors={colors}
            expanded={expandedSections.has("upcoming-topics")}
            onToggle={toggleSection}
          >
            <AnalysisTextList items={upcomingTopics} colors={colors} />
          </AnalysisCard>
        )}

        {keyPoints.length > 0 && (
          <AnalysisCard
            id="key-points"
            title="Key Points"
            icon={<ListChecks size={14} />}
            colors={colors}
            expanded={expandedSections.has("key-points")}
            onToggle={toggleSection}
          >
            <AnalysisTimestampList items={keyPoints} colors={colors} />
          </AnalysisCard>
        )}

        {claims.length > 0 && (
          <AnalysisCard
            id="claims"
            title="Claims"
            icon={<BadgeCheck size={14} />}
            colors={colors}
            expanded={expandedSections.has("claims")}
            onToggle={toggleSection}
          >
            <AnalysisTimestampList items={claims} colors={colors} />
          </AnalysisCard>
        )}

        {questions.length > 0 && (
          <AnalysisCard
            id="questions"
            title="Questions"
            icon={<CircleHelp size={14} />}
            colors={colors}
            expanded={expandedSections.has("questions")}
            onToggle={toggleSection}
          >
            <AnalysisTextList items={questions} colors={colors} />
          </AnalysisCard>
        )}
      </div>
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
  analysisStatus,
  persistedAnalysis,
  transcriptStatus,
}: SidebarProps) {
  const [activeWorkspace, setActiveWorkspace] =
    useState<PrimaryWorkspace>("NOTES");
  const [viewMode, setViewMode] = useState<ViewMode>("LIST");

  const [currentNotes, setCurrentNotes] = useState(notes);
  const [previousContextState, setPreviousContextState] =
    useState<PreviousContextLoadState>({
      videoId,
      status: "loading",
    });

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

  const [expandedConcepts, setExpandedConcepts] = useState<Record<string, boolean>>(
    {},
  );

  const [editingNote, setEditingNote] = useState<VideoNote | null>(null);

  const [hoveredNoteId, setHoveredNoteId] = useState<number | null>(null);
  const [focusedNoteId, setFocusedNoteId] = useState<number | null>(null);

  const [deletePendingNoteId, setDeletePendingNoteId] = useState<number | null>(
    null,
  );

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [minimized, setMinimized] = useState(false);

  const [position, setPosition] = useState<Position>(getDefaultPosition());

  const [theme, setTheme] = useState<Theme>("dark");

  const [dragging, setDragging] = useState(false);

  const [minimizedDragging, setMinimizedDragging] = useState(false);

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
  const previousContextRequestVersion = useRef(0);
  const previousContextAbortController = useRef<AbortController | null>(null);
  const currentVideoIdRef = useRef(videoId);
  currentVideoIdRef.current = videoId;

  const loadPreviousContext = useCallback(async () => {
    previousContextAbortController.current?.abort();
    const abortController = new AbortController();
    previousContextAbortController.current = abortController;
    const requestVersion = ++previousContextRequestVersion.current;
    setPreviousContextState({ videoId, status: "loading" });

    try {
      const response = await sendPreviousContext(videoId, abortController.signal);
      if (
        requestVersion !== previousContextRequestVersion.current ||
        currentVideoIdRef.current !== videoId ||
        abortController.signal.aborted ||
        getActiveYouTubeVideoId() !== videoId
      ) {
        return;
      }

      if (response.status === 404) {
        setPreviousContextState({
          videoId,
          status: "loaded",
          data: null,
        });
        return;
      }
      if (!response.success || !isPreviousContextData(response.data)) {
        setPreviousContextState({ videoId, status: "error" });
        return;
      }
      if (response.data.video.youtube_id !== videoId) {
        setPreviousContextState({ videoId, status: "error" });
        return;
      }

      setPreviousContextState({
        videoId,
        status: "loaded",
        data: response.data,
      });
    } catch {
      if (
        requestVersion === previousContextRequestVersion.current &&
        currentVideoIdRef.current === videoId &&
        !abortController.signal.aborted &&
        getActiveYouTubeVideoId() === videoId
      ) {
        setPreviousContextState({ videoId, status: "error" });
      }
    }
  }, [videoId]);

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
    let scheduled = true;
    queueMicrotask(() => {
      if (scheduled) {
        void loadPreviousContext();
      }
    });
    return () => {
      scheduled = false;
      previousContextRequestVersion.current += 1;
      previousContextAbortController.current?.abort();
      previousContextAbortController.current = null;
    };
  }, [loadPreviousContext]);

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
    if (contextStatus !== "loaded") {
      return;
    }

    if (
      persistedAnalysis !== null &&
      isVideoAnalysis(persistedAnalysis)
    ) {
      setVideoAnalysis({ videoId, analysis: persistedAnalysis });
    } else {
      setVideoAnalysis(null);
    }
  }, [contextStatus, persistedAnalysis, videoId]);

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
  const previousContextStatus =
    previousContextState.videoId === videoId
      ? previousContextState.status
      : "loading";
  const previousContext =
    previousContextState.videoId === videoId &&
    previousContextState.status === "loaded"
      ? previousContextState.data
      : null;
  const prerequisiteConcepts = previousContext?.concepts.prerequisites ?? [];
  const upcomingConcepts = previousContext?.concepts.upcoming ?? [];
  const persistedCurrentAnalysis =
    contextStatus === "loaded" &&
    persistedAnalysis !== null &&
    isVideoAnalysis(persistedAnalysis)
      ? persistedAnalysis
      : null;
  const currentAnalysis =
    videoAnalysis?.videoId === videoId
      ? videoAnalysis.analysis
      : persistedCurrentAnalysis;
  const currentAnalysisError =
    analysisError?.videoId === videoId ? analysisError.message : null;
  const isAnalyzing =
    analysisLoadingVideoId === videoId ||
    (contextStatus === "loaded" && analysisStatus === "ANALYZING");
  const currentTranscriptStatus =
    transcriptState?.videoId === videoId
      ? transcriptState.status
      : contextStatus === "loaded" && transcriptStatus !== null
        ? transcriptStatus
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

  function handleNoteNavigation(tab: NoteNavigationTab) {
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
        <Brain size={22} aria-hidden="true" />
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
            <Minus size={15} aria-hidden="true" />
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
            {theme === "dark" ? (
              <Sun size={15} aria-hidden="true" />
            ) : (
              <Moon size={15} aria-hidden="true" />
            )}
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
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div
        onPointerDown={(event) => event.stopPropagation()}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 4,
          padding: "7px 10px",
          background: colors.header,
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        {(
          [
            ["NOTES", "Notes"],
            ["ANALYSIS", "Analysis"],
          ] as const
        ).map(([workspace, label]) => {
          const active = activeWorkspace === workspace;
          return (
            <button
              key={workspace}
              type="button"
              onClick={() => setActiveWorkspace(workspace)}
              style={{
                border: `1px solid ${active ? colors.accent : colors.border}`,
                borderRadius: 7,
                padding: "8px 10px",
                background: active ? colors.accentSoft : "transparent",
                color: active ? colors.accent : colors.muted,
                cursor: "pointer",
                fontSize: 11,
                fontWeight: active ? 800 : 650,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {activeWorkspace === "NOTES" && selectedNote !== null && (
        <div
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 4,
            padding: "6px 10px",
            background: colors.surface,
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <button
            type="button"
            onClick={returnToList}
            disabled={viewMode === "LIST" && selectedNote === null}
            title="Back to notes list"
            aria-label="Back to notes list"
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: 7,
              padding: "7px 8px",
              background: "transparent",
              color: colors.muted,
              cursor:
                viewMode === "LIST" && selectedNote === null
                  ? "default"
                  : "pointer",
              opacity: viewMode === "LIST" && selectedNote === null ? 0.5 : 1,
            }}
          >
            <ArrowLeft size={14} aria-hidden="true" />
          </button>
          {(
            [
              ["READ", "Read", "READER"],
              ["WRITE", "Write", "WRITER"],
              ["AI", "AI", "AI"],
            ] as const
          ).map(([tab, label, mode]) => {
            const active = viewMode === mode;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => handleNoteNavigation(tab)}
                disabled={!selectedNote}
                style={{
                  border: `1px solid ${active ? colors.accent : colors.border}`,
                  borderRadius: 7,
                  padding: "7px 8px",
                  background: active ? colors.accentSoft : "transparent",
                  color: active ? colors.accent : colors.muted,
                  cursor: selectedNote ? "pointer" : "default",
                  fontSize: 10,
                  fontWeight: active ? 800 : 650,
                  opacity: selectedNote ? 1 : 0.5,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Video title is shown only in the note list, not as a separate section */}
      {activeWorkspace === "NOTES" && !selectedNote && viewMode === "LIST" && (
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
        {activeWorkspace === "NOTES" && deleteError && (
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
        {activeWorkspace === "NOTES" && viewMode === "LIST" && (
          <div>
            <section
              aria-label="My Previous Context"
              style={{
                marginBottom: 14,
                padding: 11,
                borderRadius: 10,
                background: colors.surface,
                border: `1px solid ${colors.border}`,
              }}
            >
              <h2
                style={{
                  margin: "0 0 8px",
                  fontSize: 12,
                  fontWeight: 800,
                  color: colors.primaryText,
                }}
              >
                My Previous Context
              </h2>

              {previousContextStatus === "loading" ? (
                <div
                  role="status"
                  style={{ color: colors.muted, fontSize: 11 }}
                >
                  Loading previous context...
                </div>
              ) : previousContextStatus === "error" ? (
                <div
                  role="alert"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    color: colors.danger,
                    fontSize: 11,
                  }}
                >
                  <span>Could not load previous context.</span>
                  <button
                    type="button"
                    onClick={() => void loadPreviousContext()}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: colors.accent,
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <>
                  {previousContext?.exact.length ? (
                    <div style={{ marginBottom: 10 }}>
                      <h3
                        style={{
                          margin: "0 0 5px",
                          color: colors.muted,
                          fontSize: 10,
                          fontWeight: 800,
                        }}
                      >
                        Notes from this video
                      </h3>
                      <div style={{ display: "grid", gap: 5 }}>
                        {previousContext.exact.map((item) => {
                          const note = currentNotes.find(
                            (currentNote) => currentNote.id === item.note_id,
                          );
                          const preview = item.content
                            .replace(/\s+/g, " ")
                            .trim();
                          const contentPreview =
                            preview.length > 140
                              ? `${preview.slice(0, 137)}...`
                              : preview;
                          const itemStyle = {
                            display: "flex",
                            flexDirection: "column" as const,
                            alignItems: "flex-start",
                            gap: 3,
                            width: "100%",
                            minWidth: 0,
                            padding: "6px 7px",
                            border: "none",
                            borderRadius: 6,
                            background: "transparent",
                            color: colors.text,
                            textAlign: "left" as const,
                            fontSize: 11,
                            lineHeight: 1.4,
                          };
                          const content = (
                            <>
                              <span
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 6,
                                  fontWeight: 700,
                                }}
                              >
                                <FileText
                                  size={13}
                                  aria-hidden="true"
                                  style={{
                                    flexShrink: 0,
                                    color: colors.muted,
                                  }}
                                />
                                {item.title || "Untitled note"}
                              </span>
                              {contentPreview && (
                                <span
                                  style={{
                                    display: "-webkit-box",
                                    overflow: "hidden",
                                    color: colors.muted,
                                    fontSize: 10,
                                    WebkitBoxOrient: "vertical",
                                    WebkitLineClamp: 2,
                                  }}
                                >
                                  {contentPreview}
                                </span>
                              )}
                            </>
                          );

                          return note ? (
                            <button
                              key={item.note_id}
                              type="button"
                              onClick={() => openReader(note)}
                              title={item.title || "Untitled note"}
                              style={{
                                ...itemStyle,
                                cursor: "pointer",
                              }}
                            >
                              {content}
                            </button>
                          ) : (
                            <div key={item.note_id} style={itemStyle}>
                              {content}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {previousContext?.related.length ? (
                    <div style={{ marginBottom: 10 }}>
                      <h3
                        style={{
                          margin: "0 0 5px",
                          color: colors.muted,
                          fontSize: 10,
                          fontWeight: 800,
                        }}
                      >
                        Related knowledge
                      </h3>
                      <div style={{ display: "grid", gap: 5 }}>
                        {previousContext.related.map((item) => {
                          const preview = item.content
                            .replace(/\s+/g, " ")
                            .trim();
                          return (
                            <div
                              key={item.chunk_id}
                              style={{
                                padding: "6px 7px",
                                borderRadius: 6,
                                background: colors.panel,
                                color: colors.text,
                                fontSize: 11,
                                lineHeight: 1.4,
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 6,
                                  marginBottom: 3,
                                  fontWeight: 700,
                                }}
                              >
                                <BookOpen
                                  size={12}
                                  aria-hidden="true"
                                  style={{ color: colors.muted }}
                                />
                                {item.title || "Related note"}
                              </div>
                              <div
                                style={{
                                  display: "-webkit-box",
                                  overflow: "hidden",
                                  color: colors.muted,
                                  fontSize: 10,
                                  WebkitBoxOrient: "vertical",
                                  WebkitLineClamp: 2,
                                }}
                              >
                                {preview}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {(prerequisiteConcepts.length > 0 || upcomingConcepts.length > 0) && (
                    <div style={{ marginBottom: 12 }}>
                      <h3
                        style={{
                          margin: "0 0 6px",
                          color: colors.muted,
                          fontSize: 10,
                          fontWeight: 800,
                        }}
                      >
                        Concept Context
                      </h3>

                      {prerequisiteConcepts.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <h4
                            style={{
                              margin: "0 0 5px",
                              color: colors.muted,
                              fontSize: 9,
                              fontWeight: 800,
                              textTransform: "uppercase",
                              letterSpacing: 0.5,
                            }}
                          >
                            Prerequisites
                          </h4>
                          <div style={{ display: "grid", gap: 6 }}>
                            {prerequisiteConcepts.map((concept) => {
                              const conceptKey = `${concept.type}-${concept.name}`;
                              const isExpanded = Boolean(expandedConcepts[conceptKey]);
                              const hasReason =
                                typeof concept.reason === "string" &&
                                concept.reason.trim().length > 0;
                              const hasEvidence =
                                typeof concept.evidence === "string" &&
                                concept.evidence.trim().length > 0;
                              const hasTimestamps = concept.timestamps.length > 0;
                              const hasPersonalNotes = concept.personal_notes.length > 0;
                              const showDetails =
                                hasReason || hasEvidence || hasTimestamps || hasPersonalNotes;

                              return (
                                <div
                                  key={conceptKey}
                                  style={{
                                    padding: "7px 8px",
                                    borderRadius: 8,
                                    background: colors.panel,
                                    border: `1px solid ${colors.border}`,
                                  }}
                                >
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setExpandedConcepts((current) => ({
                                        ...current,
                                        [conceptKey]: !current[conceptKey],
                                      }))
                                    }
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "space-between",
                                      width: "100%",
                                      gap: 8,
                                      background: "transparent",
                                      border: "none",
                                      padding: 0,
                                      color: colors.text,
                                      textAlign: "left",
                                      cursor: "pointer",
                                      font: "inherit",
                                    }}
                                  >
                                    <div style={{ minWidth: 0 }}>
                                      <div
                                        style={{
                                          color: colors.primaryText,
                                          fontSize: 11,
                                          fontWeight: 800,
                                          lineHeight: 1.4,
                                        }}
                                      >
                                        {concept.name}
                                      </div>
                                      <div
                                        style={{
                                          display: "flex",
                                          flexWrap: "wrap",
                                          gap: 5,
                                          marginTop: 3,
                                          color: colors.muted,
                                          fontSize: 9,
                                        }}
                                      >
                                        <span
                                          style={{
                                            padding: "2px 5px",
                                            borderRadius: 999,
                                            background: colors.accentSoft,
                                            color: colors.accent,
                                            fontWeight: 700,
                                          }}
                                        >
                                          {concept.has_previous_knowledge
                                            ? "You know this"
                                            : "Needs review"}
                                        </span>
                                        {concept.related_count > 0 && (
                                          <span>
                                            {concept.related_count} related note
                                            {concept.related_count === 1 ? "" : "s"}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    {showDetails && (
                                      isExpanded ? (
                                        <ChevronDown size={13} aria-hidden="true" />
                                      ) : (
                                        <ChevronRight size={13} aria-hidden="true" />
                                      )
                                    )}
                                  </button>

                                  {isExpanded && showDetails && (
                                    <div
                                      style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: 8,
                                        marginTop: 8,
                                      }}
                                    >
                                      {hasReason && (
                                        <div>
                                          <div
                                            style={{
                                              color: colors.muted,
                                              fontSize: 9,
                                              fontWeight: 800,
                                              textTransform: "uppercase",
                                              letterSpacing: 0.5,
                                              marginBottom: 3,
                                            }}
                                          >
                                            Reason
                                          </div>
                                          <div
                                            style={{
                                              color: colors.text,
                                              fontSize: 11,
                                              lineHeight: 1.5,
                                              whiteSpace: "pre-wrap",
                                            }}
                                          >
                                            {concept.reason}
                                          </div>
                                        </div>
                                      )}

                                      {hasEvidence && (
                                        <div>
                                          <div
                                            style={{
                                              color: colors.muted,
                                              fontSize: 9,
                                              fontWeight: 800,
                                              textTransform: "uppercase",
                                              letterSpacing: 0.5,
                                              marginBottom: 3,
                                            }}
                                          >
                                            Evidence
                                          </div>
                                          <div
                                            style={{
                                              color: colors.text,
                                              fontSize: 11,
                                              lineHeight: 1.5,
                                              whiteSpace: "pre-wrap",
                                            }}
                                          >
                                            {concept.evidence}
                                          </div>
                                        </div>
                                      )}

                                      {hasTimestamps && (
                                        <div>
                                          <div
                                            style={{
                                              color: colors.muted,
                                              fontSize: 9,
                                              fontWeight: 800,
                                              textTransform: "uppercase",
                                              letterSpacing: 0.5,
                                              marginBottom: 3,
                                            }}
                                          >
                                            Timestamps
                                          </div>
                                          <div style={{ display: "grid", gap: 4 }}>
                                            {concept.timestamps.map((timestamp, index) => (
                                              <button
                                                key={`${concept.name}-${timestamp.seconds}-${index}`}
                                                type="button"
                                                onClick={() => jumpToTimestamp(timestamp.seconds)}
                                                style={{
                                                  display: "inline-flex",
                                                  alignItems: "center",
                                                  gap: 5,
                                                  width: "fit-content",
                                                  padding: "3px 6px",
                                                  borderRadius: 6,
                                                  border: `1px solid ${colors.border}`,
                                                  background: colors.surface,
                                                  color: colors.accent,
                                                  fontSize: 10,
                                                  fontWeight: 700,
                                                  cursor: "pointer",
                                                }}
                                              >
                                                <Play size={10} aria-hidden="true" />
                                                {formatTimestamp(timestamp.seconds)}
                                              </button>
                                            ))}
                                          </div>
                                        </div>
                                      )}

                                      {hasPersonalNotes && (
                                        <div>
                                          <div
                                            style={{
                                              color: colors.muted,
                                              fontSize: 9,
                                              fontWeight: 800,
                                              textTransform: "uppercase",
                                              letterSpacing: 0.5,
                                              marginBottom: 3,
                                            }}
                                          >
                                            Personal Notes
                                          </div>
                                          <div style={{ display: "grid", gap: 5 }}>
                                            {concept.personal_notes.map((item) => {
                                              const note = currentNotes.find(
                                                (currentNote) => currentNote.id === item.note_id,
                                              );
                                              const preview = item.content
                                                .replace(/\s+/g, " ")
                                                .trim();
                                              const contentPreview =
                                                preview.length > 120
                                                  ? `${preview.slice(0, 117)}...`
                                                  : preview;
                                              const content = (
                                                <>
                                                  <span
                                                    style={{
                                                      display: "flex",
                                                      alignItems: "center",
                                                      gap: 6,
                                                      fontWeight: 700,
                                                    }}
                                                  >
                                                    <FileText
                                                      size={11}
                                                      aria-hidden="true"
                                                      style={{ color: colors.muted }}
                                                    />
                                                    {item.title || "Related note"}
                                                  </span>
                                                  {contentPreview && (
                                                    <span
                                                      style={{
                                                        display: "-webkit-box",
                                                        overflow: "hidden",
                                                        color: colors.muted,
                                                        fontSize: 10,
                                                        WebkitBoxOrient: "vertical",
                                                        WebkitLineClamp: 2,
                                                      }}
                                                    >
                                                      {contentPreview}
                                                    </span>
                                                  )}
                                                </>
                                              );

                                              return note ? (
                                                <button
                                                  key={`${item.note_id}-${item.chunk_id}`}
                                                  type="button"
                                                  onClick={() => openReader(note)}
                                                  title={item.title || "Related note"}
                                                  style={{
                                                    display: "flex",
                                                    flexDirection: "column",
                                                    alignItems: "flex-start",
                                                    gap: 3,
                                                    width: "100%",
                                                    minWidth: 0,
                                                    padding: "5px 6px",
                                                    border: "none",
                                                    borderRadius: 6,
                                                    background: "transparent",
                                                    color: colors.text,
                                                    textAlign: "left",
                                                    cursor: "pointer",
                                                    fontSize: 10,
                                                    lineHeight: 1.4,
                                                  }}
                                                >
                                                  {content}
                                                </button>
                                              ) : (
                                                <div
                                                  key={`${item.note_id}-${item.chunk_id}`}
                                                  style={{
                                                    display: "flex",
                                                    flexDirection: "column",
                                                    alignItems: "flex-start",
                                                    gap: 3,
                                                    width: "100%",
                                                    minWidth: 0,
                                                    padding: "5px 6px",
                                                    borderRadius: 6,
                                                    background: colors.surface,
                                                    color: colors.text,
                                                    fontSize: 10,
                                                    lineHeight: 1.4,
                                                  }}
                                                >
                                                  {content}
                                                </div>
                                              );
                                            })}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {upcomingConcepts.length > 0 && (
                        <div>
                          <h4
                            style={{
                              margin: "0 0 5px",
                              color: colors.muted,
                              fontSize: 9,
                              fontWeight: 800,
                              textTransform: "uppercase",
                              letterSpacing: 0.5,
                            }}
                          >
                            Upcoming
                          </h4>
                          <div style={{ display: "grid", gap: 6 }}>
                            {upcomingConcepts.map((concept) => {
                              const conceptKey = `${concept.type}-${concept.name}`;
                              const isExpanded = Boolean(expandedConcepts[conceptKey]);
                              const hasReason =
                                typeof concept.reason === "string" &&
                                concept.reason.trim().length > 0;
                              const hasEvidence =
                                typeof concept.evidence === "string" &&
                                concept.evidence.trim().length > 0;
                              const hasTimestamps = concept.timestamps.length > 0;
                              const hasPersonalNotes = concept.personal_notes.length > 0;
                              const showDetails =
                                hasReason || hasEvidence || hasTimestamps || hasPersonalNotes;

                              return (
                                <div
                                  key={conceptKey}
                                  style={{
                                    padding: "7px 8px",
                                    borderRadius: 8,
                                    background: colors.panel,
                                    border: `1px solid ${colors.border}`,
                                  }}
                                >
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setExpandedConcepts((current) => ({
                                        ...current,
                                        [conceptKey]: !current[conceptKey],
                                      }))
                                    }
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "space-between",
                                      width: "100%",
                                      gap: 8,
                                      background: "transparent",
                                      border: "none",
                                      padding: 0,
                                      color: colors.text,
                                      textAlign: "left",
                                      cursor: "pointer",
                                      font: "inherit",
                                    }}
                                  >
                                    <div style={{ minWidth: 0 }}>
                                      <div
                                        style={{
                                          color: colors.primaryText,
                                          fontSize: 11,
                                          fontWeight: 800,
                                          lineHeight: 1.4,
                                        }}
                                      >
                                        {concept.name}
                                      </div>
                                      <div
                                        style={{
                                          display: "flex",
                                          flexWrap: "wrap",
                                          gap: 5,
                                          marginTop: 3,
                                          color: colors.muted,
                                          fontSize: 9,
                                        }}
                                      >
                                        <span
                                          style={{
                                            padding: "2px 5px",
                                            borderRadius: 999,
                                            background: colors.accentSoft,
                                            color: colors.accent,
                                            fontWeight: 700,
                                          }}
                                        >
                                          {concept.has_previous_knowledge
                                            ? "You know this"
                                            : "Upcoming"}
                                        </span>
                                        {concept.related_count > 0 && (
                                          <span>
                                            {concept.related_count} related note
                                            {concept.related_count === 1 ? "" : "s"}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    {showDetails && (
                                      isExpanded ? (
                                        <ChevronDown size={13} aria-hidden="true" />
                                      ) : (
                                        <ChevronRight size={13} aria-hidden="true" />
                                      )
                                    )}
                                  </button>

                                  {isExpanded && showDetails && (
                                    <div
                                      style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: 8,
                                        marginTop: 8,
                                      }}
                                    >
                                      {hasReason && (
                                        <div>
                                          <div
                                            style={{
                                              color: colors.muted,
                                              fontSize: 9,
                                              fontWeight: 800,
                                              textTransform: "uppercase",
                                              letterSpacing: 0.5,
                                              marginBottom: 3,
                                            }}
                                          >
                                            Reason
                                          </div>
                                          <div
                                            style={{
                                              color: colors.text,
                                              fontSize: 11,
                                              lineHeight: 1.5,
                                              whiteSpace: "pre-wrap",
                                            }}
                                          >
                                            {concept.reason}
                                          </div>
                                        </div>
                                      )}

                                      {hasEvidence && (
                                        <div>
                                          <div
                                            style={{
                                              color: colors.muted,
                                              fontSize: 9,
                                              fontWeight: 800,
                                              textTransform: "uppercase",
                                              letterSpacing: 0.5,
                                              marginBottom: 3,
                                            }}
                                          >
                                            Evidence
                                          </div>
                                          <div
                                            style={{
                                              color: colors.text,
                                              fontSize: 11,
                                              lineHeight: 1.5,
                                              whiteSpace: "pre-wrap",
                                            }}
                                          >
                                            {concept.evidence}
                                          </div>
                                        </div>
                                      )}

                                      {hasTimestamps && (
                                        <div>
                                          <div
                                            style={{
                                              color: colors.muted,
                                              fontSize: 9,
                                              fontWeight: 800,
                                              textTransform: "uppercase",
                                              letterSpacing: 0.5,
                                              marginBottom: 3,
                                            }}
                                          >
                                            Timestamps
                                          </div>
                                          <div style={{ display: "grid", gap: 4 }}>
                                            {concept.timestamps.map((timestamp, index) => (
                                              <button
                                                key={`${concept.name}-${timestamp.seconds}-${index}`}
                                                type="button"
                                                onClick={() => jumpToTimestamp(timestamp.seconds)}
                                                style={{
                                                  display: "inline-flex",
                                                  alignItems: "center",
                                                  gap: 5,
                                                  width: "fit-content",
                                                  padding: "3px 6px",
                                                  borderRadius: 6,
                                                  border: `1px solid ${colors.border}`,
                                                  background: colors.surface,
                                                  color: colors.accent,
                                                  fontSize: 10,
                                                  fontWeight: 700,
                                                  cursor: "pointer",
                                                }}
                                              >
                                                <Play size={10} aria-hidden="true" />
                                                {formatTimestamp(timestamp.seconds)}
                                              </button>
                                            ))}
                                          </div>
                                        </div>
                                      )}

                                      {hasPersonalNotes && (
                                        <div>
                                          <div
                                            style={{
                                              color: colors.muted,
                                              fontSize: 9,
                                              fontWeight: 800,
                                              textTransform: "uppercase",
                                              letterSpacing: 0.5,
                                              marginBottom: 3,
                                            }}
                                          >
                                            Personal Notes
                                          </div>
                                          <div style={{ display: "grid", gap: 5 }}>
                                            {concept.personal_notes.map((item) => {
                                              const note = currentNotes.find(
                                                (currentNote) => currentNote.id === item.note_id,
                                              );
                                              const preview = item.content
                                                .replace(/\s+/g, " ")
                                                .trim();
                                              const contentPreview =
                                                preview.length > 120
                                                  ? `${preview.slice(0, 117)}...`
                                                  : preview;
                                              const content = (
                                                <>
                                                  <span
                                                    style={{
                                                      display: "flex",
                                                      alignItems: "center",
                                                      gap: 6,
                                                      fontWeight: 700,
                                                    }}
                                                  >
                                                    <FileText
                                                      size={11}
                                                      aria-hidden="true"
                                                      style={{ color: colors.muted }}
                                                    />
                                                    {item.title || "Related note"}
                                                  </span>
                                                  {contentPreview && (
                                                    <span
                                                      style={{
                                                        display: "-webkit-box",
                                                        overflow: "hidden",
                                                        color: colors.muted,
                                                        fontSize: 10,
                                                        WebkitBoxOrient: "vertical",
                                                        WebkitLineClamp: 2,
                                                      }}
                                                    >
                                                      {contentPreview}
                                                    </span>
                                                  )}
                                                </>
                                              );

                                              return note ? (
                                                <button
                                                  key={`${item.note_id}-${item.chunk_id}`}
                                                  type="button"
                                                  onClick={() => openReader(note)}
                                                  title={item.title || "Related note"}
                                                  style={{
                                                    display: "flex",
                                                    flexDirection: "column",
                                                    alignItems: "flex-start",
                                                    gap: 3,
                                                    width: "100%",
                                                    minWidth: 0,
                                                    padding: "5px 6px",
                                                    border: "none",
                                                    borderRadius: 6,
                                                    background: "transparent",
                                                    color: colors.text,
                                                    textAlign: "left",
                                                    cursor: "pointer",
                                                    fontSize: 10,
                                                    lineHeight: 1.4,
                                                  }}
                                                >
                                                  {content}
                                                </button>
                                              ) : (
                                                <div
                                                  key={`${item.note_id}-${item.chunk_id}`}
                                                  style={{
                                                    display: "flex",
                                                    flexDirection: "column",
                                                    alignItems: "flex-start",
                                                    gap: 3,
                                                    width: "100%",
                                                    minWidth: 0,
                                                    padding: "5px 6px",
                                                    borderRadius: 6,
                                                    background: colors.surface,
                                                    color: colors.text,
                                                    fontSize: 10,
                                                    lineHeight: 1.4,
                                                  }}
                                                >
                                                  {content}
                                                </div>
                                              );
                                            })}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {previousContext !== null &&
                    previousContext.exact.length === 0 &&
                    previousContext.related.length === 0 &&
                    prerequisiteConcepts.length === 0 &&
                    upcomingConcepts.length === 0 && (
                      <div
                        style={{
                          color: colors.muted,
                          fontSize: 11,
                          lineHeight: 1.4,
                        }}
                      >
                        No previous context found.
                      </div>
                    )}
                </>
              )}
            </section>

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
                <Plus size={14} aria-hidden="true" />
                New Note
              </button>
            </div>

            {currentTranscriptStatus !== "READY" && (
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
                    color: colors.muted,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {currentTranscriptStatus === "FETCHING"
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

              {contextStatus === "loaded" && !currentAnalysis && (
                  <button
                    type="button"
                    onClick={() => void handleFetchTranscript()}
                    disabled={isFetchingTranscript}
                    style={{
                      width: "100%",
                      border: "none",
                      borderRadius: 8,
                      padding: "9px 12px",
                      background: colors.accent,
                      color: theme === "dark" ? "#082f49" : "#ffffff",
                      fontSize: 11,
                      fontWeight: 800,
                      cursor: isFetchingTranscript ? "default" : "pointer",
                      opacity: isFetchingTranscript ? 0.65 : 1,
                    }}
                  >
                    {isFetchingTranscript
                      ? "Retrieving Transcript..."
                      : "Retrieve Transcript"}
                  </button>
                )}
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
                    display: "flex",
                    justifyContent: "center",
                    marginBottom: 12,
                  }}
                >
                  <FileText size={30} aria-hidden="true" />
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
                    onMouseEnter={() => setHoveredNoteId(note.id)}
                    onMouseLeave={() => setHoveredNoteId(null)}
                    onFocusCapture={() => setFocusedNoteId(note.id)}
                    onBlurCapture={(event) => {
                      if (
                        !(event.relatedTarget instanceof Node) ||
                        !event.currentTarget.contains(event.relatedTarget)
                      ) {
                        setFocusedNoteId(null);
                      }
                    }}
                    style={{
                      display: "flex",
                      alignItems: "stretch",
                      border: `1px solid ${colors.border}`,
                      borderRadius: 10,
                      background: colors.surface,
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
                        border: "none",
                        borderRadius: 10,
                        background: "transparent",
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

                          <FolderPathMetadata
                            note={note}
                            colors={colors}
                            compact
                          />

                          {formatUpdatedAt(note.updated_at) && (
                            <div
                              style={{
                                marginTop: 7,
                                color: colors.muted,
                                fontSize: 10,
                              }}
                            >
                              Updated {formatUpdatedAt(note.updated_at)}
                            </div>
                          )}
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
                      aria-hidden={
                        hoveredNoteId !== note.id && focusedNoteId !== note.id
                      }
                      tabIndex={
                        hoveredNoteId === note.id || focusedNoteId === note.id
                          ? 0
                          : -1
                      }
                      style={{
                        ...iconButtonStyle,
                        alignSelf: "center",
                        flexShrink: 0,
                        margin: "0 10px 0 0",
                        color: colors.danger,
                        border: "none",
                        background: "transparent",
                        opacity: deletePendingNoteId !== null ? 0.55 : 1,
                        visibility:
                          hoveredNoteId === note.id || focusedNoteId === note.id
                            ? "visible"
                            : "hidden",
                      }}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ANALYSIS */}
        {activeWorkspace === "ANALYSIS" && (
          <AnalysisWorkspace
            colors={colors}
            analysis={currentAnalysis}
            error={currentAnalysisError}
            isAnalyzing={isAnalyzing}
            canAnalyze={
              contextStatus === "loaded" &&
              currentTranscriptStatus === "READY"
            }
            onAnalyze={() => void handleAnalyzeVideo()}
          />
        )}

        {/* READER */}
        {activeWorkspace === "NOTES" &&
          viewMode === "READER" &&
          selectedNote && (
          <NoteReader
            note={selectedNote}
            colors={colors}
            showFolderPath
          />
        )}

        {/* WRITER */}
        {activeWorkspace === "NOTES" && viewMode === "WRITER" && (
          <NoteWriter
            note={editingNote}
            videoId={videoId}
            colors={colors}
            onSaved={handleSaved}
          />
        )}

        {/* AI */}
        {activeWorkspace === "NOTES" && viewMode === "AI" && selectedNote && (
          <AIWorkspace
            colors={colors}
            videoId={videoId}
            videoTitle={videoTitle}
            videoDatabaseId={
              currentAnalysis?.video ??
              currentNotes.find((note) => note.video != null)?.video ??
              null
            }
            notes={currentNotes}
          />
        )}
      </div>
      {currentTranscriptStatus === "READY" && (
        <div
          role="status"
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "8px 15px",
            borderTop: `1px solid ${colors.border}`,
            background: colors.surface,
            color: colors.muted,
            fontSize: 11,
            fontWeight: 650,
          }}
        >
          <Check size={13} aria-hidden="true" />
          Transcript Ready
        </div>
      )}
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
