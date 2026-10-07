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
  [key: string]: unknown;
  metadata?: {
    source?: "url" | "upload";
    url?: string;
    alt?: string;
    [key: string]: unknown;
  };
}

export interface NoteDocument {
  version: 1;
  blocks: NoteBlock[];
  [key: string]: unknown;
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

      return block.content;
    })
    .filter(Boolean)
    .join("\n\n");
}
