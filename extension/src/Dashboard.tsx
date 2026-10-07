import {
  useEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpRight,
  Brain,
  BookOpen,
  Clapperboard,
  Clock3,
  FileText,
  Folder,
  House,
  Menu,
  Play,
  Plus,
  RefreshCw,
  Search,
  Save,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import {
  BlockEditor,
  NoteReader,
  type ThemeColors,
} from "./Sidebar";
import {
  createEmptyDocument,
  documentToPlainText,
  normalizeDocument,
  type NoteBlock,
  type VideoNote,
} from "./noteDocument";
import {
  createStandaloneDashboardNote,
  loadDashboardData,
  updateDashboardNote,
  upsertDashboardNote,
  type DashboardData,
  type DashboardNote,
} from "./dashboardApi";
import "./dashboard.css";

type DashboardRoute =
  | "dashboard"
  | "notes"
  | "videos"
  | "folders"
  | "search"
  | "knowledge";

type NoteWorkspaceLocation =
  | { mode: "new" }
  | { mode: "existing"; noteId: number }
  | null;

interface DashboardLocation {
  route: DashboardRoute;
  noteWorkspace: NoteWorkspaceLocation;
}

type DashboardState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: DashboardData };

const navigation = [
  { route: "dashboard", label: "Dashboard", icon: House },
  { route: "notes", label: "Notes", icon: FileText },
  { route: "videos", label: "Videos", icon: Clapperboard },
  { route: "folders", label: "Folders", icon: Folder },
  { route: "search", label: "Search", icon: Search },
  { route: "knowledge", label: "AI / Knowledge", icon: Brain },
] as const satisfies ReadonlyArray<{
  route: DashboardRoute;
  label: string;
  icon: typeof House;
}>;

const routeContent: Record<
  Exclude<DashboardRoute, "dashboard" | "notes">,
  { title: string; description: string; message: string }
> = {
  videos: {
    title: "Videos",
    description: "Return to the videos connected to your learning.",
    message:
      "A video library endpoint is not available yet. Video-linked notes remain accessible in Notes and on their YouTube pages.",
  },
  folders: {
    title: "Folders",
    description: "Keep related learning together.",
    message:
      "Folder records exist in the backend, but folder listing and management are not exposed through an API yet.",
  },
  search: {
    title: "Search",
    description: "Find ideas across your knowledge.",
    message:
      "Dashboard search is not available yet. You can ask questions about your notes from the AI workspace in the YouTube sidebar.",
  },
  knowledge: {
    title: "AI / Knowledge",
    description: "Ask questions grounded in your saved learning.",
    message:
      "Grounded AI questions are available in the YouTube sidebar. Open a video to ask about your personal knowledge base.",
  },
};

function locationFromHash(): DashboardLocation {
  const path = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  if (path === "notes/new") {
    return { route: "notes", noteWorkspace: { mode: "new" } };
  }

  const noteMatch = path.match(/^notes\/(\d+)$/);
  if (noteMatch) {
    const noteId = Number(noteMatch[1]);
    if (Number.isSafeInteger(noteId) && noteId > 0) {
      return { route: "notes", noteWorkspace: { mode: "existing", noteId } };
    }
  }

  return {
    route: navigation.some((item) => item.route === path)
      ? (path as DashboardRoute)
      : "dashboard",
    noteWorkspace: null,
  };
}

