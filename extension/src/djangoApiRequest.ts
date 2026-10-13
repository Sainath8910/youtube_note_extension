import type { AuthResult } from "./backgroundAuth";

export type AccessTokenProvider = () => Promise<AuthResult<string | null>>;

const DJANGO_API_ORIGIN = "http://localhost:8000";

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
      url.origin !== DJANGO_API_ORIGIN ||
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
