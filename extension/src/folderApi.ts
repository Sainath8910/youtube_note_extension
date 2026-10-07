import { normalizeNote, type DashboardNote } from "./dashboardApi";

export interface DashboardFolder {
  id: number;
  name: string;
  description: string;
  parent: number | null;
  created_at: string;
  updated_at: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFolder(value: unknown): value is DashboardFolder {
  return (
    isObject(value) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    (value.parent === null ||
      (typeof value.parent === "number" &&
        Number.isSafeInteger(value.parent) &&
        value.parent > 0)) &&
    typeof value.created_at === "string" &&
    Number.isFinite(Date.parse(value.created_at)) &&
    typeof value.updated_at === "string" &&
    Number.isFinite(Date.parse(value.updated_at))
  );
}

function apiErrorMessage(value: unknown): string | null {
  if (!isObject(value)) return null;
  if (typeof value.detail === "string") return value.detail;

  for (const field of Object.values(value)) {
    if (typeof field === "string") return field;
    if (Array.isArray(field) && typeof field[0] === "string") {
      return field[0];
    }
  }
  return null;
}

function sendFolderCommand(message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) {
      reject(
        new Error(
          "Open this workspace from the YouTube Knowledge browser extension to manage folders.",
        ),
      );
      return;
    }

    chrome.runtime.sendMessage(message, (response: unknown) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || "Extension request failed."));
        return;
      }
      if (!isObject(response) || typeof response.success !== "boolean") {
        reject(new Error("The folders service returned an invalid response."));
        return;
      }
      if (!response.success) {
        reject(
          new Error(
            apiErrorMessage(response.data) ??
              (typeof response.error === "string"
                ? response.error
                : "Could not complete the folder request."),
          ),
        );
        return;
      }
      resolve(response.data);
    });
  });
}

export async function listDashboardFolders(): Promise<DashboardFolder[]> {
  const data = await sendFolderCommand({ type: "LIST_FOLDERS" });
  if (!Array.isArray(data) || !data.every(isFolder)) {
    throw new Error("The folders API returned an invalid folder list.");
  }
  return data;
}

export async function createDashboardFolder(data: {
  name: string;
  description: string;
}): Promise<DashboardFolder> {
  const folder = await sendFolderCommand({
    type: "CREATE_FOLDER",
    data: {
      name: data.name,
      description: data.description,
      parent: null,
    },
  });
  if (!isFolder(folder)) {
    throw new Error("The folders API returned invalid folder data.");
  }
  return folder;
}

export async function getDashboardFolder(
  folderId: number,
): Promise<DashboardFolder> {
  const folder = await sendFolderCommand({
    type: "GET_FOLDER",
    folderId,
  });
  if (!isFolder(folder)) {
    throw new Error("The folders API returned invalid folder data.");
  }
  return folder;
}

export async function getDashboardFolderNotes(
  folderId: number,
): Promise<DashboardNote[]> {
  const data = await sendFolderCommand({
    type: "GET_FOLDER_NOTES",
    folderId,
  });
  if (!Array.isArray(data)) {
    throw new Error("The folders API returned an invalid notes list.");
  }
  return data.map((note, index) => normalizeNote(note, index));
}
