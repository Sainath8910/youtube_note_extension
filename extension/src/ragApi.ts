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

export interface PreviousContextNote {
  note_id: number;
  title: string;
  content: string;
  source: "EXACT_VIDEO";
}

export interface PreviousContextRelatedItem {
  chunk_id: number;
  note_id: number;
  title: string;
  content: string;
  distance: number;
  source: "RELATED_PERSONAL";
}

export interface PreviousContextConceptTimestamp {
  seconds: number;
  text: string;
}

export interface PreviousContextConceptNote {
  chunk_id: number;
  note_id: number;
  title: string;
  content: string;
  distance: number;
  source: "RELATED_PERSONAL";
}

export interface PreviousContextConcept {
  name: string;
  type: "PREREQUISITE" | "UPCOMING";
  has_previous_knowledge: boolean;
  related_count: number;
  reason: string | null;
  evidence: string | null;
  timestamps: PreviousContextConceptTimestamp[];
  personal_notes: PreviousContextConceptNote[];
}

export interface PreviousContextData {
  video: {
    id: number;
    youtube_id: string;
  };
  exact: PreviousContextNote[];
  related: PreviousContextRelatedItem[];
  concepts: {
    prerequisites: PreviousContextConcept[];
    upcoming: PreviousContextConcept[];
  };
}

