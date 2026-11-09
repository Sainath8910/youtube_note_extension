import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowDownUp,
  Check,
  CircleCheck,
  Download,
  Radar,
  RefreshCw,
  Upload,
} from "lucide-react";
import {
  confirmSync,
  getSyncBridgeStatus,
  getSyncConflicts,
  getSyncHistory,
  getIdentityCandidates,
  previewSync,
  reconcileIdentity,
  retryAcknowledgments,
  retryIndexing,
  resolveSyncConflict,
  type SyncBridgeStatus,
  type SyncConflict,
  type SyncPreview,
  type SyncRunResult,
  type SyncIdentityRecord,
} from "./syncBridgeApi";

async function loadBridgeData() {
  const [status, conflicts, history] = await Promise.all([
    getSyncBridgeStatus(),
    getSyncConflicts(),
    getSyncHistory(),
  ]);
  const identityCandidates = status.configured
    ? await getIdentityCandidates()
    : { ai: [], non_ai: [] };
  return { status, conflicts, history, identityCandidates };
}

export function SyncBridgePage() {
  const [status, setStatus] = useState<SyncBridgeStatus | null>(null);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [history, setHistory] = useState<Array<Record<string, unknown>>>([]);
  const [identityCandidates, setIdentityCandidates] = useState<{
    ai: SyncIdentityRecord[];
    non_ai: SyncIdentityRecord[];
  }>({ ai: [], non_ai: [] });
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [result, setResult] = useState<SyncRunResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [mappingDirection, setMappingDirection] = useState<"push" | "pull">("push");
  const [mappingEntity, setMappingEntity] = useState<"note" | "folder">("note");
  const [aiUuid, setAiUuid] = useState("");
  const [peerUuid, setPeerUuid] = useState("");
  const [mappingAction, setMappingAction] = useState<"pair" | "defer" | "separate">("pair");

  const applyLoadedData = useCallback((data: Awaited<ReturnType<typeof loadBridgeData>>) => {
    setStatus(data.status);
    setConflicts(data.conflicts);
    setHistory(data.history);
    setIdentityCandidates(data.identityCandidates);
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      applyLoadedData(await loadBridgeData());
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not load Notes Bridge status.",
      );
    } finally {
      setBusy(false);
    }
  }, [applyLoadedData]);

  useEffect(() => {
    let active = true;
    void loadBridgeData().then((data) => {
      if (active) applyLoadedData(data);
    }).catch((requestError: unknown) => {
      if (active) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Could not load Notes Bridge status.",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [applyLoadedData]);

  const runPreview = async (direction: "push" | "pull") => {
    setBusy(true);
    setError("");
    setMessage("");
    setResult(null);
    try {
      const next = await previewSync(direction);
      setPreview(next);
      setSelected(new Set(
        next.items
          .filter((item) => item.classification === "new" || item.classification === "updated")
          .map((item) => item.operation_id),
      ));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not preview synchronization.");
    } finally {
      setBusy(false);
    }
  };

  const submitOperations = async (operationIds: string[]) => {
    if (!preview || operationIds.length === 0) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await confirmSync(preview.run_id, operationIds);
      setResult(response);
      setMessage(
        `${response.succeeded} operation(s) succeeded; ${response.failed} need attention.`,
      );
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Synchronization failed.");
    } finally {
      setBusy(false);
    }
  };

  const submitMapping = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await reconcileIdentity({
        direction: mappingDirection,
        entity: mappingEntity,
        localUuid: aiUuid.trim(),
        peerUuid: peerUuid.trim(),
        action: mappingAction,
      });
      setMessage("The identity decision was recorded on both backends.");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not record the identity decision.");
    } finally {
      setBusy(false);
    }
  };

  const retryIndexingJobs = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const queued = await retryIndexing();
      setMessage(`${queued} failed indexing job(s) queued for retry.`);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not retry indexing.");
    } finally {
      setBusy(false);
    }
  };

  const retryPendingAcknowledgments = async (runId: string) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const attempted = await retryAcknowledgments(runId);
      setMessage(`${attempted} peer acknowledgment(s) confirmed.`);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not retry peer acknowledgment.");
    } finally {
      setBusy(false);
    }
  };

  const resolveConflict = async (conflict: SyncConflict, choice: "keep_ai" | "keep_non_ai") => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await resolveSyncConflict(conflict.id, choice);
      setMessage(`Conflict resolved using the ${choice === "keep_ai" ? "AI" : "Non-AI"} version.`);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not resolve the conflict.");
    } finally {
      setBusy(false);
    }
  };

  const eligible = preview?.items.filter(
    (item) => item.classification === "new" || item.classification === "updated",
  ) ?? [];
  const aiCandidates = identityCandidates.ai.filter(
    (item) => item.entity === mappingEntity && !item.deleted && !item.needs_repair,
  );
  const peerCandidates = identityCandidates.non_ai.filter(
    (item) => item.entity === mappingEntity && !item.deleted && !item.needs_repair,
  );
  const failedOperationIds = result?.results
    .filter((operation) => operation.status === "failed" || operation.acknowledgment === "pending")
    .map((operation) => operation.operation_id) ?? [];

  return (
    <div className="sync-bridge-page">
      {error && (
        <div className="sync-bridge-alert is-error" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {message && <p className="sync-bridge-alert is-success" role="status">{message}</p>}

      <section className={`content-card sync-bridge-card sync-bridge-connection ${
        status?.configured ? "is-connected" : "is-searching"
      }`}>
        <div className="sync-bridge-section-heading">
          <div>
            <h2><ArrowDownUp size={19} aria-hidden="true" /> Connection</h2>
            <p>
              PUSH copies AI notes and folders to Non-AI. PULL copies Non-AI
              notes and folders to AI. Video notes include video details,
              transcripts, and your watch position; AI analysis stays local.
              Both backends verify your account.
            </p>
          </div>
          <button className="workspace-secondary-button" type="button" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw size={16} aria-hidden="true" /> Refresh
          </button>
        </div>
        <div
          className={`sync-bridge-status ${status?.configured ? "is-ready" : "is-waiting"}`}
          role="status"
          aria-live="polite"
        >
          <span className="sync-bridge-status-icon" aria-hidden="true">
            {status?.configured ? <CircleCheck size={21} /> : <Radar size={21} />}
          </span>
          <span>
            <strong>
              {status?.configured
                ? "Peer connection configured"
                : status
                  ? "Waiting for peer configuration"
                  : "Checking peer configuration"}
            </strong>
            <small>
              {status?.configured
                ? "The AI backend is ready to contact the Non-AI backend."
                : "Set the peer URL, shared secret, and reciprocal installation IDs in the backend environments."}
            </small>
          </span>
        </div>
        <div className="sync-bridge-actions">
          <button className="workspace-save-button" type="button" disabled={busy || !status?.configured} onClick={() => void runPreview("push")}>
            <Upload size={16} aria-hidden="true" /> Preview PUSH
          </button>
          <button className="workspace-save-button" type="button" disabled={busy || !status?.configured} onClick={() => void runPreview("pull")}>
            <Download size={16} aria-hidden="true" /> Preview PULL
          </button>
        </div>
        <p className="sync-bridge-note">
          Every preview is read-only. Transfers require explicit selection.
          Conflicts are never overwritten automatically. Existing synchronization
          UUIDs are preserved. Video details travel with selected video notes;
          the Video catalogue is not transferred separately.
        </p>
      </section>

      {preview && (
        <section className="content-card sync-bridge-card">
          <div className="sync-bridge-section-heading">
            <div>
              <h2>
                {preview.direction === "push"
                  ? <><Upload size={18} aria-hidden="true" /> PUSH preview</>
                  : <><Download size={18} aria-hidden="true" /> PULL preview</>}
              </h2>
              <p>
                {preview.counts.new} new · {preview.counts.updated} updated ·{" "}
                {preview.counts.synchronized} already synchronized ·{" "}
                {preview.counts.conflict} conflict(s)
              </p>
            </div>
            <label className="sync-bridge-select-all">
              <input
                type="checkbox"
                checked={eligible.length > 0 && eligible.every((item) => selected.has(item.operation_id))}
                onChange={(event) => setSelected(event.target.checked
                  ? new Set(eligible.map((item) => item.operation_id))
                  : new Set())}
                disabled={eligible.length === 0 || busy}
              />
              Select transferable
            </label>
          </div>
          <ul className="sync-bridge-list">
            {preview.items.map((item) => {
              const canTransfer = item.classification === "new" || item.classification === "updated";
              return (
                <li key={item.operation_id} className="sync-bridge-row">
                  {canTransfer ? (
                    <input
                      type="checkbox"
                      aria-label={`Select ${item.entity} ${item.label}`}
                      checked={selected.has(item.operation_id)}
                      onChange={(event) => setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(item.operation_id);
                        else next.delete(item.operation_id);
                        return next;
                      })}
                      disabled={busy}
                    />
                  ) : <span className="sync-bridge-row-indicator" aria-hidden="true" />}
                  <div className="sync-bridge-row-content">
                    <strong>{item.label}</strong>
                    <span>{item.entity} · {item.classification.replace("_", " ")}</span>
                    {item.reason && <small>{item.reason.replaceAll("_", " ")}</small>}
                  </div>
                  <code>{item.record_uuid}</code>
                </li>
              );
            })}
            {preview.items.length === 0 && <li className="sync-bridge-empty">No records were found.</li>}
          </ul>
          <div className="sync-bridge-actions">
            <button
              className="workspace-save-button"
              type="button"
              disabled={busy || selected.size === 0}
              onClick={() => void submitOperations([...selected])}
            >
              Confirm selected transfer(s)
            </button>
            {failedOperationIds.length > 0 && (
              <button
                className="workspace-secondary-button"
                type="button"
                disabled={busy}
                onClick={() => void submitOperations(failedOperationIds)}
              >
                Retry failed operations
              </button>
            )}
          </div>
        </section>
      )}

      {result && (
        <section className="content-card sync-bridge-card" aria-live="polite">
          <h2 className="sync-bridge-card-title"><Check size={18} aria-hidden="true" /> Transfer results</h2>
          <ul className="sync-bridge-list">
            {result.results.map((operation) => (
              <li key={operation.operation_id} className="sync-bridge-row">
                {operation.status === "accepted" || operation.status === "already_applied"
                  ? <Check size={17} aria-label="Succeeded" />
                  : <AlertCircle size={17} aria-label="Needs attention" />}
                <div className="sync-bridge-row-content">
                  <strong>{operation.entity} {operation.record_uuid}</strong>
                  <span>{operation.status.replaceAll("_", " ")}</span>
                  {operation.reason && <small>{operation.reason.replaceAll("_", " ")}</small>}
                  {operation.acknowledgment === "pending" && <small>Peer acknowledgment pending · retry to confirm synchronization baseline</small>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="content-card sync-bridge-card">
        <div className="sync-bridge-section-heading">
          <div>
            <h2>Legacy identity mapping</h2>
            <p>
              Pair only records you have verified are the same. Pairing never
              changes either record&apos;s sync UUID; the decision is audited
              on both backends.
            </p>
          </div>
        </div>
        <div className="sync-bridge-mapping-form">
          <label>
            Direction
            <select value={mappingDirection} onChange={(event) => {
              if (event.target.value === "push" || event.target.value === "pull") {
                setMappingDirection(event.target.value);
              }
            }}>
              <option value="push">PUSH (AI to Non-AI)</option>
              <option value="pull">PULL (Non-AI to AI)</option>
            </select>
          </label>
          <label>
            Record type
            <select value={mappingEntity} onChange={(event) => {
              if (event.target.value === "note" || event.target.value === "folder") {
                setMappingEntity(event.target.value);
              }
            }}>
              <option value="note">Note</option>
              <option value="folder">Folder</option>
            </select>
          </label>
          <label>
            AI record
            <select value={aiUuid} onChange={(event) => setAiUuid(event.target.value)}>
              <option value="">Select verified AI record</option>
              {aiCandidates.map((item) => (
                <option key={item.record_uuid} value={item.record_uuid}>
                  {item.label} · {item.record_uuid}
                </option>
              ))}
            </select>
          </label>
          <label>
            Non-AI record
            <select value={peerUuid} onChange={(event) => setPeerUuid(event.target.value)}>
              <option value="">Select verified Non-AI record</option>
              {peerCandidates.map((item) => (
                <option key={item.record_uuid} value={item.record_uuid}>
                  {item.label} · {item.record_uuid}
                </option>
              ))}
            </select>
          </label>
          <label>
            Decision
            <select value={mappingAction} onChange={(event) => {
              if (
                event.target.value === "pair" ||
                event.target.value === "defer" ||
                event.target.value === "separate"
              ) {
                setMappingAction(event.target.value);
              }
            }}>
              <option value="pair">Pair verified records</option>
              <option value="defer">Defer decision</option>
              <option value="separate">Keep records separate</option>
            </select>
          </label>
          <button className="workspace-save-button" type="button" disabled={busy || !aiUuid.trim() || !peerUuid.trim()} onClick={() => void submitMapping()}>
            Record identity decision
          </button>
        </div>
      </section>

      <section className="content-card sync-bridge-card">
        <div className="sync-bridge-section-heading">
          <div>
            <h2><AlertCircle size={18} aria-hidden="true" /> Conflicts and repair</h2>
            <p>These records need review; no side was silently selected.</p>
          </div>
        </div>
        {conflicts.length === 0 ? (
          <p className="sync-bridge-empty">No unresolved conflicts.</p>
        ) : (
          <ul className="sync-bridge-list">
            {conflicts.map((conflict) => (
              <li className="sync-bridge-conflict" key={conflict.id}>
                <strong>{conflict.entity} · {conflict.reason.replaceAll("_", " ")}</strong>
                {conflict.reason === "destination_deleted" && (
                  <p>The destination has a deletion record. Choose the live version to restore it there.</p>
                )}
                <code>AI: {conflict.local_uuid} · Non-AI: {conflict.peer_uuid ?? "unmapped"}</code>
                <details>
                  <summary>Review snapshots</summary>
                  <pre>{JSON.stringify({ local: conflict.local, incoming: conflict.incoming }, null, 2)}</pre>
                </details>
                {conflict.peer_uuid && (
                  <div className="sync-bridge-actions">
                    <button className="workspace-secondary-button" type="button" disabled={busy} onClick={() => void resolveConflict(conflict, "keep_ai")}>
                      {conflict.reason === "destination_deleted" && conflict.direction === "push"
                        ? "Restore from AI to Non-AI"
                        : "Keep AI version"}
                    </button>
                    <button className="workspace-secondary-button" type="button" disabled={busy} onClick={() => void resolveConflict(conflict, "keep_non_ai")}>
                      {conflict.reason === "destination_deleted" && conflict.direction === "pull"
                        ? "Restore from Non-AI to AI"
                        : "Keep Non-AI version"}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="content-card sync-bridge-card">
        <div className="sync-bridge-section-heading">
          <div>
            <h2><RefreshCw size={18} aria-hidden="true" /> AI indexing recovery</h2>
            <p>Indexing is separate from transfer success. Failed jobs can be retried.</p>
          </div>
          <button className="workspace-secondary-button" type="button" disabled={busy} onClick={() => void retryIndexingJobs()}>
            Retry failed indexing jobs
          </button>
        </div>
        {status?.indexing_jobs.length ? (
          <ul className="sync-bridge-list">
            {status.indexing_jobs.map((job) => (
              <li className="sync-bridge-row" key={job.note_uuid}>
                <span className="sync-bridge-row-indicator" />
                <div className="sync-bridge-row-content">
                  <strong>{job.status} · attempt {job.attempts}</strong>
                  <code>{job.note_uuid}</code>
                  {job.last_error && <small>{job.last_error}</small>}
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="sync-bridge-empty">No pending indexing jobs.</p>}
      </section>

      <section className="content-card sync-bridge-card">
        <h2 className="sync-bridge-card-title"><ArrowDownUp size={18} aria-hidden="true" /> Recent sync history</h2>
        {history.length === 0 ? <p className="sync-bridge-empty">No sync operations yet.</p> : (
          <ul className="sync-bridge-list">
            {history.slice(0, 20).map((entry, index) => {
              const runId = typeof entry.run_id === "string" ? entry.run_id : null;
              return (
                <li className="sync-bridge-row" key={runId ?? index}>
                  <span className="sync-bridge-row-indicator" />
                  <div className="sync-bridge-row-content">
                    <strong>{String(entry.direction ?? "sync").toUpperCase()} · {String(entry.status ?? "unknown")}</strong>
                    <small>{String(entry.created_at ?? "")}</small>
                    {runId && hasPendingAcknowledgment(entry.result) && (
                      <button className="workspace-secondary-button" type="button" disabled={busy} onClick={() => void retryPendingAcknowledgments(runId)}>
                        Retry peer acknowledgment
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function hasPendingAcknowledgment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const result = value;
  if (Array.isArray(result.results)) {
    return result.results.some((item) =>
      isRecord(item) && item.acknowledgment === "pending",
    );
  }
  return isRecord(result.result) && result.result.acknowledgment === "pending";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
