export interface SyncPreviewItem {
  operation_id: string;
  entity: "note" | "folder";
  record_uuid: string;
  destination_uuid: string;
  label: string;
  classification: "new" | "updated" | "synchronized" | "conflict";
  reason: string;
}

export interface SyncPreview {
  run_id: string;
  direction: "push" | "pull";
  counts: Record<SyncPreviewItem["classification"], number>;
  items: SyncPreviewItem[];
}

export interface SyncOperationResult {
  operation_id: string;
  entity: string;
  record_uuid: string;
  status: string;
  reason?: string;
  acknowledgment?: string;
}

export interface SyncRunResult {
  run_id: string;
  succeeded: number;
  failed: number;
  results: SyncOperationResult[];
}

export interface SyncBridgeStatus {
  configured: boolean;
  installation_id: string;
  last_successful_sync: string | null;
  history: Array<Record<string, unknown>>;
  indexing_jobs: Array<{
    note_uuid: string;
    status: string;
    attempts: number;
    last_error: string;
  }>;
}

export interface SyncConflict {
  id: number;
  entity: string;
  local_uuid: string;
  peer_uuid: string | null;
  reason: string;
  direction: "push" | "pull";
  local: unknown;
  incoming: unknown;
}

export interface SyncIdentityRecord {
  entity: "note" | "folder";
  record_uuid: string;
  label: string;
  deleted: boolean;
  needs_repair: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIdentityRecord(value: unknown): SyncIdentityRecord {
  if (
    !isRecord(value) ||
    (value.entity !== "note" && value.entity !== "folder") ||
    typeof value.record_uuid !== "string" ||
    typeof value.label !== "string" ||
    typeof value.deleted !== "boolean" ||
    typeof value.needs_repair !== "boolean"
  ) {
    throw new Error("The Notes Bridge returned an invalid identity record.");
  }
  return {
    entity: value.entity,
    record_uuid: value.record_uuid,
    label: value.label,
    deleted: value.deleted,
    needs_repair: value.needs_repair,
  };
}

function runtimeRequest(
  method: "GET" | "POST",
  path: string,
  data?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) {
      reject(new Error("Open this page from the YouTube Knowledge extension."));
      return;
    }

    chrome.runtime.sendMessage(
      { type: "SYNC_BRIDGE_REQUEST", method, path, ...(data ? { data } : {}) },
      (response: unknown) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || "Extension request failed."));
          return;
        }
        if (
          !isRecord(response) ||
          typeof response.success !== "boolean" ||
          !isRecord(response.data)
        ) {
          reject(new Error("The Notes Bridge returned an invalid response."));
          return;
        }
        if (!response.success) {
          const detail = response.data.detail;
          reject(
            new Error(
              typeof detail === "string"
                ? detail
                : `Notes Bridge request failed (${String(response.status)}).`,
            ),
          );
          return;
        }
        resolve(response.data);
      },
    );
  });
}

function parsePreview(value: Record<string, unknown>): SyncPreview {
  const counts = value.counts;
  if (
    typeof value.run_id !== "string" ||
    (value.direction !== "push" && value.direction !== "pull") ||
    !isRecord(counts) ||
    !Array.isArray(value.items)
  ) {
    throw new Error("The Notes Bridge returned an invalid preview.");
  }
  const items = value.items.map((item): SyncPreviewItem => {
    if (
      !isRecord(item) ||
      typeof item.operation_id !== "string" ||
      (item.entity !== "note" && item.entity !== "folder") ||
      typeof item.record_uuid !== "string" ||
      typeof item.destination_uuid !== "string" ||
      typeof item.label !== "string" ||
      !["new", "updated", "synchronized", "conflict"].includes(
        String(item.classification),
      ) ||
      typeof item.reason !== "string"
    ) {
      throw new Error("The Notes Bridge returned an invalid preview item.");
    }
    const classification = item.classification;
    if (
      classification !== "new" &&
      classification !== "updated" &&
      classification !== "synchronized" &&
      classification !== "conflict"
    ) {
      throw new Error("The Notes Bridge returned an unsupported preview classification.");
    }
    return {
      operation_id: item.operation_id,
      entity: item.entity,
      record_uuid: item.record_uuid,
      destination_uuid: item.destination_uuid,
      label: item.label,
      classification,
      reason: item.reason,
    };
  });
  const count = (key: SyncPreviewItem["classification"]) =>
    typeof counts[key] === "number" ? counts[key] : 0;
  return {
    run_id: value.run_id,
    direction: value.direction,
    counts: {
      new: count("new"),
      updated: count("updated"),
      synchronized: count("synchronized"),
      conflict: count("conflict"),
    },
    items,
  };
}

export async function getSyncBridgeStatus(): Promise<SyncBridgeStatus> {
  const value = await runtimeRequest("GET", "/api/sync/v1/status/");
  if (
    typeof value.configured !== "boolean" ||
    typeof value.installation_id !== "string" ||
    !Array.isArray(value.history) ||
    !Array.isArray(value.indexing_jobs) ||
    (value.last_successful_sync !== null &&
      typeof value.last_successful_sync !== "string")
  ) {
    throw new Error("The Notes Bridge returned invalid status.");
  }
  const history = value.history.map((item) => {
    if (!isRecord(item)) throw new Error("The Notes Bridge returned invalid history.");
    return item;
  });
  const indexingJobs = value.indexing_jobs.map((job) => {
    if (
      !isRecord(job) ||
      typeof job.note_uuid !== "string" ||
      typeof job.status !== "string" ||
      typeof job.attempts !== "number" ||
      typeof job.last_error !== "string"
    ) {
      throw new Error("The Notes Bridge returned invalid indexing status.");
    }
    return {
      note_uuid: job.note_uuid,
      status: job.status,
      attempts: job.attempts,
      last_error: job.last_error,
    };
  });
  return {
    configured: value.configured,
    installation_id: value.installation_id,
    last_successful_sync: value.last_successful_sync,
    history,
    indexing_jobs: indexingJobs,
  };
}

