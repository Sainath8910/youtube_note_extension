import type { AskRAGScope } from "./ragApi";

export type ConversationScope = AskRAGScope;
export type ConversationRole = "USER" | "ASSISTANT";

export interface Conversation {
  id: number;
  title: string;
  scope: ConversationScope;
  youtube_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationSource {
  chunk_id: number;
  content: string;
  note_id: number | null;
  video_id: number | null;
  folder_id: number | null;
  source_block_id: string | null;
  chunk_index: number;
  metadata: Record<string, unknown>;
  youtube_id?: string;
}

export interface ConversationMessage {
  id: number;
  role: ConversationRole;
  content: string;
  sources: ConversationSource[];
  created_at: string;
}

export interface ConversationDetail extends Conversation {
  messages: ConversationMessage[];
}

export interface ConversationTurn {
  conversation: Conversation;
  user_message: ConversationMessage;
  assistant_message: ConversationMessage;
}

export class ConversationApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "ConversationApiError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableInteger(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function isConversationScope(value: unknown): value is ConversationScope {
  return (
    value === "CURRENT_VIDEO" ||
    value === "PERSONAL_KB" ||
    value === "COMBINED"
  );
}

function isConversation(value: unknown): value is Conversation {
  return (
    isObject(value) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    typeof value.title === "string" &&
    isConversationScope(value.scope) &&
    (value.youtube_id === null || typeof value.youtube_id === "string") &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isConversationSource(value: unknown): value is ConversationSource {
  if (!isObject(value)) return false;
  const hasYoutubeId =
    value.youtube_id === undefined ||
    (typeof value.youtube_id === "string" &&
      /^[A-Za-z0-9_-]{11}$/.test(value.youtube_id));
  return (
    typeof value.chunk_id === "number" &&
    Number.isSafeInteger(value.chunk_id) &&
    typeof value.content === "string" &&
    isNullableInteger(value.note_id) &&
    isNullableInteger(value.video_id) &&
    isNullableInteger(value.folder_id) &&
    (value.source_block_id === null ||
      typeof value.source_block_id === "string") &&
    typeof value.chunk_index === "number" &&
    Number.isSafeInteger(value.chunk_index) &&
    isObject(value.metadata) &&
    hasYoutubeId
  );
}

function isConversationMessage(
  value: unknown,
): value is ConversationMessage {
  return (
    isObject(value) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    (value.role === "USER" || value.role === "ASSISTANT") &&
    typeof value.content === "string" &&
    Array.isArray(value.sources) &&
    value.sources.every(isConversationSource) &&
    typeof value.created_at === "string"
  );
}

function parseConversation(value: unknown): Conversation {
  if (!isConversation(value)) {
    throw new Error("The Conversations service returned invalid metadata.");
  }
  return value;
}

function parseConversationMessage(value: unknown): ConversationMessage {
  if (!isConversationMessage(value)) {
    throw new Error("The Conversations service returned an invalid message.");
  }
  return value;
}

function parseConversationDetail(value: unknown): ConversationDetail {
  if (!isObject(value) || !Array.isArray(value.messages)) {
    throw new Error("The Conversations service returned an invalid conversation.");
  }
  const conversation = parseConversation(value);
  if (!value.messages.every(isConversationMessage)) {
    throw new Error("The Conversations service returned invalid messages.");
  }
  return { ...conversation, messages: value.messages };
}

function responseErrorMessage(data: unknown, status: number): string {
  if (isObject(data) && typeof data.detail === "string") return data.detail;
  return `The Conversations service request failed (${status}).`;
}

function sendConversationMessage(
  message: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) {
      reject(
        new Error(
          "Open this workspace from the YouTube Knowledge browser extension.",
        ),
      );
      return;
    }

    chrome.runtime.sendMessage(message, (response: unknown) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(
          new ConversationApiError(
            runtimeError.message || "Could not reach the Conversations service.",
            0,
          ),
        );
        return;
      }
      if (
        !isObject(response) ||
        typeof response.success !== "boolean" ||
        typeof response.status !== "number"
      ) {
        reject(new Error("The Conversations service returned an invalid response."));
        return;
      }
      if (!response.success) {
        reject(
          new ConversationApiError(
            responseErrorMessage(response.data, response.status),
            response.status,
          ),
        );
        return;
      }
      resolve({ status: response.status, data: response.data });
    });
  });
}

export async function listConversations(): Promise<Conversation[]> {
  const response = await sendConversationMessage({
    type: "LIST_CONVERSATIONS",
  });
  if (!Array.isArray(response.data) || !response.data.every(isConversation)) {
    throw new Error("The Conversations service returned an invalid list.");
  }
  return response.data;
}

export async function createConversation(data: {
  title: string;
  scope: ConversationScope;
  youtube_id: string | null;
}): Promise<Conversation> {
  const response = await sendConversationMessage({
    type: "CREATE_CONVERSATION",
    data,
  });
  return parseConversation(response.data);
}

export async function getConversation(
  conversationId: number,
): Promise<ConversationDetail> {
  const response = await sendConversationMessage({
    type: "GET_CONVERSATION",
    conversationId,
  });
  return parseConversationDetail(response.data);
}

export async function askConversation(
  conversationId: number,
  question: string,
): Promise<ConversationTurn> {
  const response = await sendConversationMessage({
    type: "ASK_CONVERSATION",
    conversationId,
    question,
  });
  if (
    !isObject(response.data) ||
    !isConversation(response.data.conversation)
  ) {
    throw new Error("The Conversations service returned an invalid answer.");
  }
  return {
    conversation: response.data.conversation,
    user_message: parseConversationMessage(response.data.user_message),
    assistant_message: parseConversationMessage(
      response.data.assistant_message,
    ),
  };
}

export async function renameConversation(
  conversationId: number,
  title: string,
): Promise<Conversation> {
  const response = await sendConversationMessage({
    type: "RENAME_CONVERSATION",
    conversationId,
    title,
  });
  return parseConversation(response.data);
}

export async function deleteConversation(
  conversationId: number,
): Promise<void> {
  await sendConversationMessage({
    type: "DELETE_CONVERSATION",
    conversationId,
  });
}