function Dashboard() {
  const [location, setLocation] = useState<DashboardLocation>(locationFromHash);
  const route = location.route;
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [noteType, setNoteType] = useState<NoteTypeFilter>("ALL");
  const [sortOrder, setSortOrder] = useState<NoteSortOrder>("updated-desc");
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const dashboardRequestVersion = useRef(0);
  const unsavedChangesRef = useRef(false);
  const savedNoteOverridesRef = useRef(new Map<number, DashboardNote>());
  const previousHashRef = useRef(window.location.hash || "#/dashboard");
  const [dashboardState, setDashboardState] = useState<DashboardState>({
    status: "loading",
  });
  const previousRoute = useRef(route);

  useEffect(() => {
    const handleRouteChange = () => {
      const nextHash = window.location.hash || "#/dashboard";
      if (
        unsavedChangesRef.current &&
        !window.confirm("You have unsaved changes. Discard them and leave?")
      ) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}${previousHashRef.current}`,
        );
        return;
      }

      unsavedChangesRef.current = false;
      previousHashRef.current = nextHash;
      setLocation(locationFromHash());
      setMobileNavigationOpen(false);
    };

    window.addEventListener("hashchange", handleRouteChange);
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!unsavedChangesRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("hashchange", handleRouteChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  useEffect(() => {
    if (previousRoute.current !== route) {
      previousRoute.current = route;
      pageHeadingRef.current?.focus();
    }
  }, [route]);

  useEffect(() => {
    let active = true;
    const requestVersion = ++dashboardRequestVersion.current;

    loadDashboardData()
      .then((data) => {
        if (active && requestVersion === dashboardRequestVersion.current) {
          const mergedData = [...savedNoteOverridesRef.current.values()].reduce(
            (currentData, savedNote) =>
              upsertDashboardNote(currentData, savedNote),
            data,
          );
          setDashboardState({ status: "ready", data: mergedData });
        }
      })
      .catch((error: unknown) => {
        if (!active || requestVersion !== dashboardRequestVersion.current) {
          return;
        }
        setDashboardState({
          status: "error",
          message:
            error instanceof Error ? error.message : "Could not load saved notes.",
        });
      });

    return () => {
      active = false;
    };
  }, [retryCount]);

  useEffect(() => {
    if (!mobileNavigationOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileNavigationOpen(false);
        menuButtonRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileNavigationOpen]);

  const refreshDashboard = () => {
    setDashboardState({ status: "loading" });
    setRetryCount((count) => count + 1);
  };
  const toggleMobileNavigation = () => {
    if (mobileNavigationOpen) {
      setMobileNavigationOpen(false);
      return;
    }

    setMobileNavigationOpen(true);
    window.setTimeout(() => {
      document
        .querySelector<HTMLAnchorElement>(
          "#dashboard-navigation .navigation-link",
        )
        ?.focus();
    });
  };
  const handleNavigation = () => {
    if (mobileNavigationOpen && locationFromHash().route === route) {
      pageHeadingRef.current?.focus();
    }
    setMobileNavigationOpen(false);
  };
  const closeMobileNavigation = () => {
    setMobileNavigationOpen(false);
    menuButtonRef.current?.focus();
  };
  const currentRoute = navigation.find((item) => item.route === route);
  const pageTitle = currentRoute?.label ?? "Dashboard";
  const pageDescription =
    route === "dashboard"
      ? "A clear view of the notes and ideas you collect while learning."
      : route === "notes"
        ? "Your saved notes, collected from the YouTube learning sidebar."
        : routeContent[route].description;

  if (location.noteWorkspace) {
    const workspaceLocation = location.noteWorkspace;
    if (
      workspaceLocation.mode === "existing" &&
      dashboardState.status === "loading"
    ) {
      return <NoteWorkspaceLoading />;
    }
    const workspaceNote =
      workspaceLocation.mode === "existing" &&
      dashboardState.status === "ready"
        ? dashboardState.data.notes.find(
            (note) => note.id === workspaceLocation.noteId,
          ) ?? null
        : null;
    if (
      workspaceLocation.mode === "existing" &&
      !workspaceNote
    ) {
      return (
        <NoteWorkspaceUnavailable
          message={
            dashboardState.status === "error"
              ? dashboardState.message
              : "This note could not be found in your notes."
          }
          canRetry={dashboardState.status === "error"}
          onRetry={refreshDashboard}
          onBackToNotes={() => {
            window.location.hash = "#/notes";
          }}
        />
      );
    }
    return (
      <NoteWorkspace
        key={
          workspaceLocation.mode === "new"
            ? "new-note"
            : `note-${workspaceLocation.noteId}`
        }
        location={workspaceLocation}
        note={workspaceNote}
        onBackToNotes={() => {
          window.location.hash = "#/notes";
        }}
        onDirtyChange={(dirty) => {
          unsavedChangesRef.current = dirty;
        }}
        onSaved={(savedNote) => {
          savedNoteOverridesRef.current.set(savedNote.id, savedNote);
          setDashboardState((current) =>
            current.status === "ready"
              ? {
                  status: "ready",
                  data: upsertDashboardNote(current.data, savedNote),
                }
              : current,
          );
          if (dashboardState.status === "error") refreshDashboard();
        }}
      />
    );
  }

  return (
    <div className="dashboard-shell">
      {mobileNavigationOpen && (
        <button
          className="dashboard-backdrop"
          type="button"
          aria-label="Close navigation"
          onClick={closeMobileNavigation}
        />
      )}
      <Sidebar
        activeRoute={route}
        mobileOpen={mobileNavigationOpen}
        onNavigate={handleNavigation}
      />

      <div className="dashboard-main">
        <DashboardHeader
          title={pageTitle}
          onMenuClick={toggleMobileNavigation}
          menuExpanded={mobileNavigationOpen}
          menuButtonRef={menuButtonRef}
        />

        <main className="dashboard-content">
          <header className="page-intro">
            <div>
              <p className="eyebrow">YOUR LEARNING SPACE</p>
              <h1 ref={pageHeadingRef} tabIndex={-1}>
                {route === "dashboard" ? "Your learning space" : pageTitle}
              </h1>
              <p className="page-description">{pageDescription}</p>
            </div>
            <a
              className="primary-link"
              href="https://www.youtube.com/"
              target="_blank"
              rel="noreferrer"
            >
              <Play size={16} aria-hidden="true" />
              Open YouTube
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </header>

          {route === "dashboard" ? (
            <DashboardHome
              dashboardState={dashboardState}
              onRetry={refreshDashboard}
              onNavigateToNotes={() => {
                window.location.hash = "#/notes";
              }}
            />
          ) : route === "notes" ? (
            <NotesPage
              dashboardState={dashboardState}
              onRetry={refreshDashboard}
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              noteType={noteType}
              onNoteTypeChange={setNoteType}
              sortOrder={sortOrder}
              onSortOrderChange={setSortOrder}
              onOpenNote={(noteId) => {
                window.location.hash = `#/notes/${noteId}`;
              }}
            />
          ) : (
            <WorkspacePlaceholder route={route} />
          )}
        </main>
      </div>
    </div>
  );
}

interface SidebarProps {
  activeRoute: DashboardRoute;
  mobileOpen: boolean;
  onNavigate: () => void;
}

