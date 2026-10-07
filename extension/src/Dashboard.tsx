import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type Ref,
} from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpRight,
  Brain,
  BookOpen,
  Clapperboard,
  Check,
  ChevronDown,
  Clock3,
  Download,
  ExternalLink,
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
  Trash2,
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
  getListItems,
  normalizeDocument,
  type NoteBlock,
  type NoteDocument,
  type VideoNote,
} from "./noteDocument";
import {
  createStandaloneDashboardNote,
  DashboardNoteNotFoundError,
  deleteDashboardNote,
  loadDashboardNotesPage,
  loadDashboardData,
  updateDashboardNoteFolder,
  updateDashboardNote,
  upsertDashboardNote,
  type DashboardData,
  type DashboardFolderPathItem,
  type DashboardNote,
} from "./dashboardApi";
import {
  createDashboardFolder,
  deleteDashboardFolder,
  getDashboardFolder,
  getDashboardFolderNotes,
  listDashboardFolders,
  renameDashboardFolder,
  searchDashboardFolders,
  type DashboardFolder,
  type DashboardFolderSearchResult,
} from "./folderApi";
import { FolderOrganizerDialog } from "./FolderOrganizerDialog";
import {
  exportNoteAsMarkdown,
  exportNoteToHtml,
} from "./noteExport";
import {
  type AskRAGScope,
} from "./ragApi";
import {
  askConversation,
  ConversationApiError,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  renameConversation,
  type Conversation,
  type ConversationDetail,
  type ConversationScope,
  type ConversationSource,
} from "./conversationApi";
import {
  NoteAssistanceApiError,
  requestNoteImprovement,
} from "./noteAssistanceApi";
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
  folderId: number | null;
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
    message: "",
  },
  search: {
    title: "Search",
    description: "Find folders by name across your learning space.",
    message: "",
  },
  knowledge: {
    title: "AI / Knowledge",
    description: "Ask questions grounded in your saved learning.",
    message: "",
  },
};

