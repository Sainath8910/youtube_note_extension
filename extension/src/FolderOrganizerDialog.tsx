import { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpRight,
  Folder,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import {
  createDashboardFolder,
  getDashboardFolder,
  listDashboardFolders,
  type DashboardFolder,
} from "./folderApi";

type FolderListingState =
  | { status: "loading"; folderId: number | null }
  | { status: "error"; folderId: number | null; message: string }
  | { status: "ready"; folderId: number | null; folders: DashboardFolder[] };

interface FolderOrganizerDialogProps {
  initialFolderId: number | null;
  onCancel: () => void;
  onSaveHere: (
    folderId: number | null,
    folder: DashboardFolder | null,
  ) => Promise<void>;
}

export function FolderOrganizerDialog({
  initialFolderId,
  onCancel,
  onSaveHere,
}: FolderOrganizerDialogProps) {
  const [currentFolderId, setCurrentFolderId] = useState(initialFolderId);
  const [currentFolder, setCurrentFolder] = useState<DashboardFolder | null>(
    null,
  );
  const [listingState, setListingState] = useState<FolderListingState>({
    status: "loading",
    folderId: initialFolderId,
  });
  const [retryCount, setRetryCount] = useState(0);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let active = true;

    const loadFolders = async () => {
      try {
        if (currentFolderId === null) {
          const folders = await listDashboardFolders(null);
          if (active) {
            setCurrentFolder(null);
            setListingState({
              status: "ready",
              folderId: currentFolderId,
              folders,
            });
          }
          return;
        }

        const folder = await getDashboardFolder(currentFolderId);
        if (active) setCurrentFolder(folder);
        const folders = await listDashboardFolders(currentFolderId);
        if (active) {
          setListingState({
            status: "ready",
            folderId: currentFolderId,
            folders,
          });
        }
      } catch (error) {
        if (!active) return;
        setListingState({
          status: "error",
          folderId: currentFolderId,
          message:
            error instanceof Error
              ? error.message
              : "Could not load this folder.",
        });
      }
    };

    void loadFolders();
    return () => {
      active = false;
    };
  }, [currentFolderId, retryCount]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSaving && !isCreating) onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isCreating, isSaving, onCancel]);

  const isCurrentFolderLoaded = currentFolder?.id === currentFolderId;
  const activeFolder = isCurrentFolderLoaded ? currentFolder : null;
  const isCurrentListing =
    listingState.folderId === currentFolderId &&
    listingState.status !== "loading";
  const breadcrumbs = activeFolder?.breadcrumbs ?? [];
  const currentLocationName =
    currentFolderId === null
      ? "Root (No Folder)"
      : activeFolder !== null
        ? breadcrumbs.map((item) => item.name).join(" / ")
        : !isCurrentListing
          ? "Loading folder…"
          : "Folder unavailable";

  const closeIfIdle = () => {
    if (!isSaving && !isCreating) onCancel();
  };

  const handleCreateFolder = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (isCreating) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      await createDashboardFolder({
        name: folderName.trim(),
        description: "",
        parent: currentFolderId,
      });
      setFolderName("");
      setIsCreateOpen(false);
      setListingState({ status: "loading", folderId: currentFolderId });
      setRetryCount((count) => count + 1);
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : "Could not create this folder.",
      );
    } finally {
      setIsCreating(false);
    }
  };

  const handleSaveHere = async () => {
    if (isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await onSaveHere(currentFolderId, currentFolder);
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "Could not save this folder selection.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="folder-organizer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeIfIdle();
      }}
    >
      <section
        className="folder-organizer-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-organizer-title"
        aria-busy={isSaving || isCreating}
      >
        <header className="folder-organizer-header">
          <div>
            <p className="eyebrow">NOTE ORGANIZATION</p>
            <h2 id="folder-organizer-title">Save to Folder</h2>
          </div>
          <button
            autoFocus
            className="icon-button"
            type="button"
            aria-label="Close folder organizer"
            onClick={closeIfIdle}
            disabled={isSaving || isCreating}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <div className="folder-organizer-location">
          {currentFolderId !== null && (
            <button
              className="folder-organizer-back"
              type="button"
              onClick={() => {
                const parentId = activeFolder?.parent ?? null;
                setCurrentFolderId(parentId);
                setSaveError(null);
              }}
              disabled={isSaving || isCreating || activeFolder === null}
            >
              <ArrowLeft size={15} aria-hidden="true" />
              Back
            </button>
          )}
          <nav className="folder-organizer-breadcrumbs" aria-label="Save location">
            <button
              type="button"
              onClick={() => {
                setCurrentFolderId(null);
                setSaveError(null);
              }}
              aria-current={currentFolderId === null ? "location" : undefined}
              disabled={isSaving || isCreating}
            >
              Root
            </button>
            {breadcrumbs.map((item, index) => {
              const isCurrent = index === breadcrumbs.length - 1;
              return (
                <span className="folder-organizer-crumb" key={item.id}>
                  <span aria-hidden="true">/</span>
                  {isCurrent ? (
                    <span aria-current="location">{item.name}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setCurrentFolderId(item.id);
                        setSaveError(null);
                      }}
                      disabled={isSaving || isCreating}
                    >
                      {item.name}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
        </div>

        <p className="folder-organizer-destination">
          Destination: <strong>{currentLocationName}</strong>
        </p>

        {!isCreateOpen && (
          <button
            className="folder-organizer-new-folder"
            type="button"
            onClick={() => {
              setCreateError(null);
              setIsCreateOpen(true);
            }}
            disabled={isSaving || isCreating}
          >
            <Plus size={15} aria-hidden="true" />
            New Folder
          </button>
        )}

        {isCreateOpen && (
          <form
            className="folder-create-form folder-organizer-create-form"
            onSubmit={(event) => void handleCreateFolder(event)}
          >
            <label htmlFor="organizer-folder-name">Folder name</label>
            <input
              id="organizer-folder-name"
              value={folderName}
              onChange={(event) => {
                setFolderName(event.target.value);
                setCreateError(null);
              }}
              maxLength={255}
              required
              autoFocus
            />
            {createError && (
              <div className="inline-state error-state" role="alert">
                <AlertCircle size={17} aria-hidden="true" />
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
                onClick={() => {
                  setIsCreateOpen(false);
                  setFolderName("");
                  setCreateError(null);
                }}
                disabled={isCreating}
              >
                Cancel
              </button>
              <button
                className="workspace-save-button"
                type="submit"
                disabled={isCreating || !folderName.trim()}
              >
                {isCreating ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        )}

        <div className="folder-organizer-list" aria-live="polite">
          {!isCurrentListing ? (
            <div
              className="folder-loading"
              role="status"
              aria-label="Loading folders"
            >
              <span />
              <span />
            </div>
          ) : listingState.status === "error" ? (
            <div className="inline-state error-state" role="alert">
              <AlertCircle size={18} aria-hidden="true" />
              <div>
                <strong>Folders could not be loaded</strong>
                <p>{listingState.message}</p>
                <button
                  className="inline-action"
                  type="button"
                  onClick={() => {
                    setListingState({
                      status: "loading",
                      folderId: currentFolderId,
                    });
                    setRetryCount((count) => count + 1);
                  }}
                >
                  Try again
                </button>
              </div>
            </div>
          ) : listingState.status === "ready" &&
            listingState.folders.length === 0 ? (
            <div className="folder-organizer-empty" role="status">
              <Folder size={19} aria-hidden="true" />
              <span>
                {currentFolderId === null
                  ? "No folders yet. Save Here will keep this note unfiled."
                  : "No subfolders yet. You can save in this folder or create one."}
              </span>
            </div>
          ) : (
            listingState.status === "ready" &&
            listingState.folders.map((folder) => (
              <button
                className="folder-organizer-row"
                type="button"
                key={folder.id}
                onClick={() => {
                  setCurrentFolderId(folder.id);
                  setSaveError(null);
                }}
                disabled={isSaving || isCreating}
              >
                <span className="folder-row-icon">
                  <Folder size={18} aria-hidden="true" />
                </span>
                <span className="folder-organizer-row-name">{folder.name}</span>
                <ArrowUpRight size={15} aria-hidden="true" />
              </button>
            ))
          )}
        </div>

        {saveError && (
          <div className="inline-state error-state folder-organizer-save-error" role="alert">
            <AlertCircle size={18} aria-hidden="true" />
            <div>
              <strong>Folder selection was not saved</strong>
              <p>{saveError}</p>
            </div>
          </div>
        )}

        <footer className="folder-organizer-actions">
          <button
            className="workspace-secondary-button"
            type="button"
            onClick={closeIfIdle}
            disabled={isSaving || isCreating}
          >
            Cancel
          </button>
          <button
            className="workspace-save-button"
            type="button"
            onClick={() => void handleSaveHere()}
            disabled={
              isSaving ||
              isCreating ||
              isCreateOpen ||
              !isCurrentListing ||
              listingState.status !== "ready"
            }
          >
            {isSaving ? (
              <>
                <RefreshCw
                  className="is-spinning"
                  size={14}
                  aria-hidden="true"
                />
                Saving…
              </>
            ) : (
              "Save Here"
            )}
          </button>
        </footer>
      </section>
    </div>
  );
}
