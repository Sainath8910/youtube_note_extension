export interface NoteAssistanceProposal {
  note_id: number;
  base_updated_at: string;
  target: {
    kind: "block";
    block_id: string;
  };
  operation: "improve";
  result: {
    text: string;
  };
}

export class NoteAssistanceApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "NoteAssistanceApiError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProposal(
  value: unknown,
  expected: {
    noteId: number;
    blockId: string;
    baseUpdatedAt: string;
  },
): NoteAssistanceProposal {
  if (
    !isObject(value) ||
    typeof value.note_id !== "number" ||
    !Number.isSafeInteger(value.note_id) ||
    value.note_id < 1 ||
    value.note_id !== expected.noteId ||
    typeof value.base_updated_at !== "string" ||
    !Number.isFinite(Date.parse(value.base_updated_at)) ||
    Date.parse(value.base_updated_at) !== Date.parse(expected.baseUpdatedAt) ||
    !isObject(value.target) ||
    value.target.kind !== "block" ||
    value.target.block_id !== expected.blockId ||
    value.operation !== "improve" ||
    !isObject(value.result) ||
    typeof value.result.text !== "string" ||
    !value.result.text.trim()
  ) {
    throw new Error("The note assistance service returned an invalid proposal.");
  }

  return {
    note_id: value.note_id,
    base_updated_at: value.base_updated_at,
    target: {
      kind: "block",
      block_id: value.target.block_id,
    },
    operation: "improve",
    result: { text: value.result.text },
  };
}

function responseErrorMessage(status: number): string {
  if (status === 400) {
    return "This block cannot be improved. Review the note and try again.";
  }
  if (status === 404) {
    return "This note is unavailable.";
  }
  if (status === 409) {
    return "This note changed. Refresh the note and try again.";
  }
  if (status === 502 || status >= 500) {
    return "AI generation failed. Please try again.";
  }
  if (status === 0) {
    return "Could not reach the note assistance service.";
  }
  return "The note assistance request failed. Please try again.";
}

export async function requestNoteImprovement(
  noteId: number,
  blockId: string,
  baseUpdatedAt: string,
): Promise<NoteAssistanceProposal> {
  const response = await new Promise<{ status: number; data: unknown }>(
    (resolve, reject) => {
      if (typeof chrome === "undefined" || !chrome.runtime?.id) {
        reject(
          new NoteAssistanceApiError(
            "Open this workspace from the YouTube Knowledge browser extension.",
            0,
          ),
        );
        return;
      }

      chrome.runtime.sendMessage(
        {
          type: "REQUEST_NOTE_ASSISTANCE",
          noteId,
          operation: "improve",
          target: { kind: "block", block_id: blockId },
          base_updated_at: baseUpdatedAt,
        },
        (messageResponse: unknown) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(
              new NoteAssistanceApiError(
                "Could not reach the note assistance service.",
                0,
              ),
            );
            return;
          }
          if (
            !isObject(messageResponse) ||
            typeof messageResponse.success !== "boolean" ||
            typeof messageResponse.status !== "number"
          ) {
            reject(
              new Error("The note assistance service returned an invalid response."),
            );
            return;
          }
          if (!messageResponse.success) {
            reject(
              new NoteAssistanceApiError(
                responseErrorMessage(messageResponse.status),
                messageResponse.status,
              ),
            );
            return;
          }
          resolve({
            status: messageResponse.status,
            data: messageResponse.data,
          });
        },
      );
    },
  );

  return parseProposal(response.data, { noteId, blockId, baseUpdatedAt });
}
