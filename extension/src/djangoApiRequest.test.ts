import { describe, expect, it, vi } from "vitest";
import { fetchDjangoApi } from "./djangoApiRequest";

describe("authenticated Django API requests", () => {
  it("sends the background token to the current-user endpoint without returning it", async () => {
    const accessToken = "header.payload.signature";
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        `Bearer ${accessToken}`,
      );
      expect(new Headers(init?.headers).get("Content-Type")).toBe(
        "application/json",
      );
      expect(new Headers(init?.headers).has("X-Dev-User")).toBe(false);
      return new Response(
        JSON.stringify({
          id: 17,
          email: "learner@example.com",
          display_name: "YouTube Learner",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const request = fetchDjangoApi(
      () => Promise.resolve({ success: true, data: accessToken }),
      fetcher,
    );

    const response = await request("http://localhost:8000/api/users/me/", {
      method: "GET",
      headers: {
        Authorization: "Bearer stale-token",
        "Content-Type": "application/json",
        "X-Dev-User": "devuser",
      },
    });
    const profile = await response.json();

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:8000/api/users/me/",
      expect.objectContaining({ method: "GET" }),
    );
    expect(profile).toEqual({
      id: 17,
      email: "learner@example.com",
      display_name: "YouTube Learner",
    });
    expect(JSON.stringify(profile)).not.toContain(accessToken);
  });

  it("never attaches the token to a non-Django destination", async () => {
    const getAccessToken = vi.fn(() =>
      Promise.resolve({ success: true as const, data: "header.payload.signature" }),
    );
    const fetcher = vi.fn();
    const request = fetchDjangoApi(getAccessToken, fetcher);

    await expect(request("https://attacker.example/api/collect")).rejects.toThrow(
      "Django API requests must use the configured API origin.",
    );
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not send a request when there is no valid access token", async () => {
    const fetcher = vi.fn();
    const request = fetchDjangoApi(
      () => Promise.resolve({ success: true, data: null }),
      fetcher,
    );

    await expect(
      request("http://localhost:8000/api/notes/"),
    ).rejects.toThrow("A valid Supabase session is required to access Django APIs.");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only access tokens", async () => {
    const fetcher = vi.fn();
    const request = fetchDjangoApi(
      () => Promise.resolve({ success: true, data: "  \t" }),
      fetcher,
    );

    await expect(
      request("http://localhost:8000/api/notes/"),
    ).rejects.toThrow("A valid Supabase session is required to access Django APIs.");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed access tokens", async () => {
    const fetcher = vi.fn();
    const request = fetchDjangoApi(
      () => Promise.resolve({ success: true, data: "not-a-jwt" }),
      fetcher,
    );

    await expect(
      request("http://localhost:8000/api/notes/"),
    ).rejects.toThrow("A valid Supabase session is required to access Django APIs.");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not send a request when token retrieval or refresh fails", async () => {
    const fetcher = vi.fn();
    const request = fetchDjangoApi(
      () =>
        Promise.resolve({
          success: false,
          error: {
            code: "AUTH_REQUEST_FAILED",
            diagnosticCode: "AUTH_UNKNOWN",
            message: "Session refresh failed.",
          },
        }),
      fetcher,
    );

    await expect(
      request("http://localhost:8000/api/notes/"),
    ).rejects.toThrow("A valid Supabase session is required to access Django APIs.");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
