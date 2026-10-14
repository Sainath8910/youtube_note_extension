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
  | "table"
  | "checklist"
  | "screenshot";

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

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
    table_rows?: string[][];
    checklist_items?: ChecklistItem[];
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

export function getTableRows(block: NoteBlock): string[][] {
  const rows = block.metadata?.table_rows;
  if (!Array.isArray(rows) || rows.length === 0) return [];

  return rows.map((row) =>
    Array.isArray(row)
      ? row.map((cell) => (typeof cell === "string" ? cell : ""))
      : [],
  );
}

export function getChecklistItems(block: NoteBlock): ChecklistItem[] {
  const items = block.metadata?.checklist_items;
  if (!Array.isArray(items)) return [];

  return items.flatMap((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return [];
    }
    if (
      typeof item.text !== "string" ||
      typeof item.checked !== "boolean"
    ) {
      return [];
    }
    return [{
      id: typeof item.id === "string" ? item.id : `checklist-item-${index}`,
      text: item.text,
      checked: item.checked,
    }];
  });
}

export function hasMeaningfulBlockContent(block: NoteBlock): boolean {
  if (block.type === "image" || block.type === "screenshot") {
    return true;
  }

  if (block.type === "table") {
    return getTableRows(block).length > 0;
  }

  if (block.type === "checklist") {
    return getChecklistItems(block).length > 0;
  }

  if (block.type === "bullet_list" || block.type === "numbered_list") {
    return getListItems(block.content).length > 0;
  }

  if (block.type === "url") {
    const text = block.content.trim();
    const title = typeof block.metadata?.title === "string"
      ? block.metadata.title.trim()
      : "";
    const description = typeof block.metadata?.description === "string"
      ? block.metadata.description.trim()
      : "";
    return text.length > 0 || title.length > 0 || description.length > 0;
  }

  return block.content.trim().length > 0;
}

export function documentToPlainText(noteDocument: NoteDocument): string {
  return noteDocument.blocks
    .filter(hasMeaningfulBlockContent)
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
        return items.map((item) => `• ${item}`).join("\n");
      }

      if (block.type === "numbered_list") {
        const items = getListItems(block.content);
        return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
      }

      if (block.type === "table") {
        return getTableRows(block)
          .map((row) => `| ${row.join(" | ")} |`)
          .join("\n");
      }

      if (block.type === "checklist") {
        return getChecklistItems(block)
          .map((item) => `${item.checked ? "[x]" : "[ ]"} ${item.text}`)
          .join("\n");
      }

      return block.content;
    })
    .filter(Boolean)
    .join("\n\n");
}