function Sidebar({ activeRoute, mobileOpen, onNavigate }: SidebarProps) {
  return (
    <aside
      className={`dashboard-sidebar${mobileOpen ? " is-open" : ""}`}
      id="dashboard-navigation"
    >
      <a
        className="brand"
        href="#/dashboard"
        onClick={onNavigate}
        aria-label="YouTube Knowledge dashboard"
      >
        <span className="brand-mark">
          <BookOpen size={21} aria-hidden="true" />
        </span>
        <span className="brand-copy">
          <strong>YouTube Knowledge</strong>
          <span>LEARNING WORKSPACE</span>
        </span>
      </a>

      <p className="nav-caption">WORKSPACE</p>
      <nav className="primary-navigation" aria-label="Main navigation">
        {navigation.map(({ route, label, icon: Icon }) => (
          <a
            key={route}
            className={`navigation-link${activeRoute === route ? " is-active" : ""}`}
            href={`#/${route}`}
            aria-current={activeRoute === route ? "page" : undefined}
            onClick={onNavigate}
          >
            <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
            <span>{label}</span>
            {activeRoute === route && (
              <span className="active-indicator" aria-hidden="true" />
            )}
          </a>
        ))}
      </nav>

      <div className="sidebar-note">
        <span className="sidebar-note-icon">
          <Sparkles size={17} aria-hidden="true" />
        </span>
        <p>
          <strong>Learn as you watch</strong>
          <span>Capture ideas from any YouTube video.</span>
        </p>
      </div>

      <div className="sidebar-footer">
        <span className="connection-dot" aria-hidden="true" />
        <span>YouTube sidebar workspace</span>
      </div>
    </aside>
  );
}

interface DashboardHeaderProps {
  title: string;
  onMenuClick: () => void;
  menuExpanded: boolean;
  menuButtonRef: Ref<HTMLButtonElement>;
}

function DashboardHeader({
  title,
  onMenuClick,
  menuExpanded,
  menuButtonRef,
}: DashboardHeaderProps) {
  return (
    <header className="dashboard-topbar">
      <button
        ref={menuButtonRef}
        className="mobile-menu-button"
        type="button"
        aria-label={menuExpanded ? "Close navigation menu" : "Open navigation menu"}
        aria-controls="dashboard-navigation"
        aria-expanded={menuExpanded}
        onClick={onMenuClick}
      >
        {menuExpanded ? (
          <X size={20} aria-hidden="true" />
        ) : (
          <Menu size={20} aria-hidden="true" />
        )}
      </button>
      <div className="topbar-title">{title}</div>
      <span className="workspace-indicator">
        <span className="connection-dot" aria-hidden="true" />
        Extension workspace
      </span>
    </header>
  );
}

interface DashboardHomeProps {
  dashboardState: DashboardState;
  onRetry: () => void;
  onNavigateToNotes: () => void;
}

function DashboardHome({
  dashboardState,
  onRetry,
  onNavigateToNotes,
}: DashboardHomeProps) {
  return (
    <>
      <DashboardOverview
        dashboardState={dashboardState}
        onRefresh={onRetry}
      />
      <div className="dashboard-columns">
        <RecentNotes
          dashboardState={dashboardState}
          onRetry={onRetry}
          onViewAll={onNavigateToNotes}
        />
        <RecentVideos />
      </div>
      <QuickActions onViewNotes={onNavigateToNotes} />
    </>
  );
}

