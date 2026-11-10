import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowDownUp,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Check,
  CircleCheck,
  Download,
  Link2,
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

function formatSyncDate(value: string | null): string {
  if (!value) return "No completed sync yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
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
  const [mappingEntity, setMappingEntity] = useState<"note" | "folder" | "playlist">("note");
  const [aiUuid, setAiUuid] = useState("");
  const [peerUuid, setPeerUuid] = useState("");
  const [mappingAction, setMappingAction] = useState<"pair" | "defer" | "separate">("pair");
  const [selectedConflictId, setSelectedConflictId] = useState<number | null>(null);

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
      setSelectedConflictId(null);
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
  const lastSyncLabel = formatSyncDate(status?.last_successful_sync ?? null);
  const selectedConflict = conflicts.find(
    (conflict) => conflict.id === selectedConflictId,
  );

  if (selectedConflict) {
    return (
      <ConflictDetailPage
        key={selectedConflict.id}
        conflict={selectedConflict}
        busy={busy}
        onBack={() => setSelectedConflictId(null)}
        onResolve={(choice) => void resolveConflict(selectedConflict, choice)}
      />
    );
  }

  return (
    <div className="sync-bridge-page">
      <header className="sync-bridge-hero">
        <div className="sync-bridge-hero-icon" aria-hidden="true">
          <Link2 size={22} />
        </div>
        <div className="sync-bridge-hero-copy">
          <p className="sync-bridge-eyebrow">ACCOUNT CONNECTION</p>
          <h1>Notes Bridge</h1>
          <p>Keep your AI and Non-AI workspaces paired, and choose exactly what to transfer.</p>
        </div>
        <span className={`sync-bridge-connection-badge ${
          status?.configured ? "is-connected" : status ? "is-disconnected" : ""
        }`}>
          <span aria-hidden="true" />
          {status?.configured ? "Pairing saved" : status ? "Setup needed" : "Checking"}
        </span>
      </header>

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
        <div className="sync-bridge-connection-heading">
          <div className="sync-bridge-connection-icon" aria-hidden="true">
            {status?.configured ? <CircleCheck size={22} /> : <Radar size={22} />}
          </div>
          <div className="sync-bridge-connection-copy">
            <p className="sync-bridge-eyebrow">PERSISTENT PAIRING</p>
            <h2>
              {status?.configured
                ? "Your workspaces are paired"
                : status
                  ? "Pairing needs setup"
                  : "Checking your pairing"}
            </h2>
            <p>
              {status?.configured
                ? "The peer configuration is saved on the backend, so you do not need to pair again for each transfer. The peer is contacted when you start a preview."
                : status
                  ? "Configure the peer URL, shared secret, and reciprocal installation IDs in both backend environments. Keep the shared secret on the servers."
                  : "Checking whether the backend pairing is configured."}
            </p>
          </div>
          <button className="workspace-secondary-button" type="button" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw size={16} aria-hidden="true" /> Refresh
          </button>
        </div>
        <div className="sync-bridge-connection-meta">
          <span><strong>Last successful sync</strong>{lastSyncLabel}</span>
          <span><strong>Transfer mode</strong>Manual review and confirmation</span>
        </div>
        <div className="sync-bridge-directions">
          <article className="sync-bridge-direction-card">
            <span className="sync-bridge-direction-icon is-push"><Upload size={17} aria-hidden="true" /></span>
            <div>
              <h3>AI <ArrowRight size={14} aria-hidden="true" /> Non-AI</h3>
              <p>Review AI notes, folders, and playlists to send to your Non-AI workspace.</p>
            </div>
            <button className="workspace-save-button" type="button" disabled={busy || !status?.configured} onClick={() => void runPreview("push")}>
              Preview PUSH
            </button>
          </article>
          <article className="sync-bridge-direction-card">
            <span className="sync-bridge-direction-icon is-pull"><Download size={17} aria-hidden="true" /></span>
            <div>
              <h3>Non-AI <ArrowRight size={14} aria-hidden="true" /> AI</h3>
              <p>Review Non-AI notes, folders, and playlists to bring into your AI workspace.</p>
            </div>
            <button className="workspace-save-button" type="button" disabled={busy || !status?.configured} onClick={() => void runPreview("pull")}>
              Preview PULL
            </button>
          </article>
        </div>
        <div className="sync-bridge-flow-note">
          <strong>How a transfer works</strong>
          <span>Preview changes</span><ArrowRight size={14} aria-hidden="true" />
          <span>Select items</span><ArrowRight size={14} aria-hidden="true" />
          <span>Confirm transfer</span>
          <small>Nothing syncs automatically. Conflicts are never overwritten, and video details travel with selected video notes.</small>
        </div>
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
              if (event.target.value === "note" || event.target.value === "folder" || event.target.value === "playlist") {
                setMappingEntity(event.target.value);
              }
            }}>
              <option value="note">Note</option>
              <option value="folder">Folder</option>
              <option value="playlist">Playlist</option>
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
              <ConflictReviewCard
                key={conflict.id}
                conflict={conflict}
                onOpen={() => setSelectedConflictId(conflict.id)}
              />
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
            {history.slice(0, 5).map((entry, index) => {
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

function ConflictReviewCard({
  conflict,
  onOpen,
}: {
  conflict: SyncConflict;
  onOpen: () => void;
}) {
  const differences = snapshotDifferences(conflict.local, conflict.incoming);
  return (
    <li className="sync-bridge-conflict sync-bridge-conflict-summary">
      <button type="button" onClick={onOpen}>
        <span className="sync-bridge-conflict-summary-copy">
          <strong>{conflictTitle(conflict)}</strong>
          <small>{capitalize(conflict.entity)} · {humanize(conflict.reason)}</small>
        </span>
        <span className="sync-bridge-conflict-summary-meta">
          {differences.filter((difference) => difference.changed).length} differences
          <ChevronRight size={17} aria-hidden="true" />
        </span>
      </button>
    </li>
  );
}

function ConflictDetailPage({
  conflict,
  busy,
  onBack,
  onResolve,
}: {
  conflict: SyncConflict;
  busy: boolean;
  onBack: () => void;
  onResolve: (choice: "keep_ai" | "keep_non_ai") => void;
}) {
  const [selectedPath, setSelectedPath] = useState("");
  const [showUnchanged, setShowUnchanged] = useState(false);
  const differences = snapshotDifferences(conflict.local, conflict.incoming);
  const changedDifferences = differences.filter((difference) => difference.changed);
  const navigationDifferences = showUnchanged ? differences : changedDifferences;
  const selectedDifference =
    navigationDifferences.find((difference) => difference.path === selectedPath) ??
    navigationDifferences[0];

  return (
    <div className="sync-bridge-conflict-detail-page">
      <header className="sync-bridge-conflict-detail-header">
        <button className="workspace-back-button" type="button" onClick={onBack}>
          <ChevronLeft size={17} aria-hidden="true" />
          Back to conflicts
        </button>
        <div>
          <p className="sync-bridge-eyebrow">CONFLICT REVIEW</p>
          <h1>{conflictTitle(conflict)}</h1>
          <p>{capitalize(conflict.entity)} · {humanize(conflict.reason)}</p>
        </div>
        <span className="sync-bridge-conflict-count">
          {changedDifferences.length} differences
        </span>
      </header>

      {conflict.reason === "destination_deleted" && (
        <p className="sync-bridge-conflict-notice">
          The destination has a deletion record. Choosing the live version restores it there.
        </p>
      )}
      <div className="sync-bridge-conflict-identities">
        <span><strong>AI ID</strong><code>{conflict.local_uuid}</code></span>
        <span><strong>Non-AI ID</strong><code>{conflict.peer_uuid ?? "Not mapped"}</code></span>
      </div>

      <div className="sync-bridge-conflict-detail-layout">
        <aside className="sync-bridge-diff-sidebar" aria-label="Changed components">
          <div className="sync-bridge-diff-sidebar-heading">
            <h2>Changed components</h2>
            <button
              className="sync-bridge-diff-toggle"
              type="button"
              aria-pressed={showUnchanged}
              onClick={() => {
                setShowUnchanged((value) => !value);
                setSelectedPath("");
              }}
            >
              {showUnchanged ? "Changes only" : "Show all"}
            </button>
          </div>
          {navigationDifferences.length === 0 ? (
            <p className="sync-bridge-empty">
              {differences.length === 0
                ? "No snapshot fields are available to compare."
                : "No different fields found."}
            </p>
          ) : (
            <nav aria-label="Conflict fields">
              {navigationDifferences.map((difference) => (
                <button
                  className={selectedDifference?.path === difference.path ? "is-active" : ""}
                  type="button"
                  key={difference.path}
                  aria-current={selectedDifference?.path === difference.path ? "true" : undefined}
                  onClick={() => setSelectedPath(difference.path)}
                >
                  <span className="sync-bridge-diff-sidebar-status" aria-hidden="true" />
                  <span>{humanizePath(difference.path)}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              ))}
            </nav>
          )}
        </aside>

        <main className="sync-bridge-diff-detail">
          {selectedDifference ? (
            <section className="sync-bridge-diff">
              <div className="sync-bridge-diff-heading">
                <div>
                  <h2>{humanizePath(selectedDifference.path)}</h2>
                  <p>
                    {selectedDifference.changed
                      ? "Compare the value from each workspace before choosing which version to keep."
                      : "This field is the same in both workspaces."}
                  </p>
                </div>
                <span className={`sync-bridge-diff-status${selectedDifference.changed ? " is-changed" : ""}`}>
                  {selectedDifference.changed ? "Different" : "Same"}
                </span>
              </div>
              <div className="sync-bridge-diff-sides">
                <SnapshotSide
                  label="AI workspace"
                  value={selectedDifference.local}
                  present={selectedDifference.localPresent}
                  changed={selectedDifference.changed}
                />
                <SnapshotSide
                  label="Non-AI workspace"
                  value={selectedDifference.incoming}
                  present={selectedDifference.incomingPresent}
                  changed={selectedDifference.changed}
                />
              </div>
            </section>
          ) : (
            <section className="sync-bridge-diff-empty">
              <Check size={22} aria-hidden="true" />
              <h2>No field differences</h2>
              <p>The snapshots contain the same fields and values.</p>
            </section>
          )}
        </main>
      </div>

      {conflict.peer_uuid && (
        <div className="sync-bridge-actions sync-bridge-conflict-resolution-actions">
          <button
            className="workspace-secondary-button"
            type="button"
            disabled={busy}
            onClick={() => onResolve("keep_ai")}
          >
            {conflict.reason === "destination_deleted" && conflict.direction === "push"
              ? "Restore from AI to Non-AI"
              : "Keep AI version"}
          </button>
          <button
            className="workspace-secondary-button"
            type="button"
            disabled={busy}
            onClick={() => onResolve("keep_non_ai")}
          >
            {conflict.reason === "destination_deleted" && conflict.direction === "pull"
              ? "Restore from Non-AI to AI"
              : "Keep Non-AI version"}
          </button>
        </div>
      )}
    </div>
  );
}

function conflictTitle(conflict: SyncConflict): string {
  const local = isRecord(conflict.local) ? conflict.local : {};
  const incoming = isRecord(conflict.incoming) ? conflict.incoming : {};
  const title =
    [local.title, local.name, incoming.title, incoming.name].find(
      (value) => typeof value === "string" && value.trim(),
    );
  return typeof title === "string" ? title : `Untitled ${conflict.entity}`;
}

interface SnapshotDifference {
  path: string;
  local: unknown;
  incoming: unknown;
  localPresent: boolean;
  incomingPresent: boolean;
  changed: boolean;
}

function snapshotDifferences(
  local: unknown,
  incoming: unknown,
): SnapshotDifference[] {
  const differences: SnapshotDifference[] = [];
  const visit = (
    left: unknown,
    right: unknown,
    path: string,
    leftPresent: boolean,
    rightPresent: boolean,
  ) => {
    if (isRecord(left) && isRecord(right)) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      if (keys.length === 0 && path) {
        differences.push({
          path,
          local: left,
          incoming: right,
          localPresent: leftPresent,
          incomingPresent: rightPresent,
          changed: false,
        });
      }
      for (const key of keys) {
        visit(
          left[key],
          right[key],
          path ? `${path}.${key}` : key,
          Object.prototype.hasOwnProperty.call(left, key),
          Object.prototype.hasOwnProperty.call(right, key),
        );
      }
      return;
    }

    differences.push({
      path: path || "Record",
      local: left,
      incoming: right,
      localPresent: leftPresent,
      incomingPresent: rightPresent,
      changed:
        leftPresent !== rightPresent ||
        stableSnapshotValue(left) !== stableSnapshotValue(right),
    });
  };

  visit(local, incoming, "", local !== undefined, incoming !== undefined);
  return differences;
}

function stableSnapshotValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSnapshotValue).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSnapshotValue(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function SnapshotSide({
  label,
  value,
  present,
  changed,
}: {
  label: string;
  value: unknown;
  present: boolean;
  changed: boolean;
}) {
  return (
    <section className={`sync-bridge-diff-side${changed ? " is-changed" : ""}`}>
      <h5>{label}</h5>
      {present ? (
        <SnapshotValue value={value} />
      ) : (
        <span className="sync-bridge-diff-missing">Not present in this version</span>
      )}
    </section>
  );
}

function SnapshotValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="sync-bridge-value-empty">Not set</span>;
  }
  if (typeof value === "boolean") {
    return <span className="sync-bridge-value-boolean">{value ? "Yes" : "No"}</span>;
  }
  if (typeof value === "string" || typeof value === "number") {
    return (
      <p className="sync-bridge-value-text">
        {typeof value === "string" && value.length === 0 ? "Empty" : String(value)}
      </p>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="sync-bridge-value-empty">No items</span>;
    return <SnapshotArray items={value} />;
  }
  if (isNoteBlock(value)) {
    return <SnapshotNoteBlock block={value} />;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return <span className="sync-bridge-value-empty">No details</span>;
    return (
      <dl className="sync-bridge-value-object">
        {entries.map(([key, entry]) => (
          <div key={key}>
            <dt>{humanize(key)}</dt>
            <dd><SnapshotValue value={entry} /></dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span className="sync-bridge-value-empty">Unsupported value</span>;
}

function SnapshotArray({ items }: { items: unknown[] }) {
  const [open, setOpen] = useState(items.length <= 6);
  const list = (
    <ul className="sync-bridge-value-list">
      {items.map((item, index) => (
        <li key={index}><SnapshotValue value={item} /></li>
      ))}
    </ul>
  );
  if (items.length <= 6) return list;
  return (
    <details
      className="sync-bridge-value-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{items.length} items</summary>
      {open && list}
    </details>
  );
}

interface SnapshotNoteBlock {
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
}

function isNoteBlock(value: unknown): value is SnapshotNoteBlock {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    typeof value.content === "string" &&
    [
      "paragraph",
      "heading",
      "equation",
      "timestamp",
      "image",
      "url",
      "code",
      "command",
      "bullet_list",
      "numbered_list",
      "table",
      "checklist",
      "screenshot",
    ].includes(value.type)
  );
}

function SnapshotNoteBlock({ block }: { block: SnapshotNoteBlock }) {
  const metadata = isRecord(block.metadata) ? block.metadata : {};
  const checklist = Array.isArray(metadata.checklist_items)
    ? metadata.checklist_items.filter(
        (item): item is Record<string, unknown> =>
          isRecord(item) &&
          typeof item.text === "string" &&
          typeof item.checked === "boolean",
      )
    : [];
  const tableRows = Array.isArray(metadata.table_rows)
    ? metadata.table_rows.filter(
        (row): row is unknown[] =>
          Array.isArray(row) && row.every((cell) => typeof cell === "string"),
      )
    : [];
  const imageSource = noteBlockImageSource(block, metadata);
  const alt = typeof metadata.alt === "string" ? metadata.alt : "";

  if (block.type === "image" || block.type === "screenshot") {
    return imageSource ? (
      <figure className="sync-bridge-note-image">
        <img src={imageSource} alt={alt || (block.type === "screenshot" ? "Video screenshot" : "Note image")} loading="lazy" />
        {alt && <figcaption>{alt}</figcaption>}
      </figure>
    ) : (
      <p className="sync-bridge-value-text">
        {alt || block.content || "Image is not available in this snapshot."}
      </p>
    );
  }
  if (block.type === "checklist") {
    return checklist.length > 0 ? (
      <ul className="sync-bridge-note-checklist">
        {checklist.map((item, index) => (
          <li key={typeof item.id === "string" ? item.id : index}>
            <input type="checkbox" checked={item.checked === true} readOnly aria-label={item.checked ? "Completed" : "Not completed"} />
            <span>{String(item.text)}</span>
          </li>
        ))}
      </ul>
    ) : (
      <span className="sync-bridge-value-empty">No checklist items</span>
    );
  }
  if (block.type === "table") {
    return tableRows.length > 0 ? (
      <div className="sync-bridge-note-table-scroll">
        <table className="sync-bridge-note-table">
          {metadata.table_has_header === true && tableRows[0] && (
            <thead>
              <tr>{tableRows[0].map((cell, index) => <th key={index}>{String(cell)}</th>)}</tr>
            </thead>
          )}
          <tbody>
            {tableRows
              .slice(metadata.table_has_header === true ? 1 : 0)
              .map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => <td key={cellIndex}>{String(cell)}</td>)}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    ) : (
      <span className="sync-bridge-value-empty">No table rows</span>
    );
  }
  if (block.type === "bullet_list" || block.type === "numbered_list") {
    const items = block.content.split(/\r?\n/).map((line) =>
      line.replace(/^(?:(?:[-*+•])\s+|\d+[.)]\s+)/, "").trim(),
    ).filter(Boolean);
    const List = block.type === "bullet_list" ? "ul" : "ol";
    return items.length > 0 ? (
      <List className="sync-bridge-note-list">{items.map((item, index) => <li key={index}>{item}</li>)}</List>
    ) : <span className="sync-bridge-value-empty">Empty list</span>;
  }
  if (block.type === "url") {
    const href = safeHttpUrl(block.content || metadata.url);
    return href ? (
      <a className="sync-bridge-note-link" href={href} target="_blank" rel="noreferrer">
        {typeof metadata.title === "string" && metadata.title ? metadata.title : href}
      </a>
    ) : (
      <p className="sync-bridge-value-text">{block.content || "No link"}</p>
    );
  }
  if (block.type === "code" || block.type === "command" || block.type === "equation") {
    return <pre className="sync-bridge-note-code">{block.content || "Empty"}</pre>;
  }
  if (block.type === "heading") {
    return <h5 className="sync-bridge-note-heading">{block.content || "Empty heading"}</h5>;
  }
  return <p className="sync-bridge-value-text">{block.content || "Empty"}</p>;
}

function noteBlockImageSource(
  block: SnapshotNoteBlock,
  metadata: Record<string, unknown>,
): string {
  const candidate =
    typeof metadata.image === "string"
      ? metadata.image
      : typeof metadata.url === "string"
        ? metadata.url
        : block.content;
  if (candidate.startsWith("data:image/")) return candidate;
  return safeHttpUrl(candidate);
}

function safeHttpUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

function humanizePath(value: string): string {
  return value
    .replace(/\[(\d+)\]/g, " item $1")
    .split(".")
    .map(humanize)
    .join(" › ");
}

function capitalize(value: string): string {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
