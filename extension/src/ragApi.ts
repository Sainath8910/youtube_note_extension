export interface RAGSource {
  chunk_id: number;
  content: string;
  distance: number;
  note_id: number | null;
  video_id: number | null;
  folder_id: number | null;
  source_block_id: string | null;
  chunk_index: number;
  metadata: Record<string, unknown>;
}

export interface RAGAnswer {
  answer: string;
  sources: RAGSource[];
}

export interface AskRAGResponse {
  success: boolean;
  status: number;
  data: unknown;
}

export type AskRAGScope = "CURRENT_VIDEO" | "PERSONAL_KB" | "COMBINED";

export function sendAskRAG(
  question: string,
  scope: AskRAGScope,
  videoId: string,
): Promise<AskRAGResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "ASK_RAG",
        question,
        scope,
        videoId,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error("The AI service could not be reached."));
          return;
        }

        if (
          !response ||
          typeof response.success !== "boolean" ||
          typeof response.status !== "number"
        ) {
          reject(new Error("The AI service returned an invalid response."));
          return;
        }

        resolve({
          success: response.success,
          status: response.status,
          data: response.data,
        });
      },
    );
  });
}
