export type NoteBlockType =
  | "paragraph"
  | "heading"
  | "equation"
  | "timestamp"
  | "image"
  | "url"
  | "code"
  | "command"
  | "bullet_list"
  | "numbered_list"
  | "screenshot";

export interface NoteBlock {
  id: string;
  type: NoteBlockType;
  content: string;
  [key: string]: unknown;
  metadata?: {
    source?: "url" | "upload" | "youtube";
    url?: string;
    alt?: string;
    title?: string;
    description?: string;
    domain?: string;
    thumbnail?: string;
    resource_type?: string;
    language?: string;
    shell?: string;
    timestamp_seconds?: number;
    image?: string;
    [key: string]: unknown;
  };
}

export interface NoteDocument {
  version: 1;
  blocks: NoteBlock[];
  [key: string]: unknown;
}

export interface FolderPathItem {
  id: number;
  name: string;
}

export interface VideoNote {
  id: number;
  title: string;
  content: string;
  document?: NoteDocument;
  note_type: string;
  video?: number | null;
  folder?: number | null;
  folder_path?: FolderPathItem[];
  timestamp_seconds?: number | null;
  created_at?: string;
  updated_at?: string;
}

export function normalizeFolderPath(value: unknown): FolderPathItem[] {
  if (!Array.isArray(value)) return [];

  const path: FolderPathItem[] = [];
  for (const item of value) {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      !("id" in item) ||
      typeof item.id !== "number" ||
      !Number.isSafeInteger(item.id) ||
      item.id < 1 ||
      !("name" in item) ||
      typeof item.name !== "string"
    ) {
      return [];
    }
    path.push({ id: item.id, name: item.name });
  }

  return path;
}

function createDocumentBlockId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createEmptyDocument(): NoteDocument {
  return {
    version: 1,
    blocks: [
      {
        id: createDocumentBlockId(),
        type: "paragraph",
        content: "",
      },
    ],
  };
}

export function normalizeDocument(note: VideoNote): NoteDocument {
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
          id: createDocumentBlockId(),
          type: "paragraph",
          content: note.content,
        },
      ],
    };
  }

  return createEmptyDocument();
}

export function getListItems(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^(?:(?:[-*+•])\s+|\d+[.)]\s+)/, ""))
    .map((line) => line.trim())
    .filter(Boolean);
}

export function normalizeListContent(content: string): string {
  return getListItems(content).join("\n");
}

export function documentToPlainText(noteDocument: NoteDocument): string {
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

      if (block.type === "screenshot") {
        return typeof block.metadata?.timestamp_seconds === "number"
          ? `[Video screenshot at ${block.metadata.timestamp_seconds}s]`
          : "[Video screenshot]";
      }

      if (block.type === "url") {
        return block.content.trim() || block.metadata?.title || "[URL]";
      }

      if (block.type === "bullet_list") {
        const items = getListItems(block.content);
        return items.length > 0 ? items.map((item) => `• ${item}`).join("\n") : "";
      }

      if (block.type === "numbered_list") {
        const items = getListItems(block.content);
        return items.length > 0
          ? items.map((item, index) => `${index + 1}. ${item}`).join("\n")
          : "";
      }

      return block.content;
    })
    .filter(Boolean)
    .join("\n\n");
}