function locationFromHash(hash = window.location.hash): DashboardLocation {
  const path = hash.replace(/^#\/?/, "").split("?")[0];
  if (path === "notes/new") {
    return {
      route: "notes",
      noteWorkspace: { mode: "new" },
      folderId: null,
    };
  }

  const noteMatch = path.match(/^notes\/(\d+)$/);
  if (noteMatch) {
    const noteId = Number(noteMatch[1]);
    if (Number.isSafeInteger(noteId) && noteId > 0) {
      return {
        route: "notes",
        noteWorkspace: { mode: "existing", noteId },
        folderId: null,
      };
    }
  }

  const folderMatch = path.match(/^folders\/(\d+)$/);
  if (folderMatch) {
    const folderId = Number(folderMatch[1]);
    if (Number.isSafeInteger(folderId) && folderId > 0) {
      return {
        route: "folders",
        noteWorkspace: null,
        folderId,
      };
    }
  }

  return {
    route: navigation.some((item) => item.route === path)
      ? (path as DashboardRoute)
      : "dashboard",
    noteWorkspace: null,
    folderId: null,
  };
}

function isKnownDashboardHash(hash: string): boolean {
  const path = hash.replace(/^#\/?/, "").split("?")[0];
  return (
    navigation.some((item) => item.route === path) ||
    /^notes\/(?:new|\d+)$/.test(path) ||
    /^folders\/\d+$/.test(path)
  );
}

function Dashboard() {
  const [location, setLocation] = useState<DashboardLocation>(locationFromHash);
  const route = location.route;
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [notesSearchQuery, setNotesSearchQuery] = useState("");
  const [notesTypeFilter, setNotesTypeFilter] =
    useState<NoteTypeFilter>("ALL");
  const [notesSortOrder, setNotesSortOrder] =
    useState<NoteSortOrder>("updated-desc");
  const [notesPageNumber, setNotesPageNumber] = useState(1);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const dashboardRequestVersion = useRef(0);
  const unsavedChangesRef = useRef(false);
  const savedNoteOverridesRef = useRef(new Map<number, DashboardNote>());
  const previousHashRef = useRef(window.location.hash || "#/dashboard");
  const noteWorkspaceBackHashRef = useRef<string | null>(null);
  const [dashboardState, setDashboardState] = useState<DashboardState>({
    status: "loading",
  });
  const [selectedWorkspaceNote, setSelectedWorkspaceNote] =
    useState<DashboardNote | null>(null);
  const previousRoute = useRef(route);
  const workspaceNoteId =
    location.noteWorkspace?.mode === "existing"
      ? location.noteWorkspace.noteId
      : null;
  const hasCachedWorkspaceNote =
    workspaceNoteId !== null &&
    (selectedWorkspaceNote?.id === workspaceNoteId ||
      (dashboardState.status === "ready" &&
        dashboardState.data.notes.some((note) => note.id === workspaceNoteId)));

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

      const nextLocation = locationFromHash(nextHash);
      const previousLocation = locationFromHash(previousHashRef.current);
      if (
        nextLocation.noteWorkspace &&
        !previousLocation.noteWorkspace &&
        isKnownDashboardHash(previousHashRef.current)
      ) {
        noteWorkspaceBackHashRef.current = previousHashRef.current;
      }

      unsavedChangesRef.current = false;
      previousHashRef.current = nextHash;
      setLocation(nextLocation);
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
    const shouldLoadDashboardData =
      route !== "notes" ||
      (workspaceNoteId !== null && !hasCachedWorkspaceNote);
    if (!shouldLoadDashboardData) {
      dashboardRequestVersion.current += 1;
      return;
    }

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
  }, [retryCount, route, workspaceNoteId, hasCachedWorkspaceNote]);

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
  const navigateBackFromNote = () => {
    if (
      unsavedChangesRef.current &&
      !window.confirm("You have unsaved changes. Discard them and leave?")
    ) {
      return;
    }
    unsavedChangesRef.current = false;

    const previousDashboardHash = noteWorkspaceBackHashRef.current;
    noteWorkspaceBackHashRef.current = null;
    if (previousDashboardHash && isKnownDashboardHash(previousDashboardHash)) {
      window.history.back();
      return;
    }
    window.location.hash = "#/notes";
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
        : route === "folders" && location.folderId !== null
          ? "Notes saved in this folder."
          : routeContent[route].description;

  if (location.noteWorkspace) {
    const workspaceLocation = location.noteWorkspace;
    if (
      workspaceLocation.mode === "existing" &&
      dashboardState.status === "loading" &&
      selectedWorkspaceNote?.id !== workspaceLocation.noteId
    ) {
      return <NoteWorkspaceLoading />;
    }
    const workspaceNote =
      workspaceLocation.mode === "existing" &&
      (selectedWorkspaceNote?.id === workspaceLocation.noteId ||
        dashboardState.status === "ready")
        ? (selectedWorkspaceNote?.id === workspaceLocation.noteId
            ? selectedWorkspaceNote
            : null) ??
          (dashboardState.status === "ready"
            ? dashboardState.data.notes.find(
                (note) => note.id === workspaceLocation.noteId,
              ) ?? null
            : null)
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
          onBackToNotes={navigateBackFromNote}
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
        onBackToNotes={navigateBackFromNote}
        onDeleted={(noteId) => {
          savedNoteOverridesRef.current.delete(noteId);
          setSelectedWorkspaceNote((current) =>
            current?.id === noteId ? null : current,
          );
          unsavedChangesRef.current = false;
          refreshDashboard();
          navigateBackFromNote();
        }}
        onDirtyChange={(dirty) => {
          unsavedChangesRef.current = dirty;
        }}
        onSaved={(savedNote) => {
          savedNoteOverridesRef.current.set(savedNote.id, savedNote);
          setSelectedWorkspaceNote(savedNote);
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
        onFolderUpdated={(updatedNote) => {
          savedNoteOverridesRef.current.set(updatedNote.id, updatedNote);
          setSelectedWorkspaceNote(updatedNote);
          setDashboardState((current) =>
            current.status === "ready"
              ? {
                  status: "ready",
                  data: upsertDashboardNote(current.data, updatedNote),
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
                {route === "dashboard"
                  ? "Your learning space"
                  : route === "knowledge"
                    ? "AI Knowledge"
                    : pageTitle}
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
              onOpenNote={(noteId) => {
                window.location.hash = `#/notes/${noteId}`;
              }}
            />
          ) : route === "notes" ? (
            <NotesPage
              refreshKey={retryCount}
              onRetry={refreshDashboard}
              searchQuery={notesSearchQuery}
              onSearchQueryChange={setNotesSearchQuery}
              noteType={notesTypeFilter}
              onNoteTypeChange={setNotesTypeFilter}
              sortOrder={notesSortOrder}
              onSortOrderChange={setNotesSortOrder}
              page={notesPageNumber}
              onPageChange={setNotesPageNumber}
              onOpenNote={(noteId, note) => {
                savedNoteOverridesRef.current.set(noteId, note);
                setSelectedWorkspaceNote(note);
                window.location.hash = `#/notes/${noteId}`;
              }}
            />
          ) : route === "folders" ? (
            location.folderId === null ? (
              <FoldersPage />
            ) : (
              <FolderDetailPage
                key={location.folderId}
                folderId={location.folderId}
                onOpenNote={(noteId) => {
                  window.location.hash = `#/notes/${noteId}`;
                }}
              />
            )
          ) : route === "knowledge" ? (
            <DashboardKnowledgeWorkspace dashboardState={dashboardState} />
          ) : route === "search" ? (
            <FolderSearchPage />
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
  onOpenNote: (noteId: number) => void;
}

function DashboardHome({
  dashboardState,
  onRetry,
  onNavigateToNotes,
  onOpenNote,
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
          onOpenNote={onOpenNote}
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
  onOpenNote: (noteId: number) => void;
}

function RecentNotes({
  dashboardState,
  onRetry,
  onViewAll,
  onOpenNote,
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
        onSelectNote={onOpenNote}
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
  refreshKey,
  onRetry,
  searchQuery,
  onSearchQueryChange,
  noteType,
  onNoteTypeChange,
  sortOrder,
  onSortOrderChange,
  page,
  onPageChange,
  onOpenNote,
}: {
  refreshKey: number;
  onRetry: () => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  noteType: NoteTypeFilter;
  onNoteTypeChange: (value: NoteTypeFilter) => void;
  sortOrder: NoteSortOrder;
  onSortOrderChange: (value: NoteSortOrder) => void;
  page: number;
  onPageChange: (page: number) => void;
  onOpenNote: (noteId: number, note: DashboardNote) => void;
}) {
  const [notesPageState, setNotesPageState] = useState<NotesPageState>({
    queryKey: "",
    status: "loading",
  });
  const queryKey = JSON.stringify([
    page,
    searchQuery,
    noteType,
    sortOrder,
    refreshKey,
  ]);

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      loadDashboardNotesPage({
        page,
        search: searchQuery.trim(),
        noteType,
        sortOrder,
      })
        .then((data) => {
          if (active) {
            setNotesPageState({ queryKey, status: "ready", data });
          }
        })
        .catch((error: unknown) => {
          if (!active) return;
          setNotesPageState({
            queryKey,
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Could not load saved notes.",
          });
        });
    }, searchQuery.trim() ? 250 : 0);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [page, searchQuery, noteType, sortOrder, refreshKey, queryKey]);

  const currentNotesPageState =
    notesPageState.queryKey === queryKey
      ? notesPageState
      : { queryKey, status: "loading" as const };
  const pageData =
    currentNotesPageState.status === "ready"
      ? currentNotesPageState.data
      : null;
  const hasFilters = Boolean(searchQuery.trim()) || noteType !== "ALL";
  const paginationState: DashboardState =
    currentNotesPageState.status === "loading"
      ? { status: "loading" }
      : currentNotesPageState.status === "error"
        ? { status: "error", message: currentNotesPageState.message }
        : {
            status: "ready",
            data: {
              notes: pageData?.notes ?? [],
              totalNotes: pageData?.count ?? 0,
              recentlyCreatedNotes: 0,
              videoAssociatedNotes: 0,
              standaloneNotes: 0,
              recentNotes: [],
            },
          };
  const pageCount = pageData
    ? Math.max(1, Math.ceil(pageData.count / pageData.pageSize))
    : 1;

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
          <p>{pageData ? `${pageData.count} notes` : "Your saved notes"}</p>
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
            disabled={currentNotesPageState.status === "loading"}
            onClick={onRetry}
          >
            <RefreshCw
              className={
                currentNotesPageState.status === "loading"
                  ? "is-spinning"
                  : undefined
              }
              size={16}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
      <div className="notes-toolbar">
        <label className="notes-search">
          <span className="visually-hidden">Search notes</span>
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => {
              onSearchQueryChange(event.target.value);
              onPageChange(1);
            }}
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
              if (isNoteTypeFilter(value)) {
                onNoteTypeChange(value);
                onPageChange(1);
              }
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
              if (isNoteSortOrder(value)) {
                onSortOrderChange(value);
                onPageChange(1);
              }
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
        {pageData
          ? `${pageData.count} ${
              pageData.count === 1 ? "note" : "notes"
            }${hasFilters ? " match your search and filters" : ""}`
          : "Loading notes…"}
      </p>
      {pageData?.count === 0 && hasFilters ? (
        <div className="notes-no-matches" role="status">
          <Search size={19} aria-hidden="true" />
          <p>No matching notes. Try changing your search or note type.</p>
        </div>
      ) : (
        <NotesListState
          dashboardState={paginationState}
          notes={pageData?.notes ?? []}
          onRetry={onRetry}
          onViewNotes={onRetry}
          onSelectNote={(noteId) => {
            const selectedNote = pageData?.notes.find(
              (note) => note.id === noteId,
            );
            if (selectedNote) onOpenNote(noteId, selectedNote);
          }}
        />
      )}
      {pageData && pageData.count > pageData.pageSize && (
        <nav className="notes-pagination" aria-label="Notes pages">
          <button
            className="workspace-secondary-button"
            type="button"
            disabled={pageData.page <= 1}
            onClick={() => onPageChange(pageData.page - 1)}
          >
            Previous
          </button>
          <span aria-live="polite">
            Page {pageData.page} of {pageCount}
          </span>
          <button
            className="workspace-secondary-button"
            type="button"
            disabled={pageData.page >= pageCount}
            onClick={() => onPageChange(pageData.page + 1)}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}

type NotesPageState =
  | { queryKey: string; status: "loading" }
  | { queryKey: string; status: "error"; message: string }
  | {
      queryKey: string;
      status: "ready";
      data: Awaited<ReturnType<typeof loadDashboardNotesPage>>;
    };

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
        block.type === "image" ||
        block.type === "url" ||
        block.type === "code" ||
        block.type === "command" ||
        block.type === "bullet_list" ||
        block.type === "numbered_list" ||
        block.type === "screenshot"),
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

      if (block.type === "screenshot") {
        return "[Video screenshot]";
      }

      if (block.type === "url") {
        const urlText = block.content.trim();
        const title = typeof block.metadata?.title === "string"
          ? block.metadata.title
          : "";
        return urlText || title;
      }

      if (block.type === "bullet_list" || block.type === "numbered_list") {
        return getListItems(block.content).join("\n");
      }

      return block.content;
    })
    .filter((text) => text.trim().length > 0)
    .join("\n");
}

type NoteWorkspaceMode = "read" | "write";

interface NoteImprovementProposal {
  baseUpdatedAt: string;
  originalContent: string;
  originalType: NoteBlock["type"];
  suggestedContent: string;
}

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
  videoActionBackground: "#164e63",
  videoActionHoverBackground: "#0e7490",
  videoActionText: "#ecfeff",
  danger: "#f87171",
  shadow: "rgba(0, 0, 0, 0.38)",
};

interface NoteWorkspaceProps {
  location: Exclude<NoteWorkspaceLocation, null>;
  note: DashboardNote | null;
  onBackToNotes: () => void;
  onDeleted: (noteId: number) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (note: DashboardNote) => void;
  onFolderUpdated: (note: DashboardNote) => void;
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
            Back
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
  onDeleted,
  onDirtyChange,
  onSaved,
  onFolderUpdated,
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
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [isDeleteConfirmationOpen, setIsDeleteConfirmationOpen] =
    useState(false);
  const [isDeletingNote, setIsDeletingNote] = useState(false);
  const [isOrganizerOpen, setIsOrganizerOpen] = useState(false);
  const [newNoteFolder, setNewNoteFolder] = useState<DashboardFolder | null>(
    null,
  );
  const [noteProposals, setNoteProposals] = useState<
    Map<string, NoteImprovementProposal>
  >(() => new Map());
  const [assistanceLoadingIds, setAssistanceLoadingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [assistanceErrors, setAssistanceErrors] = useState<
    Map<string, string>
  >(() => new Map());
  const assistanceRequests = useRef(new Set<string>());
  const deleteRequestInFlight = useRef(false);
  const [thumbnailUnavailable, setThumbnailUnavailable] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const pageTitleRef = useRef<HTMLHeadingElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const cancelDeleteButtonRef = useRef<HTMLButtonElement>(null);
  const confirmDeleteButtonRef = useRef<HTMLButtonElement>(null);

  const serializedDocument = JSON.stringify(noteDocument);
  const serializedSavedDocument = JSON.stringify(savedDocument);
  const isDirty =
    (isNew
      ? title.length > 0 ||
        serializedDocument !== serializedSavedDocument ||
        newNoteFolder !== null
      : Boolean(
          note &&
            (title !== note.title ||
              serializedDocument !== serializedSavedDocument),
        ));

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    if (!isExportMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !exportMenuRef.current?.contains(event.target)
      ) {
        setIsExportMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsExportMenuOpen(false);
        exportMenuButtonRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isExportMenuOpen]);

  useEffect(() => {
    if (mode === "write") {
      titleInputRef.current?.focus();
    } else {
      pageTitleRef.current?.focus();
    }
  }, [mode]);

  useEffect(() => {
    if (!isDeleteConfirmationOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isDeletingNote) {
        setIsDeleteConfirmationOpen(false);
        deleteButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;

      const cancelButton = cancelDeleteButtonRef.current;
      const confirmButton = confirmDeleteButtonRef.current;
      if (!cancelButton || !confirmButton) return;

      if (event.shiftKey && document.activeElement === cancelButton) {
        event.preventDefault();
        confirmButton.focus();
      } else if (
        !event.shiftKey &&
        document.activeElement === confirmButton
      ) {
        event.preventDefault();
        cancelButton.focus();
      }
    };

    cancelDeleteButtonRef.current?.focus();
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isDeleteConfirmationOpen, isDeletingNote]);

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
    setNoteProposals(new Map());
    setAssistanceErrors(new Map());
    onDirtyChange(false);
    setMode("read");
  };

  const improveBlock = async (block: NoteBlock) => {
    if (
      isNew ||
      !note ||
      !note.updated_at ||
      assistanceRequests.current.has(block.id)
    ) {
      return;
    }

    assistanceRequests.current.add(block.id);
    setAssistanceLoadingIds((current) => new Set(current).add(block.id));
    setAssistanceErrors((current) => {
      const next = new Map(current);
      next.delete(block.id);
      return next;
    });

    try {
      const proposal = await requestNoteImprovement(
        note.id,
        block.id,
        note.updated_at,
      );
      setNoteProposals((current) => {
        const next = new Map(current);
        next.set(block.id, {
          baseUpdatedAt: proposal.base_updated_at,
          originalContent: block.content,
          originalType: block.type,
          suggestedContent: proposal.result.text,
        });
        return next;
      });
    } catch (error) {
      const message =
        error instanceof NoteAssistanceApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "AI assistance failed. Please try again.";
      setAssistanceErrors((current) => {
        const next = new Map(current);
        next.set(block.id, message);
        return next;
      });
    } finally {
      assistanceRequests.current.delete(block.id);
      setAssistanceLoadingIds((current) => {
        const next = new Set(current);
        next.delete(block.id);
        return next;
      });
    }
  };

  const renderBlockAssistance = (block: NoteBlock) => {
    if (
      block.type !== "paragraph" &&
      block.type !== "heading" &&
      block.type !== "equation"
    ) {
      return null;
    }

    const persistedBlockMatches = Boolean(
      note &&
        !isNew &&
        note.updated_at &&
        savedDocument.blocks.filter(
          (savedBlock) => savedBlock.id === block.id,
        ).length === 1 &&
        savedDocument.blocks.some(
          (savedBlock) =>
            savedBlock.id === block.id &&
            savedBlock.type === block.type &&
            savedBlock.content === block.content,
        ),
    );
    const pending = assistanceLoadingIds.has(block.id);
    const proposal = noteProposals.get(block.id);
    const proposalVersionMatches =
      proposal?.baseUpdatedAt === note?.updated_at;
    const proposalMatchesCurrentBlock =
      proposal?.originalContent === block.content &&
      proposal.originalType === block.type &&
      proposalVersionMatches;
    const blockIdIsUnique =
      noteDocument.blocks.filter(
        (currentBlock) => currentBlock.id === block.id,
      ).length === 1;
    const canAccept =
      Boolean(proposal && proposalMatchesCurrentBlock && blockIdIsUnique) &&
      !pending;
    const unsavedBlock =
      !isNew && note !== null && !persistedBlockMatches;
    const disabled =
      isNew ||
      !note?.updated_at ||
      unsavedBlock ||
      !blockIdIsUnique ||
      !block.content.trim() ||
      pending ||
      isSaving;
    const unavailableMessage = isNew
      ? "Save this note before using AI assistance."
      : unsavedBlock
        ? "Save this note before using AI assistance."
        : !blockIdIsUnique
          ? "This block cannot be targeted because its ID is not unique."
          : !block.content.trim()
            ? "Add text to this block before using AI assistance."
            : null;

    return (
      <div className="note-ai-assistance">
        <button
          className="note-ai-improve-button"
          type="button"
          disabled={disabled}
          onClick={() => void improveBlock(block)}
          aria-label={`Improve selected ${block.type} block`}
        >
          <Sparkles size={13} aria-hidden="true" />
          {pending ? "Improving…" : "Improve"}
        </button>
        {unavailableMessage && (
          <p className="note-ai-assistance-hint">{unavailableMessage}</p>
        )}
        {assistanceErrors.has(block.id) && (
          <div className="workspace-save-error note-ai-assistance-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" />
            <p>{assistanceErrors.get(block.id)}</p>
          </div>
        )}
        {proposal && (
          <section
            className="note-ai-proposal"
            aria-label={`AI suggestion for ${block.type} block`}
          >
            <p className="note-ai-proposal-label">
              <Sparkles size={13} aria-hidden="true" />
              AI suggestion
            </p>
            <p className="note-ai-proposal-original">
              <strong>Original</strong>
              <span>{proposal.originalContent}</span>
            </p>
            <p className="note-ai-proposal-suggestion">
              <strong>Suggestion</strong>
              <span>{proposal.suggestedContent}</span>
            </p>
            {!proposalMatchesCurrentBlock && (
              <p className="note-ai-assistance-hint">
                {proposalVersionMatches
                  ? "This block changed after the suggestion was requested. Request a new suggestion before accepting."
                  : "This note changed after the suggestion was requested. Refresh the note and try again."}
              </p>
            )}
            <div className="note-ai-proposal-actions">
              <button
                className="note-ai-accept-button"
                type="button"
                disabled={!canAccept}
                onClick={() => {
                  if (!proposal || !canAccept) return;
                  setNoteDocument((current) => ({
                    ...current,
                    blocks: current.blocks.map((currentBlock) =>
                      currentBlock.id === block.id &&
                      currentBlock.content === proposal.originalContent &&
                      currentBlock.type === proposal.originalType
                        ? {
                            ...currentBlock,
                            content: proposal.suggestedContent,
                          }
                        : currentBlock,
                    ),
                  }));
                  setNoteProposals((current) => {
                    const next = new Map(current);
                    next.delete(block.id);
                    return next;
                  });
                }}
              >
                <Check size={13} aria-hidden="true" />
                Accept
              </button>
              <button
                className="note-ai-reject-button"
                type="button"
                onClick={() => {
                  setNoteProposals((current) => {
                    const next = new Map(current);
                    next.delete(block.id);
                    return next;
                  });
                }}
              >
                Reject
              </button>
            </div>
          </section>
        )}
      </div>
    );
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
          folder: newNoteFolder?.id ?? null,
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

  const getExportSource = (): VideoNote | NoteDocument | null => {
    setSaveError(null);

    if (
      !isNew &&
      (!note?.document ||
        note.document.version !== 1 ||
        !Array.isArray(note.document.blocks))
    ) {
      setSaveError(
        "This note does not have a valid structured document to export.",
      );
      return null;
    }

    return note
      ? { ...note, title, document: noteDocument }
      : noteDocument;
  };

  const downloadExport = (
    content: string,
    mimeType: string,
    extension: ".md" | ".html",
  ) => {
    const blob = new Blob([content], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    let anchor: HTMLAnchorElement | null = null;
    try {
      anchor = window.document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = exportFilename(title, extension);
      anchor.hidden = true;
      window.document.body.append(anchor);
      anchor.click();
    } finally {
      anchor?.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }
  };

  const exportMarkdown = () => {
    const source = getExportSource();
    if (!source) return;

    try {
      downloadExport(
        exportNoteAsMarkdown(source),
        "text/markdown;charset=utf-8",
        ".md",
      );
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? `Could not export this note: ${error.message}`
          : "Could not export this note.",
      );
    }
  };

  const exportHtml = () => {
    const source = getExportSource();
    if (!source) return;

    try {
      downloadExport(
        exportNoteToHtml(source),
        "text/html;charset=utf-8",
        ".html",
      );
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? `Could not export this note as HTML: ${error.message}`
          : "Could not export this note as HTML.",
      );
    }
  };

  const exportPdf = () => {
    const source = getExportSource();
    if (!source) return;

    let objectUrl: string | null = null;
    let printWindow: Window | null = null;
    try {
      const html = exportNoteToHtml(source);
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      objectUrl = URL.createObjectURL(blob);
      printWindow = window.open("about:blank", "_blank");
      if (!printWindow) {
        throw new Error("The print window was blocked by the browser.");
      }

      const printDocument = printWindow;
      const printUrl = objectUrl;
      printDocument.opener = null;
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        URL.revokeObjectURL(printUrl);
      };

      printDocument.addEventListener(
        "afterprint",
        () => {
          cleanup();
          printDocument.close();
        },
        { once: true },
      );
      printDocument.addEventListener(
        "error",
        () => {
          cleanup();
          setSaveError("Could not load the note for PDF printing.");
        },
        { once: true },
      );
      printDocument.addEventListener(
        "load",
        () => {
          printDocument.addEventListener("beforeunload", cleanup, {
            once: true,
          });
          try {
            printDocument.focus();
            printDocument.print();
          } catch (error) {
            cleanup();
            printDocument.close();
            setSaveError(
              error instanceof Error
                ? `Could not open the PDF print dialog: ${error.message}`
                : "Could not open the PDF print dialog.",
            );
          }
        },
        { once: true },
      );
      printDocument.location.href = printUrl;
      setSaveError(null);
    } catch (error) {
      if (printWindow && !printWindow.closed) {
        printWindow.close();
      }
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
      setSaveError(
        error instanceof Error
          ? `Could not prepare PDF printing: ${error.message}`
          : "Could not prepare PDF printing.",
      );
    }
  };

  const selectExport = (exportAction: () => void) => {
    setIsExportMenuOpen(false);
    exportMenuButtonRef.current?.focus();
    exportAction();
  };

  const confirmDeleteNote = async () => {
    if (!note || isNew || deleteRequestInFlight.current) return;

    deleteRequestInFlight.current = true;
    setIsDeletingNote(true);
    setSaveError(null);
    try {
      await deleteDashboardNote(note.id);
      onDeleted(note.id);
    } catch (error) {
      if (error instanceof DashboardNoteNotFoundError) {
        onDeleted(note.id);
        return;
      }
      setIsDeleteConfirmationOpen(false);
      setSaveError(
        error instanceof Error
          ? `Could not delete this note: ${error.message}`
          : "Could not delete this note.",
      );
      deleteRequestInFlight.current = false;
      setIsDeletingNote(false);
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
            <span>Back</span>
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
                  setIsExportMenuOpen(false);
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
            <div className="workspace-heading-actions">
              {mode === "read" && note && (
                <>
                  <div className="workspace-export-menu" ref={exportMenuRef}>
                    <button
                      ref={exportMenuButtonRef}
                      className="workspace-secondary-button workspace-export-trigger"
                      type="button"
                      aria-label="Export note"
                      aria-expanded={isExportMenuOpen}
                      aria-controls="workspace-export-options"
                      onClick={() => setIsExportMenuOpen((open) => !open)}
                    >
                      <Download size={15} aria-hidden="true" />
                      Export
                      <ChevronDown size={14} aria-hidden="true" />
                    </button>
                    {isExportMenuOpen && (
                      <div
                        className="workspace-export-options"
                        id="workspace-export-options"
                        aria-label="Export format"
                      >
                        <button
                          type="button"
                          onClick={() => selectExport(exportMarkdown)}
                        >
                          Export Markdown
                        </button>
                        <button
                          type="button"
                          onClick={() => selectExport(exportHtml)}
                        >
                          Export HTML
                        </button>
                        <button
                          type="button"
                          onClick={() => selectExport(exportPdf)}
                        >
                          Export PDF
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    ref={deleteButtonRef}
                    className="workspace-delete-button"
                    type="button"
                    onClick={() => {
                      setSaveError(null);
                      setIsDeleteConfirmationOpen(true);
                    }}
                    disabled={isSaving || isDeletingNote}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                    Delete
                  </button>
                </>
              )}
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
          </div>

          <div className="note-folder-organize-row">
            <div>
              <span className="note-folder-organize-label">
                {isNew ? "Save to" : "Folder"}
              </span>
              <FolderPath
                path={
                  isNew
                    ? newNoteFolder?.breadcrumbs ??
                      (newNoteFolder
                        ? [{ id: newNoteFolder.id, name: newNoteFolder.name }]
                        : [])
                    : note?.folder_path ?? []
                }
                className="note-folder-organize-path"
                emptyLabel={
                  isNew || note?.folder == null
                    ? "No Folder"
                    : "Folder path unavailable"
                }
              />
            </div>
            <button
              className="workspace-secondary-button"
              type="button"
              onClick={() => setIsOrganizerOpen(true)}
              disabled={isSaving}
            >
              <Folder size={15} aria-hidden="true" />
              {isNew ? "Choose Folder" : "Organize"}
            </button>
          </div>

          {isOrganizerOpen && (
            <FolderOrganizerDialog
              initialFolderId={
                isNew ? newNoteFolder?.id ?? null : note?.folder ?? null
              }
              onCancel={() => setIsOrganizerOpen(false)}
              onSaveHere={async (folderId, folder) => {
                if (isNew) {
                  setNewNoteFolder(folder);
                  setIsOrganizerOpen(false);
                  return;
                }
                if (!note) {
                  throw new Error("This note is no longer available.");
                }
                if ((note.folder ?? null) !== folderId) {
                  const updatedNote = await updateDashboardNoteFolder(
                    note.id,
                    folderId,
                  );
                  onFolderUpdated(updatedNote);
                }
                setIsOrganizerOpen(false);
              }}
            />
          )}

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
                  renderBlockAssistance={renderBlockAssistance}
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
      {isDeleteConfirmationOpen && note && (
        <div className="note-delete-backdrop">
          <section
            className="note-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="note-delete-title"
            aria-describedby="note-delete-description"
          >
            <div>
              <p className="eyebrow">DELETE NOTE</p>
              <h2 id="note-delete-title">Delete this note?</h2>
            </div>
            <p id="note-delete-description">
              “{note.title.trim() || "Untitled note"}” will be permanently
              deleted. This cannot be undone.
            </p>
            <div className="folder-form-actions">
              <button
                ref={cancelDeleteButtonRef}
                className="workspace-secondary-button"
                type="button"
                onClick={() => setIsDeleteConfirmationOpen(false)}
                disabled={isDeletingNote}
              >
                Cancel
              </button>
              <button
                ref={confirmDeleteButtonRef}
                className="folder-delete-button"
                type="button"
                onClick={() => void confirmDeleteNote()}
                disabled={isDeletingNote}
              >
                <Trash2 size={14} aria-hidden="true" />
                {isDeletingNote ? "Deleting…" : "Delete note"}
              </button>
            </div>
          </section>
        </div>
      )}
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

function exportFilename(title: string, extension: ".md" | ".html"): string {
  const safeBaseName = title
    .replace(/[<>:"/\\|?*]/g, "-")
    .trim()
    .replace(/[. ]+$/g, "")
    .replace(/\.(?:md|html?)$/i, "")
    .trim()
    .replace(/[. ]+$/g, "");
  return `${safeBaseName || "note"}${extension}`;
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
    <NoteRows
      notes={notes}
      onSelectNote={onSelectNote}
      compact={compact}
      totalNotes={dashboardState.data.totalNotes}
      onViewNotes={onViewNotes}
    />
  );
}

function NoteRows({
  notes,
  onSelectNote,
  compact = false,
  totalNotes,
  onViewNotes,
}: {
  notes: Array<VideoNote & { folder_path?: DashboardFolderPathItem[] }>;
  onSelectNote?: (noteId: number) => void;
  compact?: boolean;
  totalNotes?: number;
  onViewNotes?: () => void;
}) {
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
              <div className="note-row-select-button is-static">
                {rowContent}
              </div>
            )}
            <FolderPath
              path={note.folder_path ?? []}
              className="note-row-folder-path"
              emptyLabel={
                note.folder == null ? "No Folder" : "Folder path unavailable"
              }
            />
          </article>
        );
      })}
      {compact &&
        totalNotes !== undefined &&
        totalNotes > notes.length &&
        onViewNotes && (
          <button className="notes-view-more" type="button" onClick={onViewNotes}>
            View all {totalNotes} notes
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        )}
    </div>
  );
}

