import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClient,
  type Session,
  type User,
} from "@supabase/supabase-js";
import {
  createBackgroundAuth,
  createChromeStorageAdapter,
  dispatchAuthRuntimeMessage,
  getBackgroundAuth,
  handleAuthRuntimeMessage,
  isAuthRuntimeRequest,
  isPublicConfiguration,
  isTrustedDashboardAuthSender,
  sanitizeAuthDiagnostic,
  type BackgroundAuth,
  type ChromeStorageArea,
} from "./backgroundAuth";

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@supabase/supabase-js")>();
  return { ...actual, createClient: vi.fn() };
});

describe("background password management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends recovery email to the supplied extension recovery route", async () => {
    const authClient = setupClient();
    const { storage } = createStorage();
    const auth = createBackgroundAuth(config, storage);

    const result = await auth.sendPasswordRecovery(
      "learner@example.com",
      "chrome-extension://extension-id/index.html?flow=recovery",
    );

    expect(result).toEqual({ success: true, data: null });
    expect(authClient.resetPasswordForEmail).toHaveBeenCalledWith(
      "learner@example.com",
      {
        redirectTo: "chrome-extension://extension-id/index.html?flow=recovery",
      },
    );
  });

  it("verifies the current email password before changing it", async () => {
    const authClient = setupClient();
    const emailUser = {
      ...user,
      app_metadata: { providers: ["email"] },
    } as User;
    authClient.getUser.mockResolvedValueOnce({
      data: { user: emailUser },
      error: null,
    });
    const { storage } = createStorage();
    const auth = createBackgroundAuth(config, storage);

    const result = await auth.changePassword("old-password", "new-password");

    expect(result).toEqual({ success: true, data: null });
    expect(authClient.signInWithPassword).toHaveBeenCalledWith({
      email: "learner@example.com",
      password: "old-password",
    });
    expect(authClient.updateUser).toHaveBeenCalledWith({
      password: "new-password",
    });
  });

  it("directs Google-only accounts to recovery instead of claiming verification", async () => {
    const authClient = setupClient();
    const { storage } = createStorage();
    const auth = createBackgroundAuth(config, storage);

    const result = await auth.changePassword("unused-password", "new-password");

    expect(result).toMatchObject({
      success: false,
      error: {
        message: "This account has no password. Use Forgot password? to establish one.",
      },
    });
    expect(authClient.signInWithPassword).not.toHaveBeenCalled();
    expect(authClient.updateUser).not.toHaveBeenCalled();
  });

  it("exchanges and clears a recovery session after resetting the password", async () => {
    const authClient = setupClient();
    const { storage } = createStorage();
    const auth = createBackgroundAuth(config, storage);

    const result = await auth.resetPassword({ code: "recovery-code" }, "new-password");

    expect(result).toEqual({ success: true, data: null });
    expect(authClient.exchangeCodeForSession).toHaveBeenCalledWith("recovery-code");
    expect(authClient.updateUser).toHaveBeenCalledWith({
      password: "new-password",
    });
    expect(authClient.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(JSON.stringify(result)).not.toContain("recovery-code");
  });

  it("requires reset-password requests to originate from the recovery route", () => {
    expect(
      isTrustedDashboardAuthSender(
        {
          id: "extension-id",
          url: "chrome-extension://extension-id/index.html?flow=recovery",
        },
        "extension-id",
        "chrome-extension://extension-id/index.html",
        true,
      ),
    ).toBe(true);
    expect(
      isTrustedDashboardAuthSender(
        {
          id: "extension-id",
          url: "chrome-extension://extension-id/index.html#/dashboard",
        },
        "extension-id",
        "chrome-extension://extension-id/index.html",
        true,
      ),
    ).toBe(false);
  });
});

const config = {
  url: "https://project.supabase.co",
  publishableKey: "sb_publishable_test-public-key",
};

const redirectUrl = "https://extension-id.chromiumapp.org/";
const oauthUrl = new URL("https://project.supabase.co/auth/v1/authorize");
oauthUrl.searchParams.set("provider", "google");
oauthUrl.searchParams.set("redirect_to", redirectUrl);
oauthUrl.searchParams.set("code_challenge", "pkce-challenge");
oauthUrl.searchParams.set("code_challenge_method", "s256");

const user = {
  id: "supabase-user-id",
  email: "learner@example.com",
} as User;

function session(overrides: Partial<Session> = {}): Session {
  return {
    access_token: "access-token-for-unit-test",
    refresh_token: "refresh-token-for-unit-test",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user,
    ...overrides,
  } as Session;
}

