import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Clapperboard,
  FileText,
  Folder,
  ListVideo,
  Search,
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

type TrashTab = "all" | DashboardTrashItem["entity"];
type TrashSortOrder = "newest" | "oldest";
type TrashNoteFilter = "all" | "video" | "standalone";
const emptyTrashItems: DashboardTrashItem[] = [];

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
  const [activeTab, setActiveTab] = useState<TrashTab>("all");
  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState<TrashSortOrder>("newest");
  const [noteFilter, setNoteFilter] = useState<TrashNoteFilter>("all");

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

  const items = state.status === "ready" ? state.items : emptyTrashItems;
  const visibleItems = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    return items
      .filter((item) => activeTab === "all" || item.entity === activeTab)
      .filter((item) =>
        (activeTab !== "all" && activeTab !== "note") ||
        noteFilter === "all" ||
        (item.entity === "note" &&
          (noteFilter === "video"
            ? item.note_type === "VIDEO"
            : item.note_type === "STANDALONE")),
      )
      .filter((item) =>
        !normalizedSearch ||
        item.title.toLocaleLowerCase().includes(normalizedSearch) ||
        (item.video_title ?? "").toLocaleLowerCase().includes(normalizedSearch),
      )
      .sort((left, right) => {
        const difference =
          Date.parse(left.deleted_at) - Date.parse(right.deleted_at);
        return sortOrder === "newest" ? -difference : difference;
      });
  }, [activeTab, items, noteFilter, search, sortOrder]);
  const tabs: Array<{ id: TrashTab; label: string; count: number }> = [
    { id: "all", label: "All", count: items.length },
    { id: "note", label: "Notes", count: items.filter((item) => item.entity === "note").length },
    { id: "folder", label: "Folders", count: items.filter((item) => item.entity === "folder").length },
    { id: "playlist", label: "Playlists", count: items.filter((item) => item.entity === "playlist").length },
  ];

  return (
    <section className="content-card trash-page-card" aria-labelledby="trash-heading">
      <header className="trash-page-heading">
        <div>
          <span className="trash-page-icon"><Trash2 size={18} aria-hidden="true" /></span>
          <div>
            <h2 id="trash-heading">Trash</h2>
            <p>Deleted items stay here for 30 days. Deleting a folder keeps its notes in your Notes list.</p>
          </div>
        </div>
        <button className="workspace-secondary-button" type="button" onClick={() => void refresh()} disabled={state.status === "loading"}>
          Refresh
        </button>
      </header>
      {error && <p className="trash-page-error" role="alert">{error}</p>}
      <div className="trash-page-tabs" role="group" aria-label="Filter Trash by item type">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`trash-page-tab${activeTab === tab.id ? " is-active" : ""}`}
            type="button"
            aria-pressed={activeTab === tab.id}
            onClick={() => {
              setActiveTab(tab.id);
              if (tab.id === "folder" || tab.id === "playlist") {
                setNoteFilter("all");
              }
            }}
          >
            {tab.label}<span>{tab.count}</span>
          </button>
        ))}
      </div>
      <div className="trash-page-controls">
        <label className="trash-page-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search deleted items"
            placeholder="Search deleted items"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <select
          aria-label="Sort deleted items"
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value as TrashSortOrder)}
        >
          <option value="newest">Recently deleted</option>
          <option value="oldest">Oldest deleted</option>
        </select>
        {(activeTab === "all" || activeTab === "note") && (
          <select
            aria-label="Filter deleted notes"
            value={noteFilter}
            onChange={(event) => setNoteFilter(event.target.value as TrashNoteFilter)}
          >
            <option value="all">All note types</option>
            <option value="video">Video notes</option>
            <option value="standalone">Standalone notes</option>
          </select>
        )}
      </div>
      {state.status === "loading" ? (
        <p className="trash-page-empty" role="status">Loading Trash…</p>
      ) : state.status === "error" ? (
        <div className="trash-page-empty" role="alert">
          <AlertCircle size={20} aria-hidden="true" />
          <p>{state.message}</p>
          <button className="workspace-secondary-button" type="button" onClick={() => void refresh()}>Try again</button>
        </div>
      ) : visibleItems.length === 0 ? (
        <p className="trash-page-empty">
          {items.length === 0
            ? "Trash is empty."
            : search.trim() || noteFilter !== "all"
              ? "No deleted items match these filters."
              : `No deleted ${activeTab === "note" ? "notes" : activeTab === "folder" ? "folders" : "playlists"} in Trash.`}
        </p>
      ) : (
        <ul className="trash-page-list">
          {visibleItems.map((item) => {
            const key = `${item.entity}:${item.id}`;
            const Icon = item.entity === "playlist" ? ListVideo : item.entity === "folder" ? Folder : item.note_type === "VIDEO" ? Clapperboard : FileText;
            return (
              <li className="trash-page-item" key={key}>
                <Icon size={18} aria-hidden="true" />
                <div className="trash-page-copy">
                  <strong>{item.title || (item.entity === "folder" ? "Untitled folder" : item.entity === "playlist" ? "Untitled playlist" : "Untitled note")}</strong>
                  <span>{item.entity === "folder" ? "Folder · Subfolders are included; notes remain in Notes" : item.entity === "playlist" ? "Playlist · Videos and notes are kept" : item.note_type === "VIDEO" ? `Video note${item.video_title ? ` · ${item.video_title}` : ""}` : "Standalone note"}</span>
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