function DashboardOverview({
  dashboardState,
  onRefresh,
}: {
  dashboardState: DashboardState;
  onRefresh: () => void;
}) {
  const data =
    dashboardState.status === "ready" ? dashboardState.data : null;
  const metrics = [
    {
      label: "Total notes",
      value: data ? String(data.totalNotes) : "—",
      detail: "All notes in your account",
      icon: FileText,
      className: "metric-cyan",
    },
    {
      label: "Created in last 7 days",
      value: data ? String(data.recentlyCreatedNotes) : "—",
      detail: "Based on note creation date",
      icon: Clock3,
      className: "metric-violet",
    },
    {
      label: "Video-associated notes",
      value: data ? String(data.videoAssociatedNotes) : "—",
      detail: "Notes with an associated video",
      icon: Clapperboard,
      className: "metric-green",
    },
    {
      label: "Standalone notes",
      value: data ? String(data.standaloneNotes) : "—",
      detail: "Notes without an associated video",
      icon: FileText,
      className: "metric-cyan",
    },
  ];

  return (
    <section
      className="overview-section"
      aria-labelledby="overview-heading"
      aria-busy={dashboardState.status === "loading"}
    >
      <div className="section-heading">
        <div>
          <h2 id="overview-heading">Overview</h2>
          <p>
            {dashboardState.status === "ready" && data?.totalNotes === 0
              ? "No notes saved yet"
              : "Calculated from your saved notes"}
          </p>
        </div>
        <div className="overview-actions">
          {dashboardState.status === "ready" && (
            <span className="data-source-label">
              <span className="connection-dot" aria-hidden="true" />
              {dashboardState.data.totalNotes} notes loaded
            </span>
          )}
          <button
            className="icon-button"
            type="button"
            aria-label={
              dashboardState.status === "loading"
                ? "Loading dashboard data"
                : "Refresh dashboard data"
            }
            title="Refresh dashboard data"
            onClick={onRefresh}
            disabled={dashboardState.status === "loading"}
          >
            <RefreshCw
              className={
                dashboardState.status === "loading" ? "is-spinning" : undefined
              }
              size={16}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
      {dashboardState.status === "loading" ? (
        <div className="metrics-grid" role="status" aria-label="Loading dashboard data">
          {metrics.map(({ label, icon: Icon, className }) => (
            <article className="metric-card" key={label}>
              <div className={`metric-icon ${className}`}>
                <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
              </div>
              <div className="metric-copy">
                <p>{label}</p>
                <span className="metric-value-skeleton" aria-hidden="true" />
                <span>Loading data</span>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <>
          <div className="metrics-grid">
            {metrics.map(({ label, value, detail, icon: Icon, className }) => (
              <article className="metric-card" key={label}>
                <div className={`metric-icon ${className}`}>
                  <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
                </div>
                <div className="metric-copy">
                  <p>{label}</p>
                  <strong>{value}</strong>
                  <span>
                    {dashboardState.status === "error"
                      ? "Unavailable"
                      : detail}
                  </span>
                </div>
              </article>
            ))}
          </div>
          {dashboardState.status === "error" && (
            <div className="dashboard-error" role="alert">
              <AlertCircle size={17} aria-hidden="true" />
              <div>
                <strong>Dashboard data could not be loaded</strong>
                <p>{dashboardState.message}</p>
                <button
                  className="inline-action"
                  type="button"
                  onClick={onRefresh}
                >
                  Retry
                </button>
              </div>
            </div>
          )}
          {dashboardState.status === "ready" &&
            dashboardState.data.totalNotes === 0 && (
              <div className="dashboard-empty-callout">
                <span>
                  Your notes will appear here after you save one from a
                  YouTube video.
                </span>
                <a
                  className="secondary-link"
                  href="https://www.youtube.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Start a note on YouTube
                  <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              </div>
            )}
        </>
      )}
    </section>
  );
}

interface RecentNotesProps {
  dashboardState: DashboardState;
  onRetry: () => void;
  onViewAll: () => void;
}

function RecentNotes({
  dashboardState,
  onRetry,
  onViewAll,
}: RecentNotesProps) {
  return (
    <section className="content-card recent-notes" aria-labelledby="recent-notes-heading">
      <div className="card-heading">
        <div>
          <div className="card-title-row">
            <span className="section-icon">
              <Clock3 size={16} aria-hidden="true" />
            </span>
            <h2 id="recent-notes-heading">Recent notes</h2>
          </div>
          <p>Sorted by most recently updated</p>
        </div>
        <a className="text-link" href="#/notes">
          View all <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </div>
      <NotesListState
        dashboardState={dashboardState}
        notes={
          dashboardState.status === "ready"
            ? dashboardState.data.recentNotes
            : []
        }
        onRetry={onRetry}
        onViewNotes={onViewAll}
        compact
      />
    </section>
  );
}

function RecentVideos() {
  return (
    <section className="content-card recent-videos" aria-labelledby="recent-videos-heading">
      <div className="card-heading">
        <div>
          <div className="card-title-row">
            <span className="section-icon video-section-icon">
              <Clapperboard size={16} aria-hidden="true" />
            </span>
            <h2 id="recent-videos-heading">Recent videos</h2>
          </div>
          <p>Your learning queue</p>
        </div>
      </div>
      <div className="empty-state video-empty-state">
        <span className="empty-state-icon">
          <Clapperboard size={20} aria-hidden="true" />
        </span>
        <h3>No video library yet</h3>
        <p>
          A video-list API is not available yet. Video-linked notes are still
          available in Notes.
        </p>
      </div>
    </section>
  );
}

function QuickActions({ onViewNotes }: { onViewNotes: () => void }) {
  return (
    <section className="quick-actions-section" aria-labelledby="quick-actions-heading">
      <div className="section-heading">
        <div>
          <h2 id="quick-actions-heading">Quick actions</h2>
          <p>Pick up where your learning happens</p>
        </div>
      </div>
      <div className="quick-actions-grid">
        <a
          className="quick-action-card"
          href="https://www.youtube.com/"
          target="_blank"
          rel="noreferrer"
        >
          <span className="quick-action-icon youtube-action-icon">
            <Play size={18} aria-hidden="true" />
          </span>
          <span className="quick-action-copy">
            <strong>Open YouTube</strong>
            <span>Watch and capture notes with the sidebar</span>
          </span>
          <ArrowUpRight size={16} aria-hidden="true" />
        </a>
        <a className="quick-action-card" href="#/notes" onClick={onViewNotes}>
          <span className="quick-action-icon notes-action-icon">
            <FileText size={18} aria-hidden="true" />
          </span>
          <span className="quick-action-copy">
            <strong>Browse your notes</strong>
            <span>Review the ideas you have saved</span>
          </span>
          <ArrowUpRight size={16} aria-hidden="true" />
        </a>
        <a className="quick-action-card" href="#/knowledge">
          <span className="quick-action-icon knowledge-action-icon">
            <Brain size={18} aria-hidden="true" />
          </span>
          <span className="quick-action-copy">
            <strong>Explore AI / Knowledge</strong>
            <span>Ask grounded questions in the video sidebar</span>
          </span>
          <ArrowUpRight size={16} aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}

function NotesPage({
  dashboardState,
  onRetry,
  searchQuery,
  onSearchQueryChange,
  noteType,
  onNoteTypeChange,
  sortOrder,
  onSortOrderChange,
  onOpenNote,
}: {
  dashboardState: DashboardState;
  onRetry: () => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  noteType: NoteTypeFilter;
  onNoteTypeChange: (value: NoteTypeFilter) => void;
  sortOrder: NoteSortOrder;
  onSortOrderChange: (value: NoteSortOrder) => void;
  onOpenNote: (noteId: number) => void;
}) {
  const allNotes =
    dashboardState.status === "ready" ? dashboardState.data.notes : [];
  const matchingNotes = allNotes
    .filter((note) => noteType === "ALL" || note.note_type === noteType)
    .filter((note) => matchesNoteSearch(note, searchQuery))
    .sort((left, right) => compareNotes(left, right, sortOrder));
  const hasNotes =
    dashboardState.status === "ready" &&
    dashboardState.data.totalNotes > 0;

  return (
    <section className="content-card notes-page-card" aria-labelledby="notes-list-heading">
      <div className="card-heading">
        <div>
          <div className="card-title-row">
            <span className="section-icon">
              <FileText size={16} aria-hidden="true" />
            </span>
            <h2 id="notes-list-heading">All notes</h2>
          </div>
          <p>
            {hasNotes
              ? `${dashboardState.data.totalNotes} notes`
              : "Your saved notes"}
          </p>
        </div>
        <div className="notes-heading-actions">
          <a className="new-note-button" href="#/notes/new">
            <Plus size={15} aria-hidden="true" />
            New Note
          </a>
          <button
            className="icon-button"
            type="button"
            aria-label="Refresh notes"
            disabled={dashboardState.status === "loading"}
            onClick={onRetry}
          >
            <RefreshCw
              className={
                dashboardState.status === "loading" ? "is-spinning" : undefined
              }
              size={16}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
      {hasNotes ? (
        <>
          <div className="notes-toolbar">
            <label className="notes-search">
              <span className="visually-hidden">Search notes</span>
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => onSearchQueryChange(event.target.value)}
                aria-label="Search notes"
                placeholder="Search titles and note text"
              />
            </label>
            <label className="notes-control">
              <span>Type</span>
              <select
                value={noteType}
                onChange={(event) => {
                  const value = event.target.value;
                  if (isNoteTypeFilter(value)) onNoteTypeChange(value);
                }}
              >
                <option value="ALL">All Notes</option>
                <option value="VIDEO">Video Notes</option>
                <option value="STANDALONE">Standalone Notes</option>
              </select>
            </label>
            <label className="notes-control">
              <span>Sort</span>
              <select
                value={sortOrder}
                onChange={(event) => {
                  const value = event.target.value;
                  if (isNoteSortOrder(value)) onSortOrderChange(value);
                }}
              >
                <option value="updated-desc">Recently Updated</option>
                <option value="created-desc">Recently Created</option>
                <option value="updated-asc">Oldest Updated</option>
                <option value="created-asc">Oldest Created</option>
              </select>
            </label>
          </div>
          <p className="notes-result-count" aria-live="polite">
            {matchingNotes.length}{" "}
            {matchingNotes.length === 1 ? "note" : "notes"}
            {searchQuery.trim() || noteType !== "ALL"
              ? " match your search and filters"
              : ""}
          </p>
          {matchingNotes.length === 0 ? (
            <div className="notes-no-matches" role="status">
              <Search size={19} aria-hidden="true" />
              <p>No matching notes. Try changing your search or note type.</p>
            </div>
          ) : (
            <NotesListState
              dashboardState={dashboardState}
              notes={matchingNotes}
              onRetry={onRetry}
              onViewNotes={onRetry}
              onSelectNote={onOpenNote}
            />
          )}
        </>
      ) : (
        <NotesListState
          dashboardState={dashboardState}
          notes={[]}
          onRetry={onRetry}
          onViewNotes={onRetry}
        />
      )}
    </section>
  );
}

type NoteSortOrder =
  | "updated-desc"
  | "created-desc"
  | "updated-asc"
  | "created-asc";
type NoteTypeFilter = "ALL" | "VIDEO" | "STANDALONE";

function isNoteSortOrder(value: string): value is NoteSortOrder {
  return (
    value === "updated-desc" ||
    value === "created-desc" ||
    value === "updated-asc" ||
    value === "created-asc"
  );
}

function isNoteTypeFilter(value: string): value is NoteTypeFilter {
  return value === "ALL" || value === "VIDEO" || value === "STANDALONE";
}

function matchesNoteSearch(note: VideoNote, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;

  const searchableText = [
    typeof note.title === "string" ? note.title : "",
    typeof note.content === "string" ? note.content : "",
    structuredDocumentText(note),
  ]
    .join("\n")
    .toLocaleLowerCase();

  return searchableText.includes(normalizedQuery);
}

function compareNotes(
  left: VideoNote,
  right: VideoNote,
  sortOrder: NoteSortOrder,
): number {
  const sortByCreated = sortOrder.startsWith("created");
  const ascending = sortOrder.endsWith("asc");
  const leftDate = safeDateValue(
    sortByCreated ? left.created_at : left.updated_at,
  );
  const rightDate = safeDateValue(
    sortByCreated ? right.created_at : right.updated_at,
  );

  if (leftDate === null && rightDate !== null) return 1;
  if (leftDate !== null && rightDate === null) return -1;
  if (leftDate !== null && rightDate !== null && leftDate !== rightDate) {
    return ascending ? leftDate - rightDate : rightDate - leftDate;
  }
  return left.id - right.id;
}

function safeDateValue(value?: string): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function supportedDocumentBlocks(note: VideoNote): NoteBlock[] {
  const document = note.document;
  if (!document || document.version !== 1 || !Array.isArray(document.blocks)) {
    return [];
  }

  return document.blocks.filter(
    (block): block is NoteBlock =>
      Boolean(block) &&
      typeof block.id === "string" &&
      typeof block.content === "string" &&
      (block.type === "paragraph" ||
        block.type === "heading" ||
        block.type === "equation" ||
        block.type === "timestamp" ||
        block.type === "image"),
  );
}

function structuredDocumentText(note: VideoNote): string {
  return supportedDocumentBlocks(note)
    .map((block) => {
      if (block.type === "image") {
        return typeof block.metadata?.alt === "string"
          ? block.metadata.alt
          : "";
      }
      return block.content;
    })
    .filter((text) => text.trim().length > 0)
    .join("\n");
}

type NoteWorkspaceMode = "read" | "write";

const dashboardNoteColors: ThemeColors = {
  panel: "#0b1220",
  header: "#0f172a",
  surface: "#101827",
  input: "#111827",
  border: "#263449",
  text: "#dbe4f0",
  primaryText: "#f8fafc",
  muted: "#94a3b8",
  accent: "#67e8f9",
  accentSoft: "#12303a",
  danger: "#f87171",
  shadow: "rgba(0, 0, 0, 0.38)",
};

interface NoteWorkspaceProps {
  location: Exclude<NoteWorkspaceLocation, null>;
  note: DashboardNote | null;
  onBackToNotes: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (note: DashboardNote) => void;
}

function NoteWorkspaceLoading() {
  return (
    <main className="note-workspace-page" aria-busy="true">
      <div className="note-workspace-loading" role="status">
        <span className="metric-value-skeleton" aria-hidden="true" />
        <p>Loading note workspace…</p>
      </div>
    </main>
  );
}

function NoteWorkspaceUnavailable({
  message,
  canRetry,
  onRetry,
  onBackToNotes,
}: {
  message: string;
  canRetry: boolean;
  onRetry: () => void;
  onBackToNotes: () => void;
}) {
  return (
    <main className="note-workspace-page">
      <div className="note-workspace-error" role="alert">
        <AlertCircle size={20} aria-hidden="true" />
        <div>
          <h1>Note unavailable</h1>
          <p>{message}</p>
          {canRetry && (
            <button className="inline-action" type="button" onClick={onRetry}>
              Retry loading
            </button>
          )}
          <button
            className="workspace-secondary-button"
            type="button"
            onClick={onBackToNotes}
          >
            Back to Notes
          </button>
        </div>
      </div>
    </main>
  );
}

function NoteWorkspace({
  location,
  note,
  onBackToNotes,
  onDirtyChange,
  onSaved,
}: NoteWorkspaceProps) {
  const isNew = location.mode === "new";
  const [mode, setMode] = useState<NoteWorkspaceMode>(
    isNew ? "write" : "read",
  );
  const [title, setTitle] = useState(() => note?.title ?? "");
  const [savedDocument, setSavedDocument] = useState(() =>
    note ? normalizeDocument(note) : createEmptyDocument(),
  );
  const [noteDocument, setNoteDocument] = useState(savedDocument);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [thumbnailUnavailable, setThumbnailUnavailable] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const pageTitleRef = useRef<HTMLHeadingElement>(null);
  const serializedDocument = JSON.stringify(noteDocument);
  const serializedSavedDocument = JSON.stringify(savedDocument);
  const isDirty =
    (isNew
      ? title.length > 0 || serializedDocument !== serializedSavedDocument
      : Boolean(
          note &&
            (title !== note.title ||
              serializedDocument !== serializedSavedDocument),
        ));

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    if (mode === "write") {
      titleInputRef.current?.focus();
    } else {
      pageTitleRef.current?.focus();
    }
  }, [mode]);

  const discardAndSwitchToRead = () => {
    if (
      isDirty &&
      !window.confirm("Discard your unsaved changes and switch to read mode?")
    ) {
      return;
    }
    if (note) {
      setTitle(note.title);
      setNoteDocument(savedDocument);
    } else {
      setTitle("");
      setNoteDocument(savedDocument);
    }
    setSaveError(null);
    onDirtyChange(false);
    setMode("read");
  };

  const saveNote = async () => {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      setSaveError("Enter a title before saving this note.");
      titleInputRef.current?.focus();
      return;
    }

    setIsSaving(true);
    setSaveError(null);
    try {
      let savedNote: DashboardNote;
      const content = documentToPlainText(noteDocument);
      if (isNew) {
        savedNote = await createStandaloneDashboardNote({
          title: normalizedTitle,
          content,
          document: noteDocument,
        });
      } else {
        if (!note) return;
        savedNote = await updateDashboardNote(note.id, {
          title: normalizedTitle,
          content,
          document: noteDocument,
        });
      }

      onSaved(savedNote);
      onDirtyChange(false);
      if (isNew) {
        window.location.hash = `#/notes/${savedNote.id}`;
      } else {
        const updatedDocument = normalizeDocument(savedNote);
        setTitle(savedNote.title);
        setSavedDocument(updatedDocument);
        setNoteDocument(updatedDocument);
        setMode("read");
      }
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Could not save this note.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const pageHeading =
    isNew ? "New standalone note" : note?.title || "Note workspace";
  const updatedDate = note ? formatNoteDate(note.updated_at) : null;
  const createdDate = note ? formatNoteDate(note.created_at) : null;
  const hasVideo =
    note?.note_type === "VIDEO" && typeof note.video === "number";
  const videoMetadata = hasVideo ? note.video_detail : null;
  const videoUrl = getYoutubeWatchUrl(videoMetadata?.youtube_id);
  const thumbnailUrl = safeExternalHttpUrl(videoMetadata?.thumbnail_url);
  const noteTimestamp =
    typeof note?.timestamp_seconds === "number" &&
    Number.isInteger(note.timestamp_seconds) &&
    note.timestamp_seconds >= 0
      ? note.timestamp_seconds
      : null;
  const timestampUrl =
    noteTimestamp === null
      ? null
      : getYoutubeWatchUrl(videoMetadata?.youtube_id, noteTimestamp);

  if (!isNew && !note) {
    return (
      <main className="note-workspace-page">
        <div className="note-workspace-error" role="alert">
          <AlertCircle size={20} aria-hidden="true" />
          <div>
            <h1>Note unavailable</h1>
            <p>This note could not be found in your notes.</p>
            <button
              className="workspace-secondary-button"
              type="button"
              onClick={onBackToNotes}
            >
              Back to Notes
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="note-workspace-page">
      <div className="note-workspace">
        <header className="note-workspace-topbar">
          <button
            className="workspace-back-button"
            type="button"
            onClick={onBackToNotes}
          >
            <ArrowLeft size={17} aria-hidden="true" />
            <span>Back to Notes</span>
          </button>
          <p className="workspace-brand">YOUTUBE KNOWLEDGE / NOTES</p>
          <div className="workspace-mode-switch" role="group" aria-label="Note mode">
            {!isNew && (
              <button
                type="button"
                aria-pressed={mode === "read"}
                className={mode === "read" ? "is-active" : ""}
                onClick={() => {
                  if (mode === "write") discardAndSwitchToRead();
                }}
              >
                READ
              </button>
            )}
            <button
              type="button"
              aria-pressed={mode === "write"}
              className={mode === "write" ? "is-active" : ""}
              onClick={() => {
                if (mode === "read") {
                  setSaveError(null);
                  setMode("write");
                }
              }}
            >
              WRITE
            </button>
          </div>
        </header>

        <section className="note-workspace-body" aria-labelledby="workspace-title">
          <div className="note-workspace-heading">
            <div>
              <p className="eyebrow">{mode === "read" ? "READ MODE" : "WRITE MODE"}</p>
              <h1 id="workspace-title" ref={pageTitleRef} tabIndex={-1}>
                {pageHeading}
              </h1>
              {mode === "read" && note && (
                <div className="note-detail-metadata">
                  <span>
                    {note.note_type === "VIDEO" ? "Video note" : "Standalone note"}
                  </span>
                  {hasVideo && <span>Associated video</span>}
                  {hasVideo &&
                    typeof note.timestamp_seconds === "number" &&
                    note.timestamp_seconds >= 0 && (
                      <span className="note-timestamp">
                        Timestamp {formatTimestamp(note.timestamp_seconds)}
                      </span>
                    )}
                  {typeof note?.folder === "number" && <span>Folder assigned</span>}
                  <span>Created {createdDate ?? "date unavailable"}</span>
                  <span>Updated {updatedDate ?? "date unavailable"}</span>
                </div>
              )}
            </div>
            {mode === "write" && (
              <button
                className="workspace-save-button"
                type="button"
                onClick={() => void saveNote()}
                disabled={isSaving}
              >
                <Save size={16} aria-hidden="true" />
                {isSaving ? "Saving…" : "Save note"}
              </button>
            )}
          </div>

          {hasVideo && (
            <section className="workspace-video-context" aria-label="Video context">
              {thumbnailUrl && !thumbnailUnavailable && (
                <img
                  className="workspace-video-thumbnail"
                  src={thumbnailUrl}
                  onError={() => setThumbnailUnavailable(true)}
                  alt={
                    videoMetadata?.title
                      ? `Thumbnail for ${videoMetadata.title}`
                      : "Video thumbnail"
                  }
                />
              )}
              <div className="workspace-video-copy">
                <p className="eyebrow">VIDEO CONTEXT</p>
                <h2>
                  {videoMetadata?.title?.trim() || "Video title unavailable"}
                </h2>
                {(videoMetadata?.channel_name?.trim() ||
                  videoMetadata?.channel_handle?.trim()) && (
                  <p className="workspace-video-channel">
                    {videoMetadata.channel_name?.trim() ||
                      videoMetadata.channel_handle?.trim()}
                  </p>
                )}
                {videoUrl ? (
                  <div className="workspace-video-actions">
                    <a
                      href={videoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Play size={14} aria-hidden="true" />
                      Open Video
                    </a>
                    {timestampUrl && noteTimestamp !== null && (
                        <a
                          href={timestampUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Clock3 size={14} aria-hidden="true" />
                          Open at {formatTimestamp(noteTimestamp)}
                        </a>
                      )}
                  </div>
                ) : (
                  <p className="workspace-video-unavailable">
                    Video link unavailable.
                  </p>
                )}
              </div>
            </section>
          )}

          {saveError && (
            <div className="workspace-save-error" role="alert">
              <AlertCircle size={17} aria-hidden="true" />
              <p>{saveError}</p>
            </div>
          )}

          {mode === "write" ? (
            <div className="note-editor">
              <label htmlFor="note-title-input">Title</label>
              <input
                ref={titleInputRef}
                id="note-title-input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={500}
                placeholder="Give this note a title"
              />
              <div className="note-block-editor">
                <BlockEditor
                  noteDocument={noteDocument}
                  colors={dashboardNoteColors}
                  onChange={setNoteDocument}
                  enableTimestampJump={false}
                  timestampContent={() => ""}
                />
              </div>
              <p className="note-editor-hint">
                Blocks are saved in their original structured order. Existing video, folder, timestamp, and note-type associations are preserved.
              </p>
            </div>
          ) : note ? (
            <div className="note-workspace-content">
              <NoteReader
                note={note}
                colors={dashboardNoteColors}
                showTitle={false}
                enableTimestampJump={false}
                onTimestampClick={
                  hasVideo && videoUrl
                    ? (seconds) => {
                        const timestampUrl = getYoutubeWatchUrl(
                          videoMetadata?.youtube_id,
                          seconds,
                        );
                        if (timestampUrl) {
                          window.open(
                            timestampUrl,
                            "_blank",
                            "noopener,noreferrer",
                          );
                        }
                      }
                    : undefined
                }
              />
              {supportedDocumentBlocks(note).length === 0 &&
                !note.content.trim() && (
                  <p className="note-detail-empty">
                    This note has no text content.
                  </p>
                )}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function getYoutubeWatchUrl(
  youtubeId?: string,
  timestampSeconds?: number,
): string | null {
  if (!youtubeId || !/^[A-Za-z0-9_-]{11}$/.test(youtubeId)) return null;
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", youtubeId);
  if (
    typeof timestampSeconds === "number" &&
    Number.isInteger(timestampSeconds) &&
    timestampSeconds >= 0
  ) {
    url.searchParams.set("t", String(timestampSeconds));
  }
  return url.toString();
}

function safeExternalHttpUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function formatNoteDate(value?: string): string | null {
  const timestamp = safeDateValue(value);
  if (timestamp === null) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function NotesListState({
  dashboardState,
  notes,
  onRetry,
  onViewNotes,
  compact = false,
  onSelectNote,
}: {
  dashboardState: DashboardState;
  notes: VideoNote[];
  onRetry: () => void;
  onViewNotes: () => void;
  compact?: boolean;
  onSelectNote?: (noteId: number) => void;
}) {
  if (dashboardState.status === "loading") {
    return (
      <div
        className="notes-loading"
        role="status"
        aria-label="Loading saved notes"
      >
        <span />
        <span />
        <span />
      </div>
    );
  }

  if (dashboardState.status === "error") {
    return (
      <div className="inline-state error-state" role="alert">
        <AlertCircle size={19} aria-hidden="true" />
        <div>
          <strong>Notes could not be loaded</strong>
          <p>{dashboardState.message}</p>
          <button className="inline-action" type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (dashboardState.data.totalNotes === 0) {
    return (
      <div className="empty-state notes-empty-state">
        <span className="empty-state-icon">
          <FileText size={20} aria-hidden="true" />
        </span>
        <h3>No notes saved yet</h3>
        <p>
          Open a YouTube video and use the YouTube Knowledge sidebar to capture
          your first note.
        </p>
        <a
          className="secondary-link"
          href="https://www.youtube.com/"
          target="_blank"
          rel="noreferrer"
        >
          Go to YouTube <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </div>
    );
  }

  return (
    <div className={`notes-list${compact ? " is-compact" : ""}`}>
      {notes.map((note) => {
        const rowContent = (
          <>
            <span
              className={`note-type-icon${note.note_type === "VIDEO" ? " is-video" : ""}`}
              aria-hidden="true"
            >
              {note.note_type === "VIDEO" ? (
                <Video size={16} />
              ) : (
                <FileText size={16} />
              )}
            </span>
            <span className="note-row-copy">
              <span className="note-row-title">
                {note.title || "Untitled note"}
              </span>
              <span className="note-row-preview">{notePreview(note)}</span>
              <span className="note-metadata">
                {typeof note.video === "number" && (
                  <span className="note-video-label">Video note</span>
                )}
                {typeof note.video === "number" &&
                  typeof note.timestamp_seconds === "number" &&
                  note.timestamp_seconds >= 0 && (
                    <span className="note-timestamp">
                      at {formatTimestamp(note.timestamp_seconds)}
                    </span>
                  )}
              </span>
            </span>
            <span className="note-date">{noteDate(note)}</span>
          </>
        );

        return (
          <article className="note-row" key={note.id}>
            {onSelectNote ? (
              <button
                className="note-row-select-button"
                type="button"
                aria-label={`View note: ${note.title || "Untitled note"}`}
                onClick={() => onSelectNote(note.id)}
              >
                {rowContent}
              </button>
            ) : (
              rowContent
            )}
          </article>
        );
      })}
      {compact &&
        dashboardState.status === "ready" &&
        dashboardState.data.totalNotes > notes.length && (
        <button className="notes-view-more" type="button" onClick={onViewNotes}>
          View all {dashboardState.data.totalNotes} notes
          <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function notePreview(note: VideoNote): string {
  const documentText = structuredDocumentText(note);
  const text =
    documentText.trim() ||
    (typeof note.content === "string" ? note.content : "").trim();
  if (!text) return "No text preview available.";
  const preview = text.replace(/\s+/g, " ").trim();
  return preview.length > 220 ? `${preview.slice(0, 217)}...` : preview;
}

function noteDate(note: VideoNote): string {
  const value = note.updated_at ?? note.created_at;
  const timestamp = safeDateValue(value);
  if (timestamp === null) return "Saved note";
  const date = new Date(timestamp);
  const label = note.updated_at ? "Updated" : "Created";
  return `${label} ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date)}`;
}

function formatTimestamp(seconds: number): string {
  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainingSeconds = wholeSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function WorkspacePlaceholder({ route }: { route: DashboardRoute }) {
  if (route === "dashboard" || route === "notes") return null;
  const content = routeContent[route];

  return (
    <section className="content-card workspace-placeholder">
      <span className="placeholder-icon">
        {route === "videos" ? (
          <Clapperboard size={22} aria-hidden="true" />
        ) : route === "folders" ? (
          <Folder size={22} aria-hidden="true" />
        ) : route === "search" ? (
          <Search size={22} aria-hidden="true" />
        ) : (
          <Brain size={22} aria-hidden="true" />
        )}
      </span>
      <p className="eyebrow">WORKSPACE</p>
      <h2>{content.title}</h2>
      <p className="placeholder-message">{content.message}</p>
      <a
        className="secondary-link"
        href="https://www.youtube.com/"
        target="_blank"
        rel="noreferrer"
      >
        Open YouTube <ArrowUpRight size={14} aria-hidden="true" />
      </a>
    </section>
  );
}

export default Dashboard;
