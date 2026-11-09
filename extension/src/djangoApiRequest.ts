import type { AuthResult } from "./backgroundAuth";

export type AccessTokenProvider = () => Promise<AuthResult<string | null>>;

const LOCAL_DJANGO_API_ORIGIN = "http://localhost:8000";

function getDjangoApiOrigin(): string {
  const configuredOrigin =
    import.meta.env.VITE_DJANGO_API_ORIGIN?.trim() ||
    (import.meta.env.DEV ? LOCAL_DJANGO_API_ORIGIN : "");
  if (!configuredOrigin) {
    throw new Error("VITE_DJANGO_API_ORIGIN must be configured.");
  }

  let url: URL;
  try {
    url = new URL(configuredOrigin);
  } catch {
    throw new Error("VITE_DJANGO_API_ORIGIN must be a valid origin.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("VITE_DJANGO_API_ORIGIN must be a valid origin.");
  }
  return url.origin;
}

export function djangoApiUrl(path: string): string {
  if (!path.startsWith("/api/")) {
    throw new Error("Django API requests must use an /api/ path.");
  }
  return new URL(path, getDjangoApiOrigin()).toString();
}

function isJwtAccessTokenCandidate(token: string): boolean {
  const segments = token.split(".");
  return (
    segments.length === 3 &&
    segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment))
  );
}

export function fetchDjangoApi(
  getAccessToken: AccessTokenProvider,
  fetcher: typeof fetch = fetch,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : input.toString());
    } catch {
      throw new Error("Django API requests must use the configured API origin.");
    }
    if (
      url.origin !== getDjangoApiOrigin() ||
      !url.pathname.startsWith("/api/")
    ) {
      throw new Error("Django API requests must use the configured API origin.");
    }

    const result = await getAccessToken();
    const token =
      result.success && typeof result.data === "string"
        ? result.data.trim()
        : "";
    if (!token || !isJwtAccessTokenCandidate(token)) {
      throw new Error(
        "A valid Supabase session is required to access Django APIs.",
      );
    }

    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(init.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    headers.delete("X-Dev-User");
    headers.set("Authorization", `Bearer ${token}`);

    return fetcher(input, { ...init, headers });
  };
}
