import { useEffect, useState } from "react";
import {
  AlertCircle,
  Clapperboard,
  FileText,
  Folder,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  listDashboardTrash,
  restoreDashboardTrash,
  type DashboardTrashItem,
} from "./folderApi";
import "./dashboard.css";

type TrashState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: DashboardTrashItem[] };

function formatTrashDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
}

export function TrashPage() {
  const [state, setState] = useState<TrashState>({ status: "loading" });
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [error, setError] = useState("");

  const refresh = async () => {
    setState({ status: "loading" });
    setError("");
    try {
      setState({ status: "ready", items: await listDashboardTrash() });
    } catch (requestError) {
      setState({
        status: "error",
        message: requestError instanceof Error ? requestError.message : "Could not load Trash.",
      });
    }
  };

  useEffect(() => {
    let active = true;
    listDashboardTrash()
      .then((items) => {
        if (active) setState({ status: "ready", items });
      })
      .catch((requestError: unknown) => {
        if (active) {
          setState({
            status: "error",
            message: requestError instanceof Error
              ? requestError.message
              : "Could not load Trash.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const restore = async (item: DashboardTrashItem) => {
    const key = `${item.entity}:${item.id}`;
    setBusyItem(key);
    setError("");
    try {
      await restoreDashboardTrash(item.entity, item.id);
      setState((current) => current.status === "ready"
        ? { status: "ready", items: current.items.filter((row) => row.entity !== item.entity || row.id !== item.id) }
        : current);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not restore this item.");
    } finally {
      setBusyItem(null);
    }
  };

  return (
    <section className="content-card trash-page-card" aria-labelledby="trash-heading">
      <header className="trash-page-heading">
        <div>
          <span className="trash-page-icon"><Trash2 size={18} aria-hidden="true" /></span>
          <div>
            <h2 id="trash-heading">Trash</h2>
            <p>Notes and folders stay here for 30 days. Restoring a folder also restores its trashed subfolders and notes.</p>
          </div>
        </div>
        <button className="workspace-secondary-button" type="button" onClick={() => void refresh()} disabled={state.status === "loading"}>
          Refresh
        </button>
      </header>
      {error && <p className="trash-page-error" role="alert">{error}</p>}
      {state.status === "loading" ? (
        <p className="trash-page-empty" role="status">Loading Trash…</p>
      ) : state.status === "error" ? (
        <div className="trash-page-empty" role="alert">
          <AlertCircle size={20} aria-hidden="true" />
          <p>{state.message}</p>
          <button className="workspace-secondary-button" type="button" onClick={() => void refresh()}>Try again</button>
        </div>
      ) : state.items.length === 0 ? (
        <p className="trash-page-empty">Trash is empty.</p>
      ) : (
        <ul className="trash-page-list">
          {state.items.map((item) => {
            const key = `${item.entity}:${item.id}`;
            const Icon = item.entity === "folder" ? Folder : item.note_type === "VIDEO" ? Clapperboard : FileText;
            return (
              <li className="trash-page-item" key={key}>
                <Icon size={18} aria-hidden="true" />
                <div className="trash-page-copy">
                  <strong>{item.title || (item.entity === "folder" ? "Untitled folder" : "Untitled note")}</strong>
                  <span>{item.entity === "folder" ? "Folder and its contents" : item.note_type === "VIDEO" ? `Video note${item.video_title ? ` · ${item.video_title}` : ""}` : "Standalone note"}</span>
                  <small>Deleted {formatTrashDate(item.deleted_at)} · Expires {formatTrashDate(item.expires_at)}</small>
                </div>
                <button className="workspace-secondary-button" type="button" disabled={busyItem !== null} onClick={() => void restore(item)}>
                  <RotateCcw size={14} aria-hidden="true" />
                  {busyItem === key ? "Restoring…" : "Restore"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