function FolderPath({
  path,
  className,
  emptyLabel = "No Folder",
}: {
  path: DashboardFolderPathItem[];
  className: string;
  emptyLabel?: string;
}) {
  return (
    <nav className={className} aria-label="Folder path">
      {path.length === 0 ? (
        <span>{emptyLabel}</span>
      ) : (
        path.map((folder, index) => (
          <span className="folder-path-segment" key={folder.id}>
            {index > 0 && <span aria-hidden="true">/</span>}
            <a href={`#/folders/${folder.id}`}>{folder.name}</a>
          </span>
        ))
      )}
    </nav>
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

type DashboardVideoContext = {
  youtubeId: string;
  databaseId: number | null;
  title: string;
  channelName: string;
  thumbnailUrl: string | null;
};

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function getDashboardVideoContexts(
  dashboardState: DashboardState,
): DashboardVideoContext[] {
  if (dashboardState.status !== "ready") return [];

  const contexts = new Map<string, DashboardVideoContext>();
  for (const note of dashboardState.data.notes) {
    const metadata = note.video_detail;
    if (note.video === null || !metadata || metadata.youtube_id === undefined) {
      continue;
    }
    const youtubeId = metadata.youtube_id;
    if (!YOUTUBE_ID_PATTERN.test(youtubeId)) continue;

    const candidate: DashboardVideoContext = {
      youtubeId,
      databaseId: metadata.id ?? note.video ?? null,
      title: metadata.title?.trim() || "Untitled video",
      channelName:
        metadata.channel_name?.trim() ||
        metadata.channel_handle?.trim() ||
        "",
      thumbnailUrl: safeExternalHttpUrl(metadata.thumbnail_url),
    };
    const existing = contexts.get(youtubeId);
    if (
      !existing ||
      (existing.title === "Untitled video" &&
        candidate.title !== "Untitled video") ||
      (!existing.thumbnailUrl && candidate.thumbnailUrl)
    ) {
      contexts.set(youtubeId, candidate);
    }
  }
  return [...contexts.values()];
}

function sourceTypeLabel(source: ConversationSource): string {
  const sourceType = source.metadata.source_type;
  if (sourceType === "NOTE") return "Note";
  if (sourceType === "VIDEO_TRANSCRIPT") return "Video transcript";
  if (sourceType === "VIDEO_ANALYSIS") return "Video analysis";
  return source.video_id === null ? "Personal knowledge" : "Video knowledge";
}

function metadataTimestamp(source: ConversationSource): number | null {
  if (source.metadata.source_type !== "VIDEO_TRANSCRIPT") return null;
  const seconds = source.metadata.start_seconds;
  return typeof seconds === "number" &&
    Number.isFinite(seconds) &&
    seconds >= 0
    ? Math.floor(seconds)
    : null;
}

function conversationScopeLabel(scope: ConversationScope): string {
  if (scope === "CURRENT_VIDEO") return "Current video";
  if (scope === "COMBINED") return "Video + My Knowledge";
  return "My Knowledge";
}

function conversationErrorMessage(error: unknown): string {
  if (error instanceof ConversationApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Your session is not authorized. Sign in again and retry.";
    }
    if (error.status === 404) {
      return "This conversation or video context is no longer available.";
    }
    return error.message;
  }
  return error instanceof Error
    ? error.message
    : "The Conversations service could not complete the request.";
}

function conversationUpdatedLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Recently updated";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}

function truncateConversationTitle(value: string): string {
  const title = value.trim();
  return title.length > 120 ? `${title.slice(0, 117)}...` : title;
}

function DashboardKnowledgeWorkspace({
  dashboardState,
}: {
  dashboardState: DashboardState;
}) {
  const videos = getDashboardVideoContexts(dashboardState);
  const notes =
    dashboardState.status === "ready" ? dashboardState.data.notes : [];
  const [scope, setScope] = useState<AskRAGScope>("PERSONAL_KB");
  const [youtubeId, setYoutubeId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(
    null,
  );
  const [activeConversation, setActiveConversation] =
    useState<ConversationDetail | null>(null);
  const [isConversationListLoading, setIsConversationListLoading] =
    useState(true);
  const [isConversationLoading, setIsConversationLoading] = useState(false);
  const [isAsking, setIsAsking] = useState(false);
  const [deletingConversationId, setDeletingConversationId] = useState<
    number | null
  >(null);
  const [question, setQuestion] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [failedQuestion, setFailedQuestion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const conversationRequestVersion = useRef(0);
  const conversationThreadRef = useRef<HTMLDivElement>(null);
  const shouldFollowConversationRef = useRef(true);
  const normalizedYoutubeId = (youtubeId ?? videos[0]?.youtubeId ?? "").trim();
  const validVideoContext = YOUTUBE_ID_PATTERN.test(normalizedYoutubeId);
  const currentConversationScope = activeConversation?.scope ?? scope;
  const canAsk =
    question.trim().length > 0 &&
    (activeConversation !== null ||
      scope === "PERSONAL_KB" ||
      validVideoContext) &&
    !isAsking &&
    !isConversationLoading;

  useEffect(() => {
    let active = true;
    listConversations()
      .then((items) => {
        if (!active) return;
        setConversations(items);
        setListError(null);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setListError(conversationErrorMessage(loadError));
      })
      .finally(() => {
        if (active) setIsConversationListLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function refreshConversations() {
    try {
      const items = await listConversations();
      setConversations(items);
      setListError(null);
    } catch (loadError) {
      setListError(conversationErrorMessage(loadError));
    }
  }

  function startNewConversation() {
    conversationRequestVersion.current += 1;
    shouldFollowConversationRef.current = true;
    setActiveConversationId(null);
    setActiveConversation(null);
    setQuestion("");
    setPendingQuestion(null);
    setFailedQuestion(null);
    setError(null);
    setScope("PERSONAL_KB");
    setYoutubeId(null);
  }

  async function openConversation(conversationId: number) {
    const requestVersion = ++conversationRequestVersion.current;
    shouldFollowConversationRef.current = true;
    setActiveConversationId(conversationId);
    setActiveConversation(null);
    setQuestion("");
    setPendingQuestion(null);
    setFailedQuestion(null);
    setError(null);
    setIsConversationLoading(true);
    try {
      const conversation = await getConversation(conversationId);
      if (requestVersion !== conversationRequestVersion.current) return;
      setActiveConversation(conversation);
      setScope(conversation.scope);
      setYoutubeId(conversation.youtube_id);
    } catch (loadError) {
      if (requestVersion === conversationRequestVersion.current) {
        setError(conversationErrorMessage(loadError));
      }
    } finally {
      if (requestVersion === conversationRequestVersion.current) {
        setIsConversationLoading(false);
      }
    }
  }

  async function handleAsk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAsk) return;

    const submittedQuestion = question.trim();
    setError(null);
    setPendingQuestion(submittedQuestion);
    setFailedQuestion(null);
    setIsAsking(true);
    shouldFollowConversationRef.current = true;
    let conversationId = activeConversation?.id ?? null;
    const previousMessageCount = activeConversation?.messages.length ?? 0;
    try {
      if (conversationId === null) {
        const created = await createConversation({
          title: truncateConversationTitle(submittedQuestion),
          scope,
          youtube_id: scope === "PERSONAL_KB" ? null : normalizedYoutubeId,
        });
        conversationId = created.id;
        setActiveConversationId(created.id);
        setActiveConversation({ ...created, messages: [] });
        setConversations((current) => [
          created,
          ...current.filter((item) => item.id !== created.id),
        ]);
      }

      const turn = await askConversation(conversationId, submittedQuestion);
      setActiveConversation((current) => {
        if (!current || current.id !== conversationId) return current;
        return {
          ...turn.conversation,
          messages: [
            ...current.messages,
            turn.user_message,
            turn.assistant_message,
          ],
        };
      });
      setPendingQuestion(null);
      setFailedQuestion(null);
      setConversations((current) => [
        turn.conversation,
        ...current.filter((item) => item.id !== turn.conversation.id),
      ]);
      setQuestion("");
      void refreshConversations();
    } catch (askError) {
      setError(conversationErrorMessage(askError));
      setPendingQuestion(null);
      setFailedQuestion(submittedQuestion);
      if (conversationId !== null) {
        void getConversation(conversationId)
          .then((conversation) => {
            setActiveConversation((current) =>
              current?.id === conversation.id ? conversation : current,
            );
            if (
              conversation.messages.slice(previousMessageCount).some(
                (message) =>
                  message.role === "USER" &&
                  message.content === submittedQuestion,
              )
            ) {
              setFailedQuestion((current) =>
                current === submittedQuestion ? null : current,
              );
            }
          })
          .catch((refreshError: unknown) => {
            console.error(
              "[YouTube Knowledge] Could not refresh the conversation after an ask failure:",
              refreshError,
            );
          });
      }
    } finally {
      setIsAsking(false);
    }
  }

  useEffect(() => {
    const thread = conversationThreadRef.current;
    if (!thread || !shouldFollowConversationRef.current) return;
    thread.scrollTop = thread.scrollHeight;
  }, [
    activeConversation?.messages.length,
    activeConversationId,
    failedQuestion,
    isAsking,
    isConversationLoading,
    pendingQuestion,
  ]);

  function handleConversationThreadScroll() {
    const thread = conversationThreadRef.current;
    if (!thread) return;
    shouldFollowConversationRef.current =
      thread.scrollHeight - thread.scrollTop - thread.clientHeight < 96;
  }

  async function handleDeleteConversation(conversation: Conversation) {
    if (
      !window.confirm(`Delete "${conversation.title}" and its messages?`)
    ) {
      return;
    }
    const previousConversations = conversations;
    const previousActiveConversation = activeConversation;
    setDeletingConversationId(conversation.id);
    setConversations((current) =>
      current.filter((item) => item.id !== conversation.id),
    );
    if (activeConversationId === conversation.id) {
      setActiveConversationId(null);
      setActiveConversation(null);
      setQuestion("");
    }
    setError(null);
    try {
      await deleteConversation(conversation.id);
    } catch (deleteError) {
      setError(conversationErrorMessage(deleteError));
      setConversations(previousConversations);
      if (previousActiveConversation?.id === conversation.id) {
        setActiveConversationId(conversation.id);
        setActiveConversation(previousActiveConversation);
      }
    } finally {
      setDeletingConversationId(null);
    }
  }

  async function handleRenameConversation(conversation: Conversation) {
    const proposedTitle = window.prompt(
      "Conversation title",
      conversation.title,
    );
    if (proposedTitle === null || !proposedTitle.trim()) return;
    try {
      const renamed = await renameConversation(
        conversation.id,
        truncateConversationTitle(proposedTitle),
      );
      setConversations((current) =>
        current.map((item) => (item.id === renamed.id ? renamed : item)),
      );
      setActiveConversation((current) =>
        current?.id === renamed.id ? { ...current, ...renamed } : current,
      );
    } catch (renameError) {
      setError(conversationErrorMessage(renameError));
    }
  }

  function sourceVideo(
    source: ConversationSource,
    sourceScope: ConversationScope,
    sourceYoutubeId: string | null,
  ): DashboardVideoContext | null {
    const note = notes.find((item) => item.id === source.note_id);
    const noteVideo = note?.video_detail;
    const noteVideoId = source.youtube_id ?? noteVideo?.youtube_id;
    if (noteVideoId && YOUTUBE_ID_PATTERN.test(noteVideoId)) {
      return videos.find((video) => video.youtubeId === noteVideoId) ?? {
        youtubeId: noteVideoId,
        databaseId: noteVideo?.id ?? note?.video ?? null,
        title: noteVideo?.title?.trim() || "Video",
        channelName:
          noteVideo?.channel_name?.trim() ||
          noteVideo?.channel_handle?.trim() ||
          "",
        thumbnailUrl: safeExternalHttpUrl(noteVideo?.thumbnail_url),
      };
    }

    const matchedVideo = videos.find(
      (video) =>
        source.video_id !== null && video.databaseId === source.video_id,
    );
    if (matchedVideo) return matchedVideo;

    if (
      sourceScope === "CURRENT_VIDEO" &&
      source.video_id !== null &&
      sourceYoutubeId !== null &&
      YOUTUBE_ID_PATTERN.test(sourceYoutubeId)
    ) {
      return {
        youtubeId: sourceYoutubeId,
        databaseId: source.video_id,
        title: "Selected video",
        channelName: "",
        thumbnailUrl: null,
      };
    }
    return null;
  }

  return (
    <section className="knowledge-workspace" aria-labelledby="knowledge-heading">
      <div className="knowledge-conversation-layout">
        <aside
          className="content-card knowledge-conversation-sidebar"
          aria-label="AI conversations"
        >
          <div className="knowledge-conversation-list-heading">
            <h2>Conversations</h2>
            <button
              className="knowledge-new-conversation"
              type="button"
              onClick={startNewConversation}
            >
              <Plus size={15} aria-hidden="true" />
              New conversation
            </button>
          </div>
          {listError && (
            <div className="knowledge-error" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              <span>{listError}</span>
              <button
                className="knowledge-list-retry"
                type="button"
                onClick={() => void refreshConversations()}
              >
                Retry
              </button>
            </div>
          )}
          {isConversationListLoading ? (
            <p className="knowledge-conversation-list-status" role="status">
              Loading conversations...
            </p>
          ) : conversations.length === 0 ? (
            <p className="knowledge-conversation-list-status">
              Your saved conversations will appear here.
            </p>
          ) : (
            <ul className="knowledge-conversation-list">
              {conversations.map((conversation) => {
                const video = videos.find(
                  (item) => item.youtubeId === conversation.youtube_id,
                );
                return (
                  <li key={conversation.id}>
                    <button
                      className={`knowledge-conversation-item${
                        activeConversationId === conversation.id
                          ? " is-active"
                          : ""
                      }`}
                      type="button"
                      aria-current={
                        activeConversationId === conversation.id
                          ? "page"
                          : undefined
                      }
                      onClick={() => void openConversation(conversation.id)}
                    >
                      <strong>{conversation.title}</strong>
                      <span>
                        {conversationScopeLabel(conversation.scope)}
                        {conversation.youtube_id
                          ? ` · ${video?.title || conversation.youtube_id}`
                          : ""}
                      </span>
                      <time dateTime={conversation.updated_at}>
                        {conversationUpdatedLabel(conversation.updated_at)}
                      </time>
                    </button>
                    <div className="knowledge-conversation-actions">
                      <button
                        type="button"
                        aria-label={`Rename ${conversation.title}`}
                        onClick={() => void handleRenameConversation(conversation)}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${conversation.title}`}
                        disabled={deletingConversationId === conversation.id}
                        onClick={() =>
                          void handleDeleteConversation(conversation)
                        }
                      >
                        {deletingConversationId === conversation.id
                          ? "Deleting..."
                          : "Delete"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <div className="knowledge-conversation-main">
          <div
            className={`content-card knowledge-question-card knowledge-chat-panel${
              activeConversationId !== null ? " is-chat-active" : ""
            }`}
          >
            <div className="knowledge-card-heading">
              <span className="knowledge-icon">
                <Brain size={19} aria-hidden="true" />
              </span>
              <div>
                <h2 id="knowledge-heading">
                  {activeConversation
                    ? activeConversation.title
                    : "Start a new AI conversation"}
                </h2>
                <p>
                  {activeConversation
                    ? conversationScopeLabel(activeConversation.scope)
                    : "Choose your knowledge context, then ask a question."}
                </p>
              </div>
              {activeConversation && (
                <button
                  className="knowledge-rename-active"
                  type="button"
                  onClick={() => void handleRenameConversation(activeConversation)}
                >
                  Rename
                </button>
              )}
            </div>

            {!activeConversation &&
              !isConversationLoading &&
              !pendingQuestion &&
              !failedQuestion && (
              <div className="knowledge-form knowledge-start-form">
                <label className="knowledge-field">
                  <span>Knowledge context</span>
                  <select
                    value={scope}
                    disabled={isAsking}
                    onChange={(event) => {
                      const nextScope = event.target.value;
                      if (
                        nextScope === "CURRENT_VIDEO" ||
                        nextScope === "PERSONAL_KB" ||
                        nextScope === "COMBINED"
                      ) {
                        setScope(nextScope);
                        setError(null);
                      }
                    }}
                  >
                    <option value="CURRENT_VIDEO">Current Video</option>
                    <option value="PERSONAL_KB">My Knowledge</option>
                    <option value="COMBINED">Video + My Knowledge</option>
                  </select>
                </label>
                {scope !== "PERSONAL_KB" && (
                  <div className="knowledge-video-context">
                    <label
                      className="knowledge-field"
                      htmlFor="knowledge-video-id"
                    >
                      <span>YouTube video ID</span>
                      <input
                        id="knowledge-video-id"
                        type="text"
                        list="dashboard-knowledge-videos"
                        value={youtubeId ?? videos[0]?.youtubeId ?? ""}
                        placeholder="Enter an 11-character YouTube ID"
                        autoComplete="off"
                        disabled={isAsking}
                        aria-invalid={
                          normalizedYoutubeId.length > 0 && !validVideoContext
                        }
                        aria-describedby="knowledge-video-help"
                        onChange={(event) => {
                          setYoutubeId(event.target.value);
                          setError(null);
                        }}
                      />
                      <datalist id="dashboard-knowledge-videos">
                        {videos.map((video) => (
                          <option
                            key={video.youtubeId}
                            value={video.youtubeId}
                            label={video.title}
                          />
                        ))}
                      </datalist>
                      <span
                        id="knowledge-video-help"
                        className="knowledge-field-help"
                      >
                        {validVideoContext
                          ? "Use a saved video suggestion or enter another valid YouTube ID."
                          : "Choose a saved video suggestion or enter a valid 11-character ID."}
                      </span>
                    </label>
                    {validVideoContext && (
                      <div className="knowledge-video-preview">
                        {videos.find(
                          (video) => video.youtubeId === normalizedYoutubeId,
                        )?.thumbnailUrl ? (
                          <img
                            src={
                              videos.find(
                                (video) =>
                                  video.youtubeId === normalizedYoutubeId,
                              )?.thumbnailUrl ?? undefined
                            }
                            alt=""
                            loading="lazy"
                          />
                        ) : (
                          <span className="knowledge-video-placeholder">
                            <Video size={18} aria-hidden="true" />
                          </span>
                        )}
                        <div>
                          <strong>
                            {videos.find(
                              (video) =>
                                video.youtubeId === normalizedYoutubeId,
                            )?.title || "Selected YouTube video"}
                          </strong>
                          <code>{normalizedYoutubeId}</code>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeConversation && (
              <div className="knowledge-active-context">
                <Sparkles size={14} aria-hidden="true" />
                <span>
                  {conversationScopeLabel(activeConversation.scope)}
                  {activeConversation.youtube_id
                    ? ` · ${activeConversation.youtube_id}`
                    : ""}
                </span>
              </div>
            )}

            {error && (
              <div className="knowledge-error" role="alert">
                <AlertCircle size={17} aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            {activeConversationId !== null &&
              (isConversationLoading || !activeConversation) && (
                <div className="knowledge-answer-loading" role="status">
                  <span />
                  <span />
                  <p>Loading conversation...</p>
                </div>
              )}

            <div
              className="knowledge-thread"
              aria-live="polite"
              ref={conversationThreadRef}
              onScroll={handleConversationThreadScroll}
            >
              {activeConversation?.messages.map((message) => (
                <article
                  className={`knowledge-message knowledge-chat-message is-${message.role.toLowerCase()}`}
                  key={message.id}
                >
                  <div className="knowledge-message-heading">
                    <strong>
                      {message.role === "USER" ? "You" : "AI"}
                    </strong>
                    <time dateTime={message.created_at}>
                      {conversationUpdatedLabel(message.created_at)}
                    </time>
                  </div>
                  <p className="knowledge-answer-text">{message.content}</p>
                  {message.role === "ASSISTANT" && (
                    <div className="knowledge-sources">
                      <div className="knowledge-sources-heading">
                        <h3>Sources</h3>
                        <span>
                          {message.sources.length}{" "}
                          {message.sources.length === 1 ? "source" : "sources"}
                        </span>
                      </div>
                      {message.sources.length === 0 ? (
                        <p className="knowledge-no-sources">
                          No matching sources were found for this answer.
                        </p>
                      ) : (
                        <div className="knowledge-source-list">
                          {message.sources.map((source, index) => {
                            const note = notes.find(
                              (item) => item.id === source.note_id,
                            );
                            const video = sourceVideo(
                              source,
                              activeConversation.scope,
                              activeConversation.youtube_id,
                            );
                            const timestamp = metadataTimestamp(source);
                            const timestampUrl =
                              timestamp === null
                                ? null
                                : getYoutubeWatchUrl(
                                    video?.youtubeId,
                                    timestamp,
                                  );
                            const section =
                              typeof source.metadata.section === "string"
                                ? source.metadata.section.replaceAll("_", " ")
                                : null;
                            return (
                              <article
                                className="knowledge-source"
                                key={`${source.chunk_id}-${index}`}
                              >
                                <div className="knowledge-source-heading">
                                  <div>
                                    <span className="knowledge-source-type">
                                      {sourceTypeLabel(source)}
                                    </span>
                                    {(note?.title || video?.title || section) && (
                                      <strong>
                                        {note?.title ||
                                          (video?.title !== "Selected video"
                                            ? video?.title
                                            : null) ||
                                          section ||
                                          "Video"}
                                      </strong>
                                    )}
                                  </div>
                                  {timestampUrl && timestamp !== null && (
                                    <a
                                      className="knowledge-timestamp-link"
                                      href={timestampUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      <Clock3 size={13} aria-hidden="true" />
                                      Open at {formatTimestamp(timestamp)}
                                      <ExternalLink
                                        size={12}
                                        aria-hidden="true"
                                      />
                                    </a>
                                  )}
                                </div>
                                <p className="knowledge-source-excerpt">
                                  {source.content}
                                </p>
                              </article>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </article>
              ))}
              {pendingQuestion && (
                <>
                  <article className="knowledge-message knowledge-chat-message is-user is-optimistic">
                    <div className="knowledge-message-heading">
                      <strong>You</strong>
                      <span>Sending</span>
                    </div>
                    <p className="knowledge-answer-text">{pendingQuestion}</p>
                  </article>
                  <article className="knowledge-message knowledge-chat-message is-assistant is-thinking">
                    <div className="knowledge-message-heading">
                      <strong>AI</strong>
                      <span>Thinking</span>
                    </div>
                    <div className="knowledge-thinking-indicator" role="status">
                      <span />
                      <span />
                      <span />
                      <span className="visually-hidden">
                        Searching sources and preparing an answer
                      </span>
                    </div>
                  </article>
                </>
              )}
              {failedQuestion && (
                <article className="knowledge-message knowledge-chat-message is-user is-failed">
                  <div className="knowledge-message-heading">
                    <strong>You</strong>
                    <span>Answer failed</span>
                  </div>
                  <p className="knowledge-answer-text">{failedQuestion}</p>
                  <p className="knowledge-failed-question-status">
                    Your question is still in the composer so you can retry.
                  </p>
                </article>
              )}
              {!activeConversation && !isConversationLoading && (
                <div className="knowledge-answer-prompt">
                  <span className="knowledge-prompt-icon">
                    <BookOpen size={20} aria-hidden="true" />
                  </span>
                  <h3>Ask about this knowledge</h3>
                  <p>
                    Ask a question about your notes or the selected video.
                    Nothing is saved until you send your first question.
                  </p>
                </div>
              )}
              {activeConversation?.messages.length === 0 &&
                !isAsking &&
                !pendingQuestion &&
                !failedQuestion && (
                <div className="knowledge-answer-prompt">
                  <span className="knowledge-prompt-icon">
                    <BookOpen size={20} aria-hidden="true" />
                  </span>
                  <h3>Ask about this knowledge</h3>
                  <p>Ask a question to begin this conversation.</p>
                </div>
              )}
            </div>

            {!isConversationLoading && (
              <form
                className="knowledge-form knowledge-question-form"
                onSubmit={(event) => void handleAsk(event)}
              >
                <label
                  className="knowledge-field"
                  htmlFor="knowledge-question"
                >
                  <span>Your question</span>
                  <textarea
                    id="knowledge-question"
                    value={question}
                    rows={3}
                    placeholder="Ask a question about your notes or video knowledge..."
                    disabled={isAsking}
                    onChange={(event) => {
                      setQuestion(event.target.value);
                      setError(null);
                    }}
                  />
                </label>
                <div className="knowledge-form-footer">
                  <span>
                    {currentConversationScope === "PERSONAL_KB"
                      ? "Searching your personal knowledge"
                      : currentConversationScope === "CURRENT_VIDEO"
                        ? "Searching knowledge for the selected video"
                        : "Searching the video and your personal knowledge"}
                  </span>
                  <button
                    className="knowledge-ask-button"
                    type="submit"
                    disabled={!canAsk}
                  >
                    {isAsking ? (
                      <>
                        <RefreshCw
                          className="is-spinning"
                          size={16}
                          aria-hidden="true"
                        />
                        Generating...
                      </>
                    ) : error ? (
                      <>
                        <RefreshCw size={16} aria-hidden="true" />
                        Try again
                      </>
                    ) : (
                      <>
                        <Sparkles size={16} aria-hidden="true" />
                        Ask AI
                      </>
                    )}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

type FolderPageState =
  | { status: "loading"; folders: DashboardFolder[] }
  | { status: "error"; folders: DashboardFolder[]; message: string }
  | { status: "ready"; folders: DashboardFolder[] };

function FolderCreateForm({
  parentId,
  onCreated,
  onCancel,
}: {
  parentId: number | null;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [folderName, setFolderName] = useState("");
  const [folderDescription, setFolderDescription] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const handleCreateFolder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError(null);
    setIsCreating(true);

    try {
      await createDashboardFolder({
        name: folderName,
        description: folderDescription,
        parent: parentId,
      });
      onCreated();
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : "Could not create this folder.",
      );
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <form
      className="folder-create-form"
      id="folder-create-form"
      onSubmit={(event) => void handleCreateFolder(event)}
    >
      <label htmlFor="folder-name">Name</label>
      <input
        id="folder-name"
        value={folderName}
        onChange={(event) => {
          setFolderName(event.target.value);
          setCreateError(null);
        }}
        maxLength={255}
        required
        autoFocus
      />
      <label htmlFor="folder-description">Description (optional)</label>
      <textarea
        id="folder-description"
        value={folderDescription}
        onChange={(event) => setFolderDescription(event.target.value)}
        rows={3}
      />
      {createError && (
        <div className="inline-state error-state" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <div>
            <strong>Folder could not be created</strong>
            <p>{createError}</p>
          </div>
        </div>
      )}
      <div className="folder-form-actions">
        <button
          className="workspace-secondary-button"
          type="button"
          onClick={onCancel}
          disabled={isCreating}
        >
          Cancel
        </button>
        <button
          className="workspace-save-button"
          type="submit"
          disabled={isCreating || !folderName.trim()}
        >
          {isCreating ? (
            <>
              <RefreshCw
                className="is-spinning"
                size={15}
                aria-hidden="true"
              />
              Creating…
            </>
          ) : (
            <>
              <Plus size={15} aria-hidden="true" />
              Create
            </>
          )}
        </button>
      </div>
    </form>
  );
}

function FoldersPage() {
  const [folderState, setFolderState] = useState<FolderPageState>({
    status: "loading",
    folders: [],
  });
  const [retryCount, setRetryCount] = useState(0);
  const [isFormOpen, setIsFormOpen] = useState(false);

  useEffect(() => {
    let active = true;
    listDashboardFolders(null)
      .then((folders) => {
        if (active) setFolderState({ status: "ready", folders });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setFolderState({
          status: "error",
          folders: [],
          message:
            error instanceof Error
              ? error.message
              : "Could not load your folders.",
        });
      });

    return () => {
      active = false;
    };
  }, [retryCount]);

  const retryLoadingFolders = () => {
    setFolderState((current) => ({
      status: "loading",
      folders: current.folders,
    }));
    setRetryCount((count) => count + 1);
  };

  const openCreateForm = () => setIsFormOpen(true);
  const closeCreateForm = () => setIsFormOpen(false);

  return (
    <section
      className="content-card folders-page-card"
      aria-labelledby="folders-list-heading"
      aria-busy={folderState.status === "loading"}
    >
      <div className="card-heading folders-page-heading">
        <div>
          <div className="card-title-row">
            <span className="section-icon">
              <Folder size={16} aria-hidden="true" />
            </span>
            <h2 id="folders-list-heading">Folders</h2>
          </div>
          <p>Keep related learning together.</p>
        </div>
        <button
          className="new-note-button"
          type="button"
          onClick={isFormOpen ? closeCreateForm : openCreateForm}
          aria-expanded={isFormOpen}
          aria-controls="folder-create-form"
        >
          <Plus size={15} aria-hidden="true" />
          {isFormOpen ? "Cancel" : "New Folder"}
        </button>
      </div>

      {isFormOpen && (
        <FolderCreateForm
          parentId={null}
          onCreated={() => {
            closeCreateForm();
            retryLoadingFolders();
          }}
          onCancel={closeCreateForm}
        />
      )}

      {folderState.status === "loading" ? (
        <div
          className="folder-loading"
          role="status"
          aria-label="Loading folders"
        >
          <span />
          <span />
          <span />
        </div>
      ) : folderState.status === "error" ? (
        <div className="inline-state error-state" role="alert">
          <AlertCircle size={19} aria-hidden="true" />
          <div>
            <strong>Folders could not be loaded</strong>
            <p>{folderState.message}</p>
            <button
              className="inline-action"
              type="button"
              onClick={retryLoadingFolders}
            >
              Try again
            </button>
          </div>
        </div>
      ) : folderState.folders.length === 0 ? (
        <div className="folder-empty-state">
          <span className="empty-state-icon">
            <Folder size={20} aria-hidden="true" />
          </span>
          <h3>No folders yet.</h3>
          <p>Create a folder to organize your learning.</p>
          <button
            className="new-note-button"
            type="button"
            onClick={openCreateForm}
          >
            <Plus size={15} aria-hidden="true" />
            New Folder
          </button>
        </div>
      ) : (
        <div className="folder-list">
          {folderState.folders.map((folder) => (
            <a
              className="folder-row"
              href={`#/folders/${folder.id}`}
              key={folder.id}
              aria-label={`Open folder: ${folder.name}`}
            >
              <span className="folder-row-icon">
                <Folder size={18} aria-hidden="true" />
              </span>
              <div className="folder-row-copy">
                <h3>{folder.name}</h3>
                {folder.description.trim() && <p>{folder.description}</p>}
              </div>
              <ArrowUpRight
                className="folder-row-arrow"
                size={16}
                aria-hidden="true"
              />
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

type FolderDetailState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; folder: DashboardFolder };

type FolderNotesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; notes: DashboardNote[] };

type FolderChildrenState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; folders: DashboardFolder[] };

function FolderDetailPage({
  folderId,
  onOpenNote,
}: {
  folderId: number;
  onOpenNote: (noteId: number) => void;
}) {
  const [folderState, setFolderState] = useState<FolderDetailState>({
    status: "loading",
  });
  const [notesState, setNotesState] = useState<FolderNotesState>({
    status: "loading",
  });
  const [childrenState, setChildrenState] = useState<FolderChildrenState>({
    status: "loading",
  });
  const [folderRetryCount, setFolderRetryCount] = useState(0);
  const [notesRetryCount, setNotesRetryCount] = useState(0);
  const [childrenRetryCount, setChildrenRetryCount] = useState(0);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isDeleteConfirmationOpen, setIsDeleteConfirmationOpen] =
    useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getDashboardFolder(folderId)
      .then((folder) => {
        if (active) setFolderState({ status: "ready", folder });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setFolderState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Folder not found or unavailable.",
        });
      });

    return () => {
      active = false;
    };
  }, [folderId, folderRetryCount]);

  useEffect(() => {
    if (folderState.status !== "ready") return;
    let active = true;
    getDashboardFolderNotes(folderId)
      .then((notes) => {
        if (active) setNotesState({ status: "ready", notes });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setNotesState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load notes in this folder.",
        });
      });

    return () => {
      active = false;
    };
  }, [folderId, folderState.status, folderRetryCount, notesRetryCount]);

  useEffect(() => {
    if (folderState.status !== "ready") return;
    let active = true;
    listDashboardFolders(folderId)
      .then((folders) => {
        if (active) setChildrenState({ status: "ready", folders });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setChildrenState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load subfolders.",
        });
      });

    return () => {
      active = false;
    };
  }, [folderId, folderState.status, folderRetryCount, childrenRetryCount]);

  const retryFolder = () => {
    setFolderState({ status: "loading" });
    setNotesState({ status: "loading" });
    setChildrenState({ status: "loading" });
    setFolderRetryCount((count) => count + 1);
  };

  const retryNotes = () => {
    setNotesState({ status: "loading" });
    setNotesRetryCount((count) => count + 1);
  };

  const retryChildren = () => {
    setChildrenState({ status: "loading" });
    setChildrenRetryCount((count) => count + 1);
  };

  const openRename = () => {
    if (folderState.status !== "ready") return;
    setRenameName(folderState.folder.name);
    setRenameError(null);
    setIsRenameOpen(true);
  };

  const handleRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (folderState.status !== "ready" || isRenaming) return;
    setIsRenaming(true);
    setRenameError(null);
    try {
      const renamedFolder = await renameDashboardFolder(
        folderId,
        renameName.trim(),
      );
      setFolderState({ status: "ready", folder: renamedFolder });
      setIsRenameOpen(false);
    } catch (error) {
      setRenameError(
        error instanceof Error
          ? error.message
          : "Could not rename this folder.",
      );
    } finally {
      setIsRenaming(false);
    }
  };

  const handleDelete = async () => {
    if (isDeleting) return;
    if (folderState.status !== "ready") return;
    const parentId = folderState.folder.parent;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await deleteDashboardFolder(folderId);
      window.location.hash = parentId
        ? `#/folders/${parentId}`
        : "#/folders";
    } catch (error) {
      setDeleteError(
        error instanceof Error
          ? error.message
          : "Could not delete this folder.",
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const folder =
    folderState.status === "ready" ? folderState.folder : null;
  const breadcrumbs = folder?.breadcrumbs ?? [];
  const parentBreadcrumb =
    breadcrumbs.length > 1
      ? breadcrumbs[breadcrumbs.length - 2]
      : null;
  const backHref = folder?.parent
    ? `#/folders/${folder.parent}`
    : "#/folders";
  const backLabel = parentBreadcrumb
    ? `Back to ${parentBreadcrumb.name}`
    : "Back to Folders";
  const isFolderAndNotesEmpty =
    childrenState.status === "ready" &&
    childrenState.folders.length === 0 &&
    notesState.status === "ready" &&
    notesState.notes.length === 0;

  return (
    <div className="folder-detail-page">
      <a className="workspace-back-button folder-back-link" href={backHref}>
        <ArrowLeft size={17} aria-hidden="true" />
        <span>{backLabel}</span>
      </a>

      {folderState.status === "loading" ? (
        <section
          className="content-card folder-detail-loading"
          role="status"
          aria-label="Loading folder"
        >
          <span />
          <span />
        </section>
      ) : folderState.status === "error" ? (
        <section className="content-card" role="alert">
          <div className="inline-state error-state">
            <AlertCircle size={19} aria-hidden="true" />
            <div>
              <strong>Folder not found or unavailable</strong>
              <p>{folderState.message}</p>
              <button
                className="inline-action"
                type="button"
                onClick={retryFolder}
              >
                Try again
              </button>
            </div>
          </div>
        </section>
      ) : (
        <>
          <nav className="folder-breadcrumbs" aria-label="Folder breadcrumbs">
            <a href="#/folders">Folders</a>
            {breadcrumbs.map((breadcrumb, index) => {
              const isCurrent = index === breadcrumbs.length - 1;
              return (
                <span className="folder-breadcrumb-item" key={breadcrumb.id}>
                  <span aria-hidden="true">/</span>
                  {isCurrent ? (
                    <span aria-current="page">{breadcrumb.name}</span>
                  ) : (
                    <a href={`#/folders/${breadcrumb.id}`}>
                      {breadcrumb.name}
                    </a>
                  )}
                </span>
              );
            })}
          </nav>
          <div className="folder-detail-header">
            <header className="folder-detail-heading">
              <h2>{folderState.folder.name}</h2>
              {folderState.folder.description.trim() && (
                <p>{folderState.folder.description}</p>
              )}
            </header>
            {!isRenameOpen &&
              !isDeleteConfirmationOpen &&
              !isCreateOpen && (
                <div className="folder-management-actions">
                  <button
                    className="new-note-button"
                    type="button"
                    onClick={() => setIsCreateOpen(true)}
                  >
                    <Plus size={15} aria-hidden="true" />
                    New Folder
                  </button>
                  <button
                    className="workspace-secondary-button"
                    type="button"
                    onClick={openRename}
                  >
                    Rename
                  </button>
                  <button
                    className="folder-delete-button"
                    type="button"
                    onClick={() => {
                      setDeleteError(null);
                      setIsDeleteConfirmationOpen(true);
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
          </div>

          {isCreateOpen && (
            <FolderCreateForm
              parentId={folderId}
              onCreated={() => {
                setIsCreateOpen(false);
                retryChildren();
              }}
              onCancel={() => setIsCreateOpen(false)}
            />
          )}

          {isRenameOpen && (
            <form
              className="folder-create-form folder-rename-form"
              onSubmit={(event) => void handleRename(event)}
            >
              <label htmlFor="folder-rename-name">Folder name</label>
              <input
                id="folder-rename-name"
                value={renameName}
                onChange={(event) => {
                  setRenameName(event.target.value);
                  setRenameError(null);
                }}
                maxLength={255}
                required
                autoFocus
              />
              {renameError && (
                <div className="inline-state error-state" role="alert">
                  <AlertCircle size={18} aria-hidden="true" />
                  <div>
                    <strong>Folder could not be renamed</strong>
                    <p>{renameError}</p>
                  </div>
                </div>
              )}
              <div className="folder-form-actions">
                <button
                  className="workspace-secondary-button"
                  type="button"
                  onClick={() => {
                    setIsRenameOpen(false);
                    setRenameError(null);
                  }}
                  disabled={isRenaming}
                >
                  Cancel
                </button>
                <button
                  className="workspace-save-button"
                  type="submit"
                  disabled={isRenaming || !renameName.trim()}
                >
                  {isRenaming ? "Saving…" : "Save"}
                </button>
              </div>
            </form>
          )}

          {isDeleteConfirmationOpen && (
            <section
              className="folder-delete-confirmation"
              aria-labelledby="folder-delete-title"
            >
              <h3 id="folder-delete-title">Delete this folder?</h3>
              <p>
                The folder will be removed, but the notes inside it will not be
                deleted. They will become unassigned.
              </p>
              {deleteError && (
                <div className="inline-state error-state" role="alert">
                  <AlertCircle size={18} aria-hidden="true" />
                  <div>
                    <strong>Folder could not be deleted</strong>
                    <p>{deleteError}</p>
                  </div>
                </div>
              )}
              <div className="folder-form-actions">
                <button
                  className="workspace-secondary-button"
                  type="button"
                  onClick={() => {
                    setIsDeleteConfirmationOpen(false);
                    setDeleteError(null);
                  }}
                  disabled={isDeleting}
                >
                  Cancel
                </button>
                <button
                  className="folder-delete-button"
                  type="button"
                  onClick={() => void handleDelete()}
                  disabled={isDeleting}
                >
                  {isDeleting ? "Deleting…" : "Delete Folder"}
                </button>
              </div>
            </section>
          )}

          <section className="content-card folder-subfolders-card">
            <div className="card-heading">
              <div className="card-title-row">
                <span className="section-icon">
                  <Folder size={16} aria-hidden="true" />
                </span>
                <h2>Subfolders</h2>
              </div>
            </div>
            {childrenState.status === "loading" ? (
              <div
                className="folder-loading"
                role="status"
                aria-label="Loading subfolders"
              >
                <span />
                <span />
              </div>
            ) : childrenState.status === "error" ? (
              <div className="inline-state error-state" role="alert">
                <AlertCircle size={19} aria-hidden="true" />
                <div>
                  <strong>Subfolders could not be loaded</strong>
                  <p>{childrenState.message}</p>
                  <button
                    className="inline-action"
                    type="button"
                    onClick={retryChildren}
                  >
                    Try again
                  </button>
                </div>
              </div>
            ) : childrenState.folders.length === 0 ? (
              <div className="folder-notes-empty" role="status">
                <span className="empty-state-icon">
                  <Folder size={20} aria-hidden="true" />
                </span>
                <h3>
                  {isFolderAndNotesEmpty
                    ? "No subfolders or notes yet."
                    : "No subfolders yet."}
                </h3>
                {isFolderAndNotesEmpty && (
                  <p>Create a subfolder to organize this folder.</p>
                )}
              </div>
            ) : (
              <div className="folder-list">
                {childrenState.folders.map((child) => (
                  <a
                    className="folder-row"
                    href={`#/folders/${child.id}`}
                    key={child.id}
                    aria-label={`Open folder: ${child.name}`}
                  >
                    <span className="folder-row-icon">
                      <Folder size={18} aria-hidden="true" />
                    </span>
                    <div className="folder-row-copy">
                      <h3>{child.name}</h3>
                      {child.description.trim() && <p>{child.description}</p>}
                    </div>
                    <ArrowUpRight
                      className="folder-row-arrow"
                      size={16}
                      aria-hidden="true"
                    />
                  </a>
                ))}
              </div>
            )}
          </section>

          <section className="content-card folder-notes-card">
            <div className="card-heading">
              <div className="card-title-row">
                <span className="section-icon">
                  <FileText size={16} aria-hidden="true" />
                </span>
                <h2>Notes</h2>
              </div>
            </div>
            {notesState.status === "loading" ? (
              <div
                className="notes-loading"
                role="status"
                aria-label="Loading folder notes"
              >
                <span />
                <span />
                <span />
              </div>
            ) : notesState.status === "error" ? (
              <div className="inline-state error-state" role="alert">
                <AlertCircle size={19} aria-hidden="true" />
                <div>
                  <strong>Notes could not be loaded</strong>
                  <p>{notesState.message}</p>
                  <button
                    className="inline-action"
                    type="button"
                    onClick={retryNotes}
                  >
                    Try again
                  </button>
                </div>
              </div>
            ) : notesState.notes.length === 0 ? (
              <div className="folder-notes-empty" role="status">
                <span className="empty-state-icon">
                  <FileText size={20} aria-hidden="true" />
                </span>
                <h3>No notes in this folder yet.</h3>
              </div>
            ) : (
              <NoteRows
                notes={notesState.notes}
                onSelectNote={onOpenNote}
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}

type FolderSearchState =
  | { query: string; status: "loading" }
  | { query: string; status: "loaded"; results: DashboardFolderSearchResult[] }
  | { query: string; status: "error"; message: string };

function FolderSearchPage() {
  const [query, setQuery] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const [searchState, setSearchState] = useState<FolderSearchState>({
    query: "",
    status: "loading",
  });
  const normalizedQuery = query.trim();

  useEffect(() => {
    if (!normalizedQuery) return;

    let active = true;
    const timeoutId = window.setTimeout(() => {
      setSearchState({ query: normalizedQuery, status: "loading" });
      searchDashboardFolders(normalizedQuery)
        .then((results) => {
          if (active) {
            setSearchState({
              query: normalizedQuery,
              status: "loaded",
              results,
            });
          }
        })
        .catch((error: unknown) => {
          if (active) {
            setSearchState({
              query: normalizedQuery,
              status: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "Could not search folders.",
            });
          }
        });
    }, 300);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [normalizedQuery, retryCount]);

  const currentSearchState =
    normalizedQuery === ""
      ? null
      : searchState.query === normalizedQuery
        ? searchState
        : { query: normalizedQuery, status: "loading" as const };

  return (
    <section className="content-card folder-search-panel">
      <label className="folder-search-input">
        <span className="visually-hidden">Search folders</span>
        <Search size={17} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search folders..."
          aria-label="Search folders"
        />
      </label>

      {currentSearchState === null ? (
        <div className="folder-search-message" role="status">
          <Folder size={20} aria-hidden="true" />
          <div>
            <strong>Search your folders</strong>
            <p>Enter a folder name to search.</p>
          </div>
        </div>
      ) : currentSearchState.status === "loading" ? (
        <div className="folder-search-message" role="status">
          <span
            className="folder-search-loading-indicator"
            aria-hidden="true"
          />
          <p>Searching folders...</p>
        </div>
      ) : currentSearchState.status === "error" ? (
        <div className="folder-search-message is-error" role="alert">
          <AlertCircle size={19} aria-hidden="true" />
          <div>
            <strong>Folders could not be searched</strong>
            <p>{currentSearchState.message}</p>
            <button
              className="inline-action"
              type="button"
              onClick={() => setRetryCount((count) => count + 1)}
            >
              Try again
            </button>
          </div>
        </div>
      ) : currentSearchState.results.length === 0 ? (
        <div className="folder-search-message" role="status">
          <Search size={19} aria-hidden="true" />
          <div>
            <strong>No matching folders</strong>
            <p>Try another folder name.</p>
          </div>
        </div>
      ) : (
        <div className="folder-search-results">
          <div className="folder-search-results-heading">
            <h2>Folders</h2>
            <span>{currentSearchState.results.length}</span>
          </div>
          <ul>
            {currentSearchState.results.map((result) => (
              <li key={result.id}>
                <a
                  className="folder-search-result"
                  href={`#/folders/${result.id}`}
                  aria-label={`Open folder: ${result.path
                    .map((folder) => folder.name)
                    .join(" / ")}`}
                >
                  <Folder size={17} aria-hidden="true" />
                  <span className="folder-search-path">
                    {result.path.map((folder, index) => (
                      <span
                        className="folder-search-path-segment"
                        key={folder.id}
                      >
                        {index > 0 && (
                          <span
                            className="folder-search-path-separator"
                            aria-hidden="true"
                          >
                            /
                          </span>
                        )}
                        {folder.id === result.id ? (
                          <strong>{folder.name}</strong>
                        ) : (
                          <span>{folder.name}</span>
                        )}
                      </span>
                    ))}
                  </span>
                  <ArrowUpRight size={15} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
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