export interface PreviousContextResponse {
  success: boolean;
  status: number;
  data: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPreviousContextData(
  value: unknown,
): value is PreviousContextData {
  if (!isObject(value) || !isObject(value.video) || !isObject(value.concepts)) {
    return false;
  }
  const video = value.video;
  const concepts = value.concepts;
  const isConceptNote = (item: unknown): item is PreviousContextConceptNote =>
    isObject(item) &&
    typeof item.chunk_id === "number" &&
    typeof item.note_id === "number" &&
    typeof item.title === "string" &&
    typeof item.content === "string" &&
    typeof item.distance === "number" &&
    item.source === "RELATED_PERSONAL";

  const isConceptTimestamp = (
    item: unknown,
  ): item is PreviousContextConceptTimestamp =>
    isObject(item) &&
    typeof item.seconds === "number" &&
    Number.isFinite(item.seconds) &&
    item.seconds >= 0 &&
    typeof item.text === "string";

  const isConcept = (item: unknown): item is PreviousContextConcept =>
    isObject(item) &&
    typeof item.name === "string" &&
    (item.type === "PREREQUISITE" || item.type === "UPCOMING") &&
    typeof item.has_previous_knowledge === "boolean" &&
    typeof item.related_count === "number" &&
    Number.isInteger(item.related_count) &&
    item.related_count >= 0 &&
    (typeof item.reason === "string" || item.reason === null) &&
    (typeof item.evidence === "string" || item.evidence === null) &&
    Array.isArray(item.timestamps) &&
    item.timestamps.every(isConceptTimestamp) &&
    Array.isArray(item.personal_notes) &&
    item.personal_notes.every(isConceptNote);

  return (
    typeof video.id === "number" &&
    Number.isInteger(video.id) &&
    typeof video.youtube_id === "string" &&
    Array.isArray(value.exact) &&
    value.exact.every(
      (item) =>
        isObject(item) &&
        typeof item.note_id === "number" &&
        typeof item.title === "string" &&
        typeof item.content === "string" &&
        item.source === "EXACT_VIDEO",
    ) &&
    Array.isArray(value.related) &&
    value.related.every(
      (item) =>
        isObject(item) &&
        typeof item.chunk_id === "number" &&
        typeof item.note_id === "number" &&
        typeof item.title === "string" &&
        typeof item.content === "string" &&
        typeof item.distance === "number" &&
        item.source === "RELATED_PERSONAL",
    ) &&
    Array.isArray(concepts.prerequisites) &&
    concepts.prerequisites.every(isConcept) &&
    Array.isArray(concepts.upcoming) &&
    concepts.upcoming.every(isConcept)
  );
}

export type AskRAGScope = "CURRENT_VIDEO" | "PERSONAL_KB" | "COMBINED";

const previousContextRequests = new Map<
  string,
  {
    promise: Promise<PreviousContextResponse>;
    signal?: AbortSignal;
  }
>();

const PREVIOUS_CONTEXT_INITIAL_POLL_DELAY_MS = 500;
const PREVIOUS_CONTEXT_POLL_INTERVAL_MS = 1500;
// Forty polls bound one loading state to roughly one minute.
const PREVIOUS_CONTEXT_MAX_POLL_ATTEMPTS = 40;

function abortError(): DOMException {
  return new DOMException("Previous Context request was cancelled.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

function waitForNextPoll(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, timeoutMs);

    const cancel = () => {
      window.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", cancel);
      reject(abortError());
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

function sendPreviousContextMessage(
  message: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<PreviousContextResponse> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abortError());
    signal?.addEventListener("abort", cancel, { once: true });

    chrome.runtime.sendMessage(message, (response) => {
      signal?.removeEventListener("abort", cancel);
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      if (chrome.runtime.lastError) {
        reject(new Error("Previous Context could not be reached."));
        return;
      }
      if (
        !response ||
        typeof response.success !== "boolean" ||
        typeof response.status !== "number"
      ) {
        reject(new Error("Previous Context returned an invalid response."));
        return;
      }

      resolve({
        success: response.success,
        status: response.status,
        data: response.data,
      });
    });
  });
}

async function pollPreviousContextJob(
  videoId: string,
  signal?: AbortSignal,
): Promise<PreviousContextResponse> {
  const created = await sendPreviousContextMessage(
    {
      type: "CREATE_PREVIOUS_CONTEXT_JOB",
      videoId,
    },
    signal,
  );
  if (!created.success) {
    return created;
  }
  if (
    !isObject(created.data) ||
    typeof created.data.job_id !== "string" ||
    created.data.youtube_id !== videoId
  ) {
    return { success: false, status: created.status, data: null };
  }
  const jobId = created.data.job_id;

  for (let attempt = 0; attempt < PREVIOUS_CONTEXT_MAX_POLL_ATTEMPTS; attempt += 1) {
    await waitForNextPoll(
      attempt === 0
        ? PREVIOUS_CONTEXT_INITIAL_POLL_DELAY_MS
        : PREVIOUS_CONTEXT_POLL_INTERVAL_MS,
      signal,
    );
    const response = await sendPreviousContextMessage(
      {
        type: "GET_PREVIOUS_CONTEXT_JOB",
        jobId,
      },
      signal,
    );
    throwIfAborted(signal);
    if (!response.success) {
      return response;
    }
    if (
      !isObject(response.data) ||
      response.data.job_id !== jobId ||
      response.data.youtube_id !== videoId ||
      typeof response.data.status !== "string"
    ) {
      return { success: false, status: response.status, data: null };
    }

    const { status: jobStatus } = response.data;
    if (jobStatus === "READY") {
      return {
        success: true,
        status: response.status,
        data: response.data.result,
      };
    }
    if (jobStatus === "FAILED") {
      return {
        success: false,
        status: response.status,
        data: response.data.error,
      };
    }
    if (jobStatus !== "PENDING" && jobStatus !== "PROCESSING") {
      return { success: false, status: response.status, data: null };
    }
  }

  return { success: false, status: 408, data: null };
}

function waitForCallerOrSharedRequest(
  request: Promise<PreviousContextResponse>,
  signal?: AbortSignal,
): Promise<PreviousContextResponse> {
  if (!signal) {
    return request;
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abortError());
    signal.addEventListener("abort", cancel, { once: true });
    void request.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
}

export function sendPreviousContext(
  videoId: string,
  signal?: AbortSignal,
): Promise<PreviousContextResponse> {
  const activeRequest = previousContextRequests.get(videoId);
  if (activeRequest && !activeRequest.signal?.aborted) {
    return waitForCallerOrSharedRequest(activeRequest.promise, signal);
  }

  const request = pollPreviousContextJob(videoId, signal);
  const entry = { promise: request, signal };
  previousContextRequests.set(videoId, entry);
  void request.then(
    () => {
      if (previousContextRequests.get(videoId) === entry) {
        previousContextRequests.delete(videoId);
      }
    },
    () => {
      if (previousContextRequests.get(videoId) === entry) {
        previousContextRequests.delete(videoId);
      }
    },
  );
  return request;
}

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
