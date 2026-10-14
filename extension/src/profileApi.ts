export interface DashboardProfile {
  email: string;
  username: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTrustedProfileRequestSender(
  sender: unknown,
  extensionId: string,
  dashboardUrl: string,
  method: unknown,
): boolean {
  if (
    !isRecord(sender) ||
    sender.id !== extensionId ||
    typeof sender.url !== "string"
  ) {
    return false;
  }

  try {
    const senderUrl = new URL(sender.url);
    const trustedDashboardUrl = new URL(dashboardUrl);
    const isDashboard =
      senderUrl.origin === trustedDashboardUrl.origin &&
      senderUrl.pathname === trustedDashboardUrl.pathname &&
      senderUrl.search === "";

    if (isDashboard) return method === "GET" || method === "PATCH";
    if (method !== "GET" || !isRecord(sender.tab)) return false;

    return (
      senderUrl.protocol === "https:" &&
      (senderUrl.hostname === "www.youtube.com" ||
        senderUrl.hostname === "youtube.com") &&
      senderUrl.pathname === "/watch"
    );
  } catch {
    return false;
  }
}

function isProfile(value: unknown): value is DashboardProfile {
  return (
    isRecord(value) &&
    typeof value.email === "string" &&
    typeof value.username === "string"
  );
}

function errorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.detail === "string") return value.detail;
  const username = value.username;
  if (Array.isArray(username) && typeof username[0] === "string") {
    return username[0];
  }
  return null;
}

async function requestProfile(
  method: "GET" | "PATCH",
  data?: { username: string },
): Promise<DashboardProfile> {
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    throw new Error("Open this page from the YouTube Knowledge extension.");
  }

  const response = await new Promise<unknown>((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "PROFILE_API_REQUEST",
        method,
        ...(data ? { data } : {}),
      },
      (result: unknown) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error("Could not reach the profile service."));
          return;
        }
        resolve(result);
      },
    );
  });

  if (
    !isRecord(response) ||
    typeof response.success !== "boolean" ||
    !("data" in response)
  ) {
    throw new Error("The profile service returned an invalid response.");
  }
  if (!response.success) {
    throw new Error(
      errorMessage(response.data) ?? "Could not update your profile.",
    );
  }
  if (!isProfile(response.data)) {
    throw new Error("The profile service returned invalid profile data.");
  }
  return response.data;
}

export function getDashboardProfile(): Promise<DashboardProfile> {
  return requestProfile("GET");
}

export function updateDashboardUsername(
  username: string,
): Promise<DashboardProfile> {
  return requestProfile("PATCH", { username });
}