export async function getSyncConflicts(): Promise<SyncConflict[]> {
  const value = await runtimeRequest("GET", "/api/sync/v1/conflicts/");
  if (!Array.isArray(value.conflicts)) {
    throw new Error("The Notes Bridge returned invalid conflict data.");
  }
  return value.conflicts.map((conflict): SyncConflict => {
    if (
      !isRecord(conflict) ||
      typeof conflict.id !== "number" ||
      typeof conflict.entity !== "string" ||
      typeof conflict.local_uuid !== "string" ||
      (conflict.peer_uuid !== null && typeof conflict.peer_uuid !== "string") ||
      typeof conflict.reason !== "string" ||
      (conflict.direction !== "push" && conflict.direction !== "pull")
    ) {
      throw new Error("The Notes Bridge returned an invalid conflict.");
    }
    return {
      id: conflict.id,
      entity: conflict.entity,
      local_uuid: conflict.local_uuid,
      peer_uuid: conflict.peer_uuid,
      reason: conflict.reason,
      direction: conflict.direction,
      local: conflict.local,
      incoming: conflict.incoming,
    };
  });
}

export async function getIdentityCandidates(): Promise<{
  ai: SyncIdentityRecord[];
  non_ai: SyncIdentityRecord[];
}> {
  const value = await runtimeRequest("GET", "/api/sync/v1/identities/");
  if (!Array.isArray(value.ai) || !Array.isArray(value.non_ai)) {
    throw new Error("The Notes Bridge returned invalid identity candidates.");
  }
  return {
    ai: value.ai.map(parseIdentityRecord),
    non_ai: value.non_ai.map(parseIdentityRecord),
  };
}

export async function previewSync(
  direction: "push" | "pull",
): Promise<SyncPreview> {
  return parsePreview(
    await runtimeRequest("POST", "/api/sync/v1/preview/", { direction }),
  );
}

export async function confirmSync(
  runId: string,
  operationIds: string[],
): Promise<SyncRunResult> {
  const value = await runtimeRequest(
    "POST",
    `/api/sync/v1/runs/${runId}/confirm/`,
    { operation_ids: operationIds },
  );
  if (
    typeof value.run_id !== "string" ||
    typeof value.succeeded !== "number" ||
    typeof value.failed !== "number" ||
    !Array.isArray(value.results)
  ) {
    throw new Error("The Notes Bridge returned invalid operation results.");
  }
  const results = value.results.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.operation_id !== "string" ||
      typeof item.entity !== "string" ||
      typeof item.record_uuid !== "string" ||
      typeof item.status !== "string"
    ) {
      throw new Error("The Notes Bridge returned an invalid operation result.");
    }
    return {
      operation_id: item.operation_id,
      entity: item.entity,
      record_uuid: item.record_uuid,
      status: item.status,
      ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
      ...(typeof item.acknowledgment === "string"
        ? { acknowledgment: item.acknowledgment }
        : {}),
    };
  });
  return {
    run_id: value.run_id,
    succeeded: value.succeeded,
    failed: value.failed,
    results,
  };
}

export async function retryAcknowledgments(runId: string): Promise<number> {
  const value = await runtimeRequest(
    "POST",
    `/api/sync/v1/runs/${runId}/retry-acknowledgments/`,
    {},
  );
  if (typeof value.attempted !== "number") {
    throw new Error("The Notes Bridge returned an invalid acknowledgment result.");
  }
  return value.attempted;
}

export async function retryIndexing(noteUuid?: string): Promise<number> {
  const value = await runtimeRequest("POST", "/api/sync/v1/indexing/", {
    ...(noteUuid ? { note_uuid: noteUuid } : {}),
  });
  if (typeof value.queued !== "number") {
    throw new Error("The Notes Bridge returned an invalid indexing result.");
  }
  return value.queued;
}

export async function reconcileIdentity(input: {
  direction: "push" | "pull";
  entity: "note" | "folder";
  localUuid: string;
  peerUuid: string;
  action: "pair" | "defer" | "separate";
}): Promise<void> {
  await runtimeRequest("POST", "/api/sync/v1/reconcile/", {
    direction: input.direction,
    entity: input.entity,
    local_uuid: input.localUuid,
    peer_uuid: input.peerUuid,
    action: input.action,
  });
}

export async function resolveSyncConflict(
  conflictId: number,
  choice: "keep_ai" | "keep_non_ai",
): Promise<void> {
  await runtimeRequest(
    "POST",
    `/api/sync/v1/conflicts/${conflictId}/resolve/`,
    { choice },
  );
}

export async function getSyncHistory(): Promise<Array<Record<string, unknown>>> {
  const value = await runtimeRequest("GET", "/api/sync/v1/history/");
  if (!Array.isArray(value.history)) {
    throw new Error("The Notes Bridge returned invalid history.");
  }
  return value.history.map((item) => {
    if (!isRecord(item)) throw new Error("The Notes Bridge returned an invalid history item.");
    return item;
  });
}