function legacyPublicKey(role: string): string {
  const encode = (value: Record<string, string>) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role })}.c2lnbmF0dXJl`;
}

function createStorage() {
  const values = new Map<string, unknown>();
  const storage: ChromeStorageArea = {
    get: vi.fn(async (key: string) => {
      return values.has(key) ? { [key]: values.get(key) } : {};
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    setAccessLevel: vi.fn(async () => undefined),
  };
  return { storage, values };
}

function setupClient(
  options: {
    currentSession?: Session | null;
    refreshSession?: Session | null;
    authError?: unknown;
  } = {},
) {
  const currentSession = options.currentSession ?? null;
  const auth = {
    getSession: vi.fn(async () => ({
      data: { session: currentSession },
      error: null,
    })),
    signUp: vi.fn(async () => ({
      data: {
        user,
        session: options.currentSession ?? null,
      },
      error: options.authError ?? null,
    })),
    signInWithPassword: vi.fn(async () => ({
      data: {
        user,
        session: options.currentSession ?? null,
      },
      error: options.authError ?? null,
    })),
    getUser: vi.fn(async () => ({ data: { user }, error: null })),
    resetPasswordForEmail: vi.fn(async () => ({ error: null })),
    setSession: vi.fn(async () => ({ data: { session: null, user }, error: null })),
    verifyOtp: vi.fn(async () => ({ data: { session: null, user }, error: null })),
    updateUser: vi.fn(async () => ({ data: { user }, error: null })),
    signInWithOAuth: vi.fn(async () => ({
      data: { provider: "google", url: oauthUrl.href, flowId: null },
      error: null,
    })),
    exchangeCodeForSession: vi.fn(
      async (): Promise<{
        data: { user: User | null; session: Session | null };
        error: Error | null;
      }> => ({
        data: { user, session: null },
        error: null,
      }),
    ),
    signOut: vi.fn(async () => ({ error: options.authError ?? null })),
    refreshSession: vi.fn(async () => ({
      data: { session: options.refreshSession ?? null },
      error: options.authError ?? null,
    })),
  };
  vi.mocked(createClient).mockReturnValue({
    auth,
  } as unknown as ReturnType<typeof createClient>);
  return auth;
}

function createAuthSpies() {
  const methods = {
    initialize: vi.fn(async () => ({ success: true as const, data: null })),
    getStatus: vi.fn(async () => ({
      success: true as const,
      data: { configured: true, authenticated: false },
    })),
    signUp: vi.fn(async () => ({
      success: true as const,
      data: { user: null, requiresEmailConfirmation: false },
    })),
    signIn: vi.fn(async () => ({
      success: true as const,
      data: { user: null, requiresEmailConfirmation: false },
    })),
    signInWithGoogle: vi.fn(async () => ({
      success: true as const,
      data: { user: null, requiresEmailConfirmation: false },
    })),
    sendPasswordRecovery: vi.fn(async () => ({
      success: true as const,
      data: null,
    })),
    changePassword: vi.fn(async () => ({
      success: true as const,
      data: null,
    })),
    resetPassword: vi.fn(async () => ({
      success: true as const,
      data: null,
    })),
    signOut: vi.fn(async () => ({ success: true as const, data: null })),
    getAccessToken: vi.fn(async () => ({
      success: true as const,
      data: "test-token-must-not-be-returned",
    })),
  };
  return { auth: methods as BackgroundAuth, methods };
}

describe("background Supabase authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("handles missing Supabase configuration without creating a client", async () => {
    const { storage } = createStorage();
    const auth = createBackgroundAuth({}, storage);

    expect(await auth.getStatus()).toEqual({
      success: true,
      data: { configured: false, authenticated: false },
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("generates a Google PKCE URL and exchanges a validated callback code", async () => {
    const authClient = setupClient();
    const { storage, values } = createStorage();
    const identity = {
      getRedirectURL: vi.fn(() => redirectUrl),
      launchWebAuthFlow: vi.fn(async ({ url }: { url: string }) => {
        expect(url).toBe(oauthUrl.href);
        return `${redirectUrl}?code=authorization-code`;
      }),
    };
    authClient.exchangeCodeForSession.mockImplementationOnce(async () => {
      const adapter = vi.mocked(createClient).mock.calls[0][2]?.auth?.storage;
      await adapter?.setItem(
        "supabase.auth.token",
        JSON.stringify({ access_token: "private-access-token" }),
      );
      return { data: { user, session: session() }, error: null };
    });
    const auth = createBackgroundAuth(config, storage, identity);

    const result = await auth.signInWithGoogle();

    expect(authClient.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: redirectUrl,
        skipBrowserRedirect: true,
      },
    });
    expect(identity.launchWebAuthFlow).toHaveBeenCalledWith({
      url: oauthUrl.href,
      interactive: true,
    });
    expect(authClient.exchangeCodeForSession).toHaveBeenCalledWith(
      "authorization-code",
    );
    expect(values.has("supabase.auth.token")).toBe(true);
    expect(result).toEqual({
      success: true,
      data: {
        user: { id: user.id, email: user.email },
        requiresEmailConfirmation: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-access-token");
    expect(JSON.stringify(result)).not.toContain("refresh-token-for-unit-test");
  });

  it("rejects an authorization URL without a PKCE challenge", async () => {
    const authClient = setupClient();
    const { storage } = createStorage();
    const invalidUrl = new URL(oauthUrl);
    invalidUrl.searchParams.delete("code_challenge");
    const identity = {
      getRedirectURL: vi.fn(() => redirectUrl),
      launchWebAuthFlow: vi.fn(async () => `${redirectUrl}?code=unused`),
    };
    authClient.signInWithOAuth.mockResolvedValueOnce({
      data: { provider: "google", url: invalidUrl.href, flowId: null },
      error: null,
    });
    const auth = createBackgroundAuth(config, storage, identity);

    const result = await auth.signInWithGoogle();

    expect(result).toMatchObject({
      success: false,
      error: { diagnosticCode: "AUTH_OAUTH_FAILED" },
    });
    expect(identity.launchWebAuthFlow).not.toHaveBeenCalled();
    expect(authClient.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("fails clearly when Chrome identity support is unavailable", async () => {
    setupClient();
    const { storage } = createStorage();
    const auth = createBackgroundAuth(config, storage);

    expect(await auth.signInWithGoogle()).toMatchObject({
      success: false,
      error: {
        code: "AUTH_UNSUPPORTED_BROWSER",
        diagnosticCode: "AUTH_UNSUPPORTED_BROWSER",
      },
    });
  });

  it.each([
    ["cancelled by the user", undefined, "AUTH_OAUTH_CANCELLED"],
    [
      "provider denied consent",
      `${redirectUrl}?error=access_denied&error_description=private-detail`,
      "AUTH_OAUTH_FAILED",
    ],
    [
      "callback from a different origin",
      "https://attacker.example/?code=bad",
      "AUTH_OAUTH_FAILED",
    ],
    ["callback without a code", redirectUrl, "AUTH_OAUTH_FAILED"],
    [
      "callback with an error and code",
      `${redirectUrl}?error=access_denied&code=must-not-exchange`,
      "AUTH_OAUTH_FAILED",
    ],
  ] as const)(
    "safely rejects Google OAuth %s",
    async (_label, callback, diagnosticCode) => {
      const authClient = setupClient();
      const { storage } = createStorage();
      const identity = {
        getRedirectURL: vi.fn(() => redirectUrl),
        launchWebAuthFlow: vi.fn(async () => callback),
      };
      const auth = createBackgroundAuth(config, storage, identity);

      const result = await auth.signInWithGoogle();

      expect(result).toMatchObject({
        success: false,
        error: { diagnosticCode },
      });
      expect(authClient.exchangeCodeForSession).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("private-detail");
      expect(JSON.stringify(result)).not.toContain("must-not-exchange");
    },
  );

  it("sanitizes Chrome identity failures and code-exchange errors", async () => {
    const authClient = setupClient();
    const { storage } = createStorage();
    const identity = {
      getRedirectURL: vi.fn(() => redirectUrl),
      launchWebAuthFlow: vi.fn(async (): Promise<string | undefined> => {
        throw new Error("The user did not approve access.");
      }),
    };
    const auth = createBackgroundAuth(config, storage, identity);

    const cancelled = await auth.signInWithGoogle();
    expect(cancelled).toMatchObject({
      success: false,
      error: { diagnosticCode: "AUTH_OAUTH_CANCELLED" },
    });
    expect(JSON.stringify(cancelled)).not.toContain("did not approve access");

    identity.launchWebAuthFlow.mockResolvedValueOnce(
      `${redirectUrl}?code=authorization-code`,
    );
    authClient.exchangeCodeForSession.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: new Error("private exchange response"),
    });
    const exchangeFailure = await auth.signInWithGoogle();
    expect(exchangeFailure).toMatchObject({
      success: false,
      error: { diagnosticCode: "AUTH_OAUTH_FAILED" },
    });
    expect(JSON.stringify(exchangeFailure)).not.toContain(
      "private exchange response",
    );
  });

  it("logs safe OAuth stages and allowlisted Supabase error details only", async () => {
    const authClient = setupClient();
    const { storage } = createStorage();
    const identity = {
      getRedirectURL: vi.fn(() => redirectUrl),
      launchWebAuthFlow: vi.fn(async () => {
        throw new Error(
          "authorization-code private-access-token refresh-token-for-test",
        );
      }),
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const auth = createBackgroundAuth(config, storage, identity);

    authClient.signInWithOAuth.mockResolvedValueOnce({
      data: { provider: "google", url: oauthUrl.href, flowId: null },
      error: {
        name: "AuthApiError",
        code: "provider_disabled",
        status: 400,
        message:
          "user@example.com authorization-code private-access-token",
      } as never,
    });

    const authorizationFailure = await auth.signInWithGoogle();
    expect(authorizationFailure).toMatchObject({
      success: false,
      error: { diagnosticCode: "AUTH_OAUTH_FAILED" },
    });
    expect(warning).toHaveBeenLastCalledWith(
      "[YouTube Knowledge] Google OAuth failed.",
      {
        stage: "authorization_request",
        diagnosticCode: "AUTH_OAUTH_FAILED",
        errorCode: "provider_disabled",
        errorName: "AuthApiError",
        httpStatus: 400,
      },
    );

    await auth.signInWithGoogle();
    expect(warning).toHaveBeenLastCalledWith(
      "[YouTube Knowledge] Google OAuth failed.",
      {
        stage: "browser_flow",
        diagnosticCode: "AUTH_OAUTH_FAILED",
        errorName: "Error",
      },
    );

    const loggedOutput = JSON.stringify(warning.mock.calls);
    for (const secret of [
      "user@example.com",
      "authorization-code",
      "private-access-token",
      "refresh-token-for-test",
    ]) {
      expect(loggedOutput).not.toContain(secret);
    }
  });

  it("logs PKCE code-exchange failures without the code or raw SDK message", async () => {
    const authClient = setupClient();
    const { storage } = createStorage();
    const identity = {
      getRedirectURL: vi.fn(() => redirectUrl),
      launchWebAuthFlow: vi.fn(async () =>
        `${redirectUrl}?code=private-authorization-code`,
      ),
    };
    authClient.exchangeCodeForSession.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: {
        name: "AuthPKCECodeVerifierMissingError",
        code: "pkce_verification_failed",
        status: 400,
        message: "private PKCE verifier and refresh token",
      } as never,
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const auth = createBackgroundAuth(config, storage, identity);

    const result = await auth.signInWithGoogle();

    expect(result).toMatchObject({
      success: false,
      error: { diagnosticCode: "AUTH_OAUTH_FAILED" },
    });
    expect(warning).toHaveBeenCalledWith(
      "[YouTube Knowledge] Google OAuth failed.",
      {
        stage: "code_exchange",
        diagnosticCode: "AUTH_OAUTH_FAILED",
        errorCode: "pkce_verification_failed",
        errorName: "AuthPKCECodeVerifierMissingError",
        httpStatus: 400,
      },
    );
    const loggedOutput = JSON.stringify(warning.mock.calls);
    expect(loggedOutput).not.toContain("private-authorization-code");
    expect(loggedOutput).not.toContain("private PKCE verifier");
    expect(loggedOutput).not.toContain("refresh token");
  });

  it("accepts publishable and legacy anon public keys", () => {
    expect(isPublicConfiguration(config)).toBe(true);
    expect(
      isPublicConfiguration({
        ...config,
        publishableKey: legacyPublicKey("anon"),
      }),
    ).toBe(true);
  });

  it("rejects secret, legacy service-role, and malformed keys", () => {
    for (const publishableKey of [
      "sb_secret_do-not-use",
      legacyPublicKey("service_role"),
      "not-a-key",
      "header.!.signature",
      "header.eyJyb2xlIjoiYW5vbiJ9.signature",
    ]) {
      expect(
        isPublicConfiguration({ ...config, publishableKey }),
      ).toBe(false);
    }
  });

  it("creates a persistent client with URL session detection disabled", async () => {
    const { storage } = createStorage();
    setupClient();
    const auth = createBackgroundAuth(config, storage);

    await auth.initialize();

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createClient).mock.calls[0][2]?.auth).toMatchObject({
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: "pkce",
    });
  });

  it("creates the background client only once across getter calls", async () => {
    const { storage } = createStorage();
    setupClient();
    vi.stubEnv("VITE_SUPABASE_URL", config.url);
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", config.publishableKey);
    vi.stubGlobal("chrome", { storage: { local: storage } });

    const first = getBackgroundAuth();
    const second = getBackgroundAuth();

    expect(first).toBe(second);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("reads, writes, and removes persisted values using trusted storage", async () => {
    const { storage, values } = createStorage();
    const adapter = createChromeStorageAdapter(storage);

    expect(await adapter.getItem("session")).toBeNull();
    await adapter.setItem("session", "persisted-session");
    expect(await adapter.getItem("session")).toBe("persisted-session");
    await adapter.removeItem("session");
    expect(await adapter.getItem("session")).toBeNull();
    expect(storage.setAccessLevel).toHaveBeenCalledTimes(1);
    expect(values.size).toBe(0);
  });

  it("propagates Chrome storage failures to Supabase", async () => {
    const { storage } = createStorage();
    vi.mocked(storage.set).mockRejectedValueOnce(new Error("storage failure"));
    const adapter = createChromeStorageAdapter(storage);

    await expect(adapter.setItem("session", "value")).rejects.toThrow(
      "storage failure",
    );
  });

  it("propagates read and remove failures from Chrome storage", async () => {
    const { storage } = createStorage();
    const adapter = createChromeStorageAdapter(storage);
    vi.mocked(storage.get).mockRejectedValueOnce(new Error("read failure"));
    vi.mocked(storage.remove).mockRejectedValueOnce(
      new Error("remove failure"),
    );

    await expect(adapter.getItem("session")).rejects.toThrow("read failure");
    await expect(adapter.removeItem("session")).rejects.toThrow(
      "remove failure",
    );
  });

  it("reports when secure storage access control is unsupported", async () => {
    setupClient();
    const { storage } = createStorage();
    const storageWithoutAccessLevel: ChromeStorageArea = {
      get: storage.get,
      set: storage.set,
      remove: storage.remove,
    };
    const auth = createBackgroundAuth(config, storageWithoutAccessLevel);

    expect(await auth.initialize()).toEqual({
      success: false,
      error: {
        code: "AUTH_UNSUPPORTED_BROWSER",
        message:
          "This browser does not support the secure extension storage required for Supabase authentication. Update Chrome to version 102 or newer.",
        diagnosticCode: "AUTH_UNSUPPORTED_BROWSER",
      },
    });
  });

  it("retries initialization after a failed session restoration", async () => {
    const authClient = setupClient();
    authClient.getSession.mockRejectedValueOnce(new Error("storage unavailable"));
    const { storage } = createStorage();
    const auth = createBackgroundAuth(config, storage);

    const firstAttempt = await auth.initialize();
    const retry = await auth.initialize();

    expect(firstAttempt).toMatchObject({
      success: false,
      error: { code: "AUTH_STORAGE_UNAVAILABLE" },
    });
    expect(retry).toEqual({ success: true, data: null });
    expect(authClient.getSession).toHaveBeenCalledTimes(2);
  });

  it("deduplicates simultaneous successful initialization attempts", async () => {
    const authClient = setupClient();
    let resolveSession!: (value: {
      data: { session: null };
      error: null;
    }) => void;
    authClient.getSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    );
    const { storage } = createStorage();
    const auth = createBackgroundAuth(config, storage);

    const first = auth.initialize();
    const second = auth.initialize();
    expect(authClient.getSession).toHaveBeenCalledTimes(1);

    resolveSession({ data: { session: null }, error: null });
    expect(await Promise.all([first, second])).toEqual([
      { success: true, data: null },
      { success: true, data: null },
    ]);
    expect(authClient.getSession).toHaveBeenCalledTimes(1);
  });

  it("restores a session through the same persistent storage after reinitialization", async () => {
    const { storage, values } = createStorage();
    const persistedSession = session();
    values.set("supabase.auth.token", JSON.stringify(persistedSession));
    const getSession = vi.fn(async () => {
      const adapter = vi.mocked(createClient).mock.calls.at(-1)?.[2]?.auth
        ?.storage;
      const saved = await adapter?.getItem("supabase.auth.token");
      return {
        data: { session: saved ? (JSON.parse(saved) as Session) : null },
        error: null,
      };
    });
    vi.mocked(createClient).mockReturnValue({
      auth: {
        getSession,
        signUp: vi.fn(),
        signInWithPassword: vi.fn(),
        signOut: vi.fn(),
        refreshSession: vi.fn(),
      },
    } as unknown as ReturnType<typeof createClient>);

    const afterWorkerRestart = createBackgroundAuth(config, storage);
    const result = await afterWorkerRestart.getStatus();

    expect(result).toEqual({
      success: true,
      data: {
        configured: true,
        authenticated: true,
        user: { id: user.id, email: user.email },
      },
    });
    expect(getSession).toHaveBeenCalled();
  });

  it("returns safe status without tokens or session objects", async () => {
    setupClient({ currentSession: session() });
    const { storage } = createStorage();
    const auth = createBackgroundAuth(config, storage);

    const result = await handleAuthRuntimeMessage(auth, {
      type: "AUTH_GET_STATUS",
    });

    expect(result).toEqual({
      type: "AUTH_GET_STATUS",
      result: {
        success: true,
        data: {
          configured: true,
          authenticated: true,
          user: { id: user.id, email: user.email },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("access-token-for-unit-test");
    expect(JSON.stringify(result)).not.toContain("refresh-token-for-unit-test");
  });

  it("returns safe signup and signin results without exposing SDK errors", async () => {
    const authClient = setupClient({
      currentSession: session(),
      authError: new Error("internal SDK detail"),
    });
    const { storage } = createStorage();
    const auth = createBackgroundAuth(config, storage);

    const signup = await auth.signUp("learner@example.com", "password");
    const signin = await auth.signIn("learner@example.com", "password");

    expect(signup).toEqual({
      success: false,
      error: {
        code: "AUTH_REQUEST_FAILED",
        message: "Supabase could not complete the authentication request.",
        diagnosticCode: "AUTH_UNKNOWN",
      },
    });
    expect(signin).toEqual(signup);
    expect(JSON.stringify(signup)).not.toContain("internal SDK detail");
    expect(authClient.signUp).toHaveBeenCalledWith({
      email: "learner@example.com",
      password: "password",
    });
  });

  it("maps only allowlisted Supabase error codes and valid statuses", async () => {
    expect(
      sanitizeAuthDiagnostic({ code: "invalid_credentials", status: 400 }),
    ).toEqual({
      diagnosticCode: "AUTH_INVALID_CREDENTIALS",
      httpStatus: 400,
    });
    expect(
      sanitizeAuthDiagnostic({ code: "weak_password", status: 422 }),
    ).toEqual({
      diagnosticCode: "AUTH_PASSWORD_POLICY",
      httpStatus: 422,
    });
    expect(
      sanitizeAuthDiagnostic({ code: "email_exists", status: 400 }),
    ).toEqual({
      diagnosticCode: "AUTH_EMAIL_REGISTERED",
      httpStatus: 400,
    });
    expect(sanitizeAuthDiagnostic({ status: 429 })).toEqual({
      diagnosticCode: "AUTH_RATE_LIMITED",
      httpStatus: 429,
    });
    expect(sanitizeAuthDiagnostic({ status: 503 })).toEqual({
      diagnosticCode: "AUTH_SERVER_ERROR",
      httpStatus: 503,
    });
  });

  it("keeps unknown and exception diagnostics safe without raw error text", async () => {
    const secretLikeText =
      "Unexpected response for learner@example.com password=hidden-token";
    expect(sanitizeAuthDiagnostic({ code: "unrecognized", message: secretLikeText }))
      .toEqual({ diagnosticCode: "AUTH_UNKNOWN" });
    expect(sanitizeAuthDiagnostic(new Error(secretLikeText))).toEqual({
      diagnosticCode: "AUTH_UNKNOWN",
    });

    setupClient({
      authError: { code: "unrecognized", message: secretLikeText, status: 400 },
    });
    const { storage } = createStorage();
    const result = await createBackgroundAuth(config, storage).signUp(
      "learner@example.com",
      "password",
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: "AUTH_REQUEST_FAILED",
        message: "Supabase could not complete the authentication request.",
        diagnosticCode: "AUTH_UNKNOWN",
        httpStatus: 400,
      },
    });
    expect(JSON.stringify(result)).not.toContain(secretLikeText);
    expect(JSON.stringify(result)).not.toContain("password=hidden-token");
  });

  it("sanitizes rejected Supabase signup requests", async () => {
    const authClient = setupClient();
    const rawError =
      "Signup failed for learner@example.com with password=private-value";
    authClient.signUp.mockRejectedValueOnce(new Error(rawError));
    const { storage } = createStorage();

    const result = await createBackgroundAuth(config, storage).signUp(
      "learner@example.com",
      "password",
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: "AUTH_REQUEST_FAILED",
        message: "Supabase could not complete the authentication request.",
        diagnosticCode: "AUTH_UNKNOWN",
      },
    });
    expect(JSON.stringify(result)).not.toContain(rawError);
    expect(JSON.stringify(result)).not.toContain("private-value");
  });

  it("maps known setup and network failures without exposing exception messages", async () => {
    expect(sanitizeAuthDiagnostic({ name: "AuthRetryableFetchError" })).toEqual({
      diagnosticCode: "AUTH_NETWORK_ERROR",
    });

    const noConfig = await createBackgroundAuth({}, createStorage().storage).signUp(
      "learner@example.com",
      "password",
    );
    expect(noConfig).toMatchObject({
      success: false,
      error: {
        diagnosticCode: "AUTH_NOT_CONFIGURED",
        message: "Supabase authentication is not configured.",
      },
    });
  });

  it("reports confirmation requirement without returning a signup session", async () => {
    setupClient();
    const { storage } = createStorage();
    const auth = createBackgroundAuth(config, storage);

    expect(await auth.signUp("learner@example.com", "password")).toEqual({
      success: true,
      data: {
        user: { id: user.id, email: user.email },
        requiresEmailConfirmation: true,
      },
    });
  });

  it("returns a safe signin success profile", async () => {
    setupClient({ currentSession: session() });
    const { storage } = createStorage();
    const auth = createBackgroundAuth(config, storage);

    expect(await auth.signIn("learner@example.com", "password")).toEqual({
      success: true,
      data: {
        user: { id: user.id, email: user.email },
        requiresEmailConfirmation: false,
      },
    });
  });

  it("refreshes sessions close to expiry on demand", async () => {
    setupClient({
      currentSession: session({
        expires_at: Math.floor(Date.now() / 1000) + 10,
      }),
      refreshSession: session({ access_token: "refreshed-access-token" }),
    });
    const { storage } = createStorage();
    const auth = createBackgroundAuth(config, storage);

    const result = await auth.getAccessToken();

    expect(result).toEqual({
      success: true,
      data: "refreshed-access-token",
    });
  });

  it("does not return an empty access token as authenticated", async () => {
    setupClient({
      currentSession: session({ access_token: "" }),
    });
    const { storage } = createStorage();
    const auth = createBackgroundAuth(config, storage);

    expect(await auth.getAccessToken()).toEqual({
      success: true,
      data: null,
    });
    expect(await auth.getStatus()).toEqual({
      success: true,
      data: { configured: true, authenticated: false, user },
    });
  });

  it("signs out locally and clears Supabase's persisted session", async () => {
    const { storage, values } = createStorage();
    values.set("supabase.auth.token", "session-data");
    values.set("youtubeKnowledgeSidebarPosition", { x: 10, y: 20 });
    const authClient = setupClient();
    authClient.signOut.mockImplementation(async () => {
      const adapter = vi.mocked(createClient).mock.calls[0][2]?.auth?.storage;
      await adapter?.removeItem("supabase.auth.token");
      return { error: null };
    });
    const auth = createBackgroundAuth(config, storage);

    expect(await auth.signOut()).toEqual({ success: true, data: null });
    expect(values.has("supabase.auth.token")).toBe(false);
    expect(values.get("youtubeKnowledgeSidebarPosition")).toEqual({
      x: 10,
      y: 20,
    });
    expect(authClient.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("rejects authentication requests from YouTube content scripts", () => {
    expect(
      isTrustedDashboardAuthSender(
        {
          id: "extension-id",
          url: "https://www.youtube.com/watch?v=video-id",
        },
        "extension-id",
        "chrome-extension://extension-id/index.html",
      ),
    ).toBe(false);
  });

  it("accepts auth requests only from this extension's dashboard document", () => {
    expect(
      isTrustedDashboardAuthSender(
        {
          id: "extension-id",
          url: "chrome-extension://extension-id/index.html#/dashboard",
        },
        "extension-id",
        "chrome-extension://extension-id/index.html",
      ),
    ).toBe(true);
    expect(
      isTrustedDashboardAuthSender(
        {
          id: "other-extension",
          url: "chrome-extension://other-extension/index.html",
        },
        "extension-id",
        "chrome-extension://extension-id/index.html",
      ),
    ).toBe(false);
  });

  it("does not classify existing API message types as authentication requests", () => {
    expect(isAuthRuntimeRequest({ type: "GET_NOTES" })).toBe(false);
    expect(isAuthRuntimeRequest({ type: "CREATE_NOTE", data: {} })).toBe(false);
    expect(
      isAuthRuntimeRequest({
        type: "AUTH_SIGN_IN",
        email: "learner@example.com",
      }),
    ).toBe(false);
  });

  it("does not accept dashboard requests for an access token", () => {
    expect(
      isAuthRuntimeRequest({ type: "AUTH_GET_ACCESS_TOKEN" }),
    ).toBe(false);
  });

  it("dispatches an auth message from the matching dashboard document", async () => {
    const { auth, methods } = createAuthSpies();
    const responsePromise = new Promise<unknown>((resolve) => {
      const handled = dispatchAuthRuntimeMessage(
        auth,
        { type: "AUTH_GET_STATUS" },
        {
          id: "extension-id",
          url: "chrome-extension://extension-id/index.html#/dashboard",
        },
        "extension-id",
        "chrome-extension://extension-id/index.html",
        resolve,
      );
      expect(handled).toBe(true);
    });

    expect(await responsePromise).toMatchObject({
      type: "AUTH_GET_STATUS",
      result: { success: true, data: { configured: true } },
    });
    expect(methods.getStatus).toHaveBeenCalledTimes(1);
  });

  it("dispatches Google sign-in only through the dashboard and never returns tokens", async () => {
    const { auth, methods } = createAuthSpies();
    const responsePromise = new Promise<unknown>((resolve) => {
      dispatchAuthRuntimeMessage(
        auth,
        { type: "AUTH_SIGN_IN_WITH_GOOGLE" },
        {
          id: "extension-id",
          url: "chrome-extension://extension-id/index.html#/dashboard",
        },
        "extension-id",
        "chrome-extension://extension-id/index.html",
        resolve,
      );
    });

    const response = await responsePromise;
    expect(response).toMatchObject({
      type: "AUTH_SIGN_IN_WITH_GOOGLE",
      result: { success: true },
    });
    expect(methods.signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(response)).not.toContain(
      "test-token-must-not-be-returned",
    );
  });

  it.each([
    [
      "YouTube content script",
      {
        id: "extension-id",
        url: "https://www.youtube.com/watch?v=video-id",
      },
    ],
    [
      "foreign extension ID",
      {
        id: "foreign-extension",
        url: "chrome-extension://foreign-extension/index.html",
      },
    ],
    [
      "unexpected extension page",
      {
        id: "extension-id",
        url: "chrome-extension://extension-id/options.html",
      },
    ],
    ["missing sender", undefined],
    [
      "malformed sender URL",
      { id: "extension-id", url: "not a valid URL" },
    ],
  ])("rejects auth dispatch from %s without invoking auth", (_label, sender) => {
    const { auth, methods } = createAuthSpies();
    const sendResponse = vi.fn();

    expect(
      dispatchAuthRuntimeMessage(
        auth,
        { type: "AUTH_SIGN_OUT" },
        sender,
        "extension-id",
        "chrome-extension://extension-id/index.html",
        sendResponse,
      ),
    ).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "AUTH_ERROR",
        result: expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            message: "This authentication request is not allowed.",
          }),
        }),
      }),
    );
    expect(methods.initialize).not.toHaveBeenCalled();
    expect(methods.getStatus).not.toHaveBeenCalled();
    expect(methods.signUp).not.toHaveBeenCalled();
    expect(methods.signIn).not.toHaveBeenCalled();
    expect(methods.signInWithGoogle).not.toHaveBeenCalled();
    expect(methods.signOut).not.toHaveBeenCalled();
    expect(methods.getAccessToken).not.toHaveBeenCalled();
  });

  it("rejects a removed token operation through runtime dispatch", () => {
    const { auth, methods } = createAuthSpies();
    const sendResponse = vi.fn();

    expect(
      dispatchAuthRuntimeMessage(
        auth,
        { type: "AUTH_GET_ACCESS_TOKEN" },
        {
          id: "extension-id",
          url: "chrome-extension://extension-id/index.html",
        },
        "extension-id",
        "chrome-extension://extension-id/index.html",
        sendResponse,
      ),
    ).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "AUTH_ERROR",
        result: expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            message: "The authentication request is invalid.",
          }),
        }),
      }),
    );
    expect(JSON.stringify(sendResponse.mock.calls)).not.toContain(
      "test-token-must-not-be-returned",
    );
    expect(methods.getAccessToken).not.toHaveBeenCalled();
    expect(methods.getStatus).not.toHaveBeenCalled();
    expect(methods.signUp).not.toHaveBeenCalled();
    expect(methods.signIn).not.toHaveBeenCalled();
    expect(methods.signInWithGoogle).not.toHaveBeenCalled();
    expect(methods.signOut).not.toHaveBeenCalled();
  });
});
