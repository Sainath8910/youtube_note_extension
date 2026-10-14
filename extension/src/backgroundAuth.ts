import {
  createClient,
  type Session,
  type User,
} from "@supabase/supabase-js";

const ACCESS_TOKEN_REFRESH_MARGIN_SECONDS = 60;
const PASSWORD_RECOVERY_MARKER_KEY =
  "youtubeKnowledgePasswordRecoveryVerified";
const PASSWORD_RECOVERY_MARKER_TTL_MS = 15 * 60 * 1000;
const UNSUPPORTED_STORAGE_API_MESSAGE =
  "This browser does not support the secure extension storage required for Supabase authentication. Update Chrome to version 102 or newer.";

export interface SupabasePublicConfig {
  url?: string;
  publishableKey?: string;
}

export interface ChromeStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
  setAccessLevel?(options: {
    accessLevel: "TRUSTED_CONTEXTS";
  }): Promise<void>;
}

export interface ChromeIdentityApi {
  getRedirectURL(path?: string): string;
  launchWebAuthFlow(details: {
    url: string;
    interactive: boolean;
  }): Promise<string | undefined>;
}

export interface SafeAuthUser {
  id: string;
  email: string | null;
  hasPassword?: boolean;
}

export interface AuthFailure {
  code:
    | "AUTH_NOT_CONFIGURED"
    | "AUTH_STORAGE_UNAVAILABLE"
    | "AUTH_REQUEST_FAILED"
    | "AUTH_UNSUPPORTED_BROWSER";
  message: string;
  diagnosticCode: AuthDiagnosticCode;
  httpStatus?: number;
}

export type AuthDiagnosticCode =
  | "AUTH_INVALID_CREDENTIALS"
  | "AUTH_PASSWORD_POLICY"
  | "AUTH_EMAIL_REGISTERED"
  | "AUTH_RATE_LIMITED"
  | "AUTH_NETWORK_ERROR"
  | "AUTH_SERVER_ERROR"
  | "AUTH_OAUTH_CANCELLED"
  | "AUTH_OAUTH_FAILED"
  | "AUTH_NOT_CONFIGURED"
  | "AUTH_UNSUPPORTED_BROWSER"
  | "AUTH_STORAGE_UNAVAILABLE"
  | "AUTH_UNKNOWN";

export type AuthResult<T> =
  | { success: true; data: T }
  | { success: false; error: AuthFailure };

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  user?: SafeAuthUser;
}

export interface SafeAuthMutation {
  user: SafeAuthUser | null;
  requiresEmailConfirmation: boolean;
}

export type AuthRuntimeRequest =
  | { type: "AUTH_GET_STATUS" }
  | { type: "AUTH_SIGN_UP"; email: string; password: string }
  | { type: "AUTH_SIGN_IN"; email: string; password: string }
  | { type: "AUTH_SIGN_IN_WITH_GOOGLE" }
  | { type: "AUTH_SEND_PASSWORD_RECOVERY"; email: string }
  | {
      type: "AUTH_VERIFY_PASSWORD_RECOVERY";
      credentials: RecoveryCredentials;
    }
  | {
      type: "AUTH_CHANGE_PASSWORD";
      currentPassword: string;
      newPassword: string;
    }
  | { type: "AUTH_RESET_PASSWORD"; newPassword: string }
  | { type: "AUTH_SIGN_OUT" };

export type RecoveryCredentials =
  | { accessToken: string; refreshToken: string }
  | { code: string }
  | { tokenHash: string };

export type AuthRuntimeResponse =
  | { type: "AUTH_ERROR"; result: AuthResult<never> }
  | { type: "AUTH_GET_STATUS"; result: AuthResult<AuthStatus> }
  | { type: "AUTH_SIGN_UP"; result: AuthResult<SafeAuthMutation> }
  | { type: "AUTH_SIGN_IN"; result: AuthResult<SafeAuthMutation> }
  | { type: "AUTH_SIGN_IN_WITH_GOOGLE"; result: AuthResult<SafeAuthMutation> }
  | { type: "AUTH_SEND_PASSWORD_RECOVERY"; result: AuthResult<null> }
  | { type: "AUTH_VERIFY_PASSWORD_RECOVERY"; result: AuthResult<null> }
  | { type: "AUTH_CHANGE_PASSWORD"; result: AuthResult<null> }
  | { type: "AUTH_RESET_PASSWORD"; result: AuthResult<null> }
  | { type: "AUTH_SIGN_OUT"; result: AuthResult<null> };

export interface BackgroundAuth {
  initialize(): Promise<AuthResult<null>>;
  getStatus(): Promise<AuthResult<AuthStatus>>;
  signUp(email: string, password: string): Promise<AuthResult<SafeAuthMutation>>;
  signIn(email: string, password: string): Promise<AuthResult<SafeAuthMutation>>;
  signInWithGoogle(): Promise<AuthResult<SafeAuthMutation>>;
  sendPasswordRecovery(
    email: string,
    redirectTo: string,
  ): Promise<AuthResult<null>>;
  verifyPasswordRecovery(
    credentials: RecoveryCredentials,
  ): Promise<AuthResult<null>>;
  changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<AuthResult<null>>;
  resetPassword(newPassword: string): Promise<AuthResult<null>>;
  signOut(): Promise<AuthResult<null>>;
  getAccessToken(): Promise<AuthResult<string | null>>;
}

function failure(
  code: AuthFailure["code"],
  message: string,
  diagnosticCode: AuthDiagnosticCode = diagnosticForFailureCode(code),
  httpStatus?: number,
): AuthResult<never> {
  return {
    success: false,
    error: {
      code,
      message,
      diagnosticCode,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    },
  };
}

function diagnosticForFailureCode(
  code: AuthFailure["code"],
): AuthDiagnosticCode {
  switch (code) {
    case "AUTH_NOT_CONFIGURED":
      return "AUTH_NOT_CONFIGURED";
    case "AUTH_UNSUPPORTED_BROWSER":
      return "AUTH_UNSUPPORTED_BROWSER";
    case "AUTH_STORAGE_UNAVAILABLE":
      return "AUTH_STORAGE_UNAVAILABLE";
    case "AUTH_REQUEST_FAILED":
      return "AUTH_UNKNOWN";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type GoogleOAuthFailureStage =
  | "concurrent_attempt"
  | "redirect_url"
  | "authorization_request"
  | "authorization_url"
  | "browser_flow"
  | "callback_url"
  | "provider_callback"
  | "callback_code"
  | "code_exchange"
  | "session_validation";

const SAFE_OAUTH_ERROR_CODES = new Set([
  "bad_oauth_state",
  "email_exists",
  "flow_state_not_found",
  "invalid_request",
  "over_request_rate_limit",
  "pkce_verification_failed",
  "provider_disabled",
  "request_timeout",
  "unexpected_failure",
  "validation_failed",
]);

const SAFE_OAUTH_ERROR_NAMES = new Set([
  "AuthApiError",
  "AuthPKCECodeVerifierMissingError",
  "AuthRetryableFetchError",
  "AuthUnknownError",
  "Error",
  "TypeError",
]);

function logGoogleOAuthFailure(
  stage: GoogleOAuthFailureStage,
  diagnosticCode: "AUTH_OAUTH_FAILED" | "AUTH_OAUTH_CANCELLED" = "AUTH_OAUTH_FAILED",
  error?: unknown,
): void {
  const details = isRecord(error) ? error : {};
  const errorCode =
    typeof details.code === "string" &&
    SAFE_OAUTH_ERROR_CODES.has(details.code.toLowerCase())
      ? details.code.toLowerCase()
      : undefined;
  const errorName =
    typeof details.name === "string" &&
    SAFE_OAUTH_ERROR_NAMES.has(details.name)
      ? details.name
      : undefined;
  const httpStatus =
    typeof details.status === "number" &&
    Number.isInteger(details.status) &&
    details.status >= 100 &&
    details.status <= 599
      ? details.status
      : undefined;

  console.warn("[YouTube Knowledge] Google OAuth failed.", {
    stage,
    diagnosticCode,
    ...(errorCode ? { errorCode } : {}),
    ...(errorName ? { errorName } : {}),
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });
}

export function sanitizeAuthDiagnostic(error: unknown): {
  diagnosticCode: AuthDiagnosticCode;
  httpStatus?: number;
} {
  const details = isRecord(error) ? error : {};
  const status =
    typeof details.status === "number" &&
    Number.isInteger(details.status) &&
    details.status >= 100 &&
    details.status <= 599
      ? details.status
      : undefined;
  const errorCode =
    typeof details.code === "string" ? details.code.toLowerCase() : "";
  let diagnosticCode: AuthDiagnosticCode = "AUTH_UNKNOWN";

  if (["invalid_credentials", "invalid_grant"].includes(errorCode)) {
    diagnosticCode = "AUTH_INVALID_CREDENTIALS";
  } else if (
    ["weak_password", "password_too_short", "password_too_long"].includes(
      errorCode,
    )
  ) {
    diagnosticCode = "AUTH_PASSWORD_POLICY";
  } else if (
    ["user_already_exists", "email_exists"].includes(errorCode)
  ) {
    diagnosticCode = "AUTH_EMAIL_REGISTERED";
  } else if (status === 429) {
    diagnosticCode = "AUTH_RATE_LIMITED";
  } else if (status !== undefined && status >= 500) {
    diagnosticCode = "AUTH_SERVER_ERROR";
  } else if (
    details.name === "AuthRetryableFetchError" ||
    details.name === "TypeError"
  ) {
    diagnosticCode = "AUTH_NETWORK_ERROR";
  }

  return {
    diagnosticCode,
    ...(status === undefined ? {} : { httpStatus: status }),
  };
}

function safeUser(user: User | null | undefined): SafeAuthUser | null {
  if (!user) return null;
  const providers = user.app_metadata?.providers;
  const hasProviderMetadata =
    Array.isArray(providers) || Array.isArray(user.identities);
  const hasPassword =
    (Array.isArray(providers) && providers.includes("email")) ||
    user.identities?.some((identity) => identity.provider === "email") === true;
  return {
    id: user.id,
    email: user.email ?? null,
    ...(hasProviderMetadata ? { hasPassword } : {}),
  };
}

class UnsupportedStorageApiError extends Error {}

function decodeBase64UrlJson(value: string): Record<string, unknown> | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;

  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
      ),
    );
    return typeof decoded === "object" &&
      decoded !== null &&
      !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isSupportedPublicKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return false;
  if (key.startsWith("sb_publishable_")) {
    return key.length > "sb_publishable_".length;
  }

  const segments = key.split(".");
  if (
    segments.length !== 3 ||
    !segments[0] ||
    !segments[2] ||
    !/^[A-Za-z0-9_-]+$/.test(segments[2])
  ) {
    return false;
  }

  const header = decodeBase64UrlJson(segments[0]);
  const payload = decodeBase64UrlJson(segments[1]);
  if (!header || !payload || typeof header.alg !== "string") return false;
  return payload.role === "anon";
}

export function isPublicConfiguration(config: SupabasePublicConfig): boolean {
  if (!config.url || !config.publishableKey) return false;

  try {
    const url = new URL(config.url);
    const localDevelopment =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (
      (url.protocol !== "https:" && !localDevelopment) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !isSupportedPublicKey(config.publishableKey)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function createChromeStorageAdapter(storage: ChromeStorageArea) {
  let trustedContextSetup: Promise<void> | undefined;
  const ensureTrustedContext = () => {
    if (typeof storage.setAccessLevel !== "function") {
      return Promise.reject(
        new UnsupportedStorageApiError(
          UNSUPPORTED_STORAGE_API_MESSAGE,
        ),
      );
    }
    if (!trustedContextSetup) {
      const attempt = storage.setAccessLevel({
        accessLevel: "TRUSTED_CONTEXTS",
      });
      trustedContextSetup = attempt;
      void attempt.catch(() => {
        if (trustedContextSetup === attempt) trustedContextSetup = undefined;
      });
    }
    return trustedContextSetup;
  };

  return {
    async getItem(key: string): Promise<string | null> {
      await ensureTrustedContext();
      const result = await storage.get(key);
      const value = result[key];
      return typeof value === "string" ? value : null;
    },
    async setItem(key: string, value: string): Promise<void> {
      await ensureTrustedContext();
      await storage.set({ [key]: value });
    },
    async removeItem(key: string): Promise<void> {
      await ensureTrustedContext();
      await storage.remove(key);
    },
  };
}

export function createBackgroundAuth(
  config: SupabasePublicConfig,
  storageArea: ChromeStorageArea,
  identity?: ChromeIdentityApi,
): BackgroundAuth {
  if (
    !config.url ||
    !config.publishableKey ||
    !isPublicConfiguration(config)
  ) {
    console.warn(
      "[YouTube Knowledge] Supabase auth is unavailable; configure a public Supabase URL and publishable key.",
    );
    return {
      async initialize() {
        return failure(
          "AUTH_NOT_CONFIGURED",
          "Supabase authentication is not configured.",
        );
      },
      async getStatus() {
        return {
          success: true,
          data: { configured: false, authenticated: false },
        };
      },
      async signUp() {
        return failure(
          "AUTH_NOT_CONFIGURED",
          "Supabase authentication is not configured.",
        );
      },
      async signIn() {
        return failure(
          "AUTH_NOT_CONFIGURED",
          "Supabase authentication is not configured.",
        );
      },
      async signInWithGoogle() {
        return failure(
          "AUTH_NOT_CONFIGURED",
          "Supabase authentication is not configured.",
        );
      },
      async sendPasswordRecovery() {
        return failure(
          "AUTH_NOT_CONFIGURED",
          "Supabase authentication is not configured.",
        );
      },
      async verifyPasswordRecovery() {
        return failure(
          "AUTH_NOT_CONFIGURED",
          "Supabase authentication is not configured.",
        );
      },
      async changePassword() {
        return failure(
          "AUTH_NOT_CONFIGURED",
          "Supabase authentication is not configured.",
        );
      },
      async resetPassword() {
        return failure(
          "AUTH_NOT_CONFIGURED",
          "Supabase authentication is not configured.",
        );
      },
      async signOut() {
        return failure(
          "AUTH_NOT_CONFIGURED",
          "Supabase authentication is not configured.",
        );
      },
      async getAccessToken() {
        return failure(
          "AUTH_NOT_CONFIGURED",
          "Supabase authentication is not configured.",
        );
      },
    };
  }

  const supabaseStorage = createChromeStorageAdapter(storageArea);
  const client = createClient(config.url, config.publishableKey, {
    auth: {
      storage: supabaseStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: "pkce",
    },
  });
  let initialization: Promise<AuthResult<null>> | undefined;
  let googleSignInInProgress = false;
  let passwordRecoveryVerification:
    | Promise<AuthResult<null>>
    | undefined;

  const clearPasswordRecoveryMarker = () =>
    supabaseStorage.removeItem(PASSWORD_RECOVERY_MARKER_KEY);

  const currentRecoveryUserId = async (): Promise<string | null> => {
    const marker = await supabaseStorage.getItem(
      PASSWORD_RECOVERY_MARKER_KEY,
    );
    if (!marker) return null;
    try {
      const parsed: unknown = JSON.parse(marker);
      if (
        !isRecord(parsed) ||
        typeof parsed.userId !== "string" ||
        typeof parsed.expiresAt !== "number" ||
        parsed.expiresAt <= Date.now()
      ) {
        await clearPasswordRecoveryMarker();
        return null;
      }
      const { data, error } = await client.auth.getUser();
      if (error || data.user?.id !== parsed.userId) {
        await clearPasswordRecoveryMarker();
        return null;
      }
      return parsed.userId;
    } catch {
      await clearPasswordRecoveryMarker();
      return null;
    }
  };

  const initialize = (): Promise<AuthResult<null>> => {
    if (initialization) return initialization;

    const attempt = (async (): Promise<AuthResult<null>> => {
      if (typeof storageArea.setAccessLevel !== "function") {
        return failure(
          "AUTH_UNSUPPORTED_BROWSER",
          UNSUPPORTED_STORAGE_API_MESSAGE,
        );
      }
      try {
        const { error } = await client.auth.getSession();
        if (error) {
          return failure(
            "AUTH_STORAGE_UNAVAILABLE",
            "Could not restore the saved Supabase session.",
          );
        }
        return { success: true, data: null };
      } catch (error) {
        if (error instanceof UnsupportedStorageApiError) {
          return failure(
            "AUTH_UNSUPPORTED_BROWSER",
            "This browser does not support the secure extension storage required for Supabase authentication. Update Chrome to version 102 or newer.",
          );
        }
        return failure(
          "AUTH_STORAGE_UNAVAILABLE",
          "Could not restore the saved Supabase session.",
        );
      }
    })();
    initialization = attempt;
    void attempt.then((result) => {
      if (!result.success && initialization === attempt) {
        initialization = undefined;
      }
    });
    return attempt;
  };

  const getAccessToken = async (): Promise<AuthResult<string | null>> => {
    const ready = await initialize();
    if (!ready.success) return ready;
    try {
      const { data, error } = await client.auth.getSession();
      if (error) {
        return failure(
          "AUTH_STORAGE_UNAVAILABLE",
          "Could not read the saved Supabase session.",
        );
      }
      let session = data.session;
      if (!session) return { success: true, data: null };

      const expiresSoon =
        typeof session.expires_at !== "number" ||
        session.expires_at <=
          Math.floor(Date.now() / 1000) + ACCESS_TOKEN_REFRESH_MARGIN_SECONDS;
      if (expiresSoon) {
        const refreshed = await client.auth.refreshSession();
        if (refreshed.error) {
          return failure(
            "AUTH_REQUEST_FAILED",
            "The Supabase session could not be refreshed.",
          );
        }
        session = refreshed.data.session;
      }

      const accessToken = session?.access_token;
      return {
        success: true,
        data:
          typeof accessToken === "string" && accessToken.trim()
            ? accessToken
            : null,
      };
    } catch {
      return failure(
        "AUTH_REQUEST_FAILED",
        "Could not obtain a valid Supabase access token.",
      );
    }
  };

  const getStatus = async (): Promise<AuthResult<AuthStatus>> => {
    const token = await getAccessToken();
    if (!token.success) return token;

    try {
      const { data, error } = await client.auth.getSession();
      if (error) {
        return failure(
          "AUTH_STORAGE_UNAVAILABLE",
          "Could not read the saved Supabase session.",
        );
      }
      const user = safeUser(data.session?.user);
      return {
        success: true,
        data: {
          configured: true,
          authenticated: token.data !== null && user !== null,
          ...(user ? { user } : {}),
        },
      };
    } catch {
      return failure(
        "AUTH_STORAGE_UNAVAILABLE",
        "Could not read the saved Supabase session.",
      );
    }
  };

  const signInWithGoogle = async (): Promise<
    AuthResult<SafeAuthMutation>
  > => {
    const ready = await initialize();
    if (!ready.success) return ready;
    if (!identity) {
      return failure(
        "AUTH_UNSUPPORTED_BROWSER",
        "Google sign-in requires Chrome identity support. Update Chrome and try again.",
      );
    }
    if (googleSignInInProgress) {
      logGoogleOAuthFailure("concurrent_attempt");
      return failure(
        "AUTH_REQUEST_FAILED",
        "Google sign-in is already in progress.",
        "AUTH_OAUTH_FAILED",
      );
    }
    googleSignInInProgress = true;
    let stage: GoogleOAuthFailureStage = "redirect_url";

    try {
      const redirectTo = identity.getRedirectURL();
      const expectedRedirect = new URL(redirectTo);
      if (
        expectedRedirect.protocol !== "https:" ||
        !expectedRedirect.hostname.endsWith(".chromiumapp.org") ||
        expectedRedirect.username ||
        expectedRedirect.password
      ) {
        logGoogleOAuthFailure(stage);
        return failure(
          "AUTH_REQUEST_FAILED",
          "Chrome returned an invalid Google sign-in redirect.",
          "AUTH_OAUTH_FAILED",
        );
      }

      stage = "authorization_request";
      const { data, error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo,
          skipBrowserRedirect: true,
        },
      });
      if (error || typeof data.url !== "string") {
        logGoogleOAuthFailure(stage, "AUTH_OAUTH_FAILED", error);
        return failure(
          "AUTH_REQUEST_FAILED",
          "Google sign-in could not be started. Check your connection and try again.",
          "AUTH_OAUTH_FAILED",
        );
      }

      stage = "authorization_url";
      const authorizationUrl = new URL(data.url);
      const expectedSupabaseOrigin = new URL(config.url!).origin;
      if (
        authorizationUrl.protocol !== "https:" ||
        authorizationUrl.origin !== expectedSupabaseOrigin ||
        authorizationUrl.pathname !== "/auth/v1/authorize" ||
        authorizationUrl.searchParams.get("provider") !== "google" ||
        authorizationUrl.searchParams.get("redirect_to") !== redirectTo ||
        !authorizationUrl.searchParams.get("code_challenge") ||
        authorizationUrl.searchParams.get("code_challenge_method") !== "s256"
      ) {
        logGoogleOAuthFailure(stage);
        return failure(
          "AUTH_REQUEST_FAILED",
          "Google sign-in returned an invalid authorization request.",
          "AUTH_OAUTH_FAILED",
        );
      }

      stage = "browser_flow";
      const callback = await identity.launchWebAuthFlow({
        url: authorizationUrl.href,
        interactive: true,
      });
      if (!callback) {
        logGoogleOAuthFailure(stage, "AUTH_OAUTH_CANCELLED");
        return failure(
          "AUTH_REQUEST_FAILED",
          "Google sign-in was cancelled.",
          "AUTH_OAUTH_CANCELLED",
        );
      }

      stage = "callback_url";
      const callbackUrl = new URL(callback);
      if (
        callbackUrl.origin !== expectedRedirect.origin ||
        callbackUrl.pathname !== expectedRedirect.pathname ||
        callbackUrl.username ||
        callbackUrl.password ||
        callbackUrl.hash
      ) {
        logGoogleOAuthFailure(stage);
        return failure(
          "AUTH_REQUEST_FAILED",
          "Google sign-in returned an invalid callback.",
          "AUTH_OAUTH_FAILED",
        );
      }
      if (callbackUrl.searchParams.has("error")) {
        logGoogleOAuthFailure("provider_callback");
        return failure(
          "AUTH_REQUEST_FAILED",
          "Google sign-in was not completed. Review the consent request and try again.",
          "AUTH_OAUTH_FAILED",
        );
      }
      const code = callbackUrl.searchParams.get("code");
      if (!code) {
        logGoogleOAuthFailure("callback_code");
        return failure(
          "AUTH_REQUEST_FAILED",
          "Google sign-in returned an invalid or incomplete callback.",
          "AUTH_OAUTH_FAILED",
        );
      }

      stage = "code_exchange";
      const exchanged = await client.auth.exchangeCodeForSession(code);
      if (exchanged.error) {
        logGoogleOAuthFailure(stage, "AUTH_OAUTH_FAILED", exchanged.error);
        return failure(
          "AUTH_REQUEST_FAILED",
          "Google sign-in could not be completed. Try again.",
          "AUTH_OAUTH_FAILED",
        );
      }
      if (!exchanged.data.session || !exchanged.data.user) {
        logGoogleOAuthFailure("session_validation");
        return failure(
          "AUTH_REQUEST_FAILED",
          "Google sign-in could not be completed. Try again.",
          "AUTH_OAUTH_FAILED",
        );
      }
      await clearPasswordRecoveryMarker();
      return {
        success: true,
        data: {
          user: safeUser(exchanged.data.user),
          requiresEmailConfirmation: false,
        },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message.toLowerCase() : "";
      const cancelled =
        message.includes("user did not approve access") ||
        message.includes("user cancelled") ||
        message.includes("user canceled");
      logGoogleOAuthFailure(
        stage,
        cancelled ? "AUTH_OAUTH_CANCELLED" : "AUTH_OAUTH_FAILED",
        error,
      );
      return failure(
        "AUTH_REQUEST_FAILED",
        cancelled
          ? "Google sign-in was cancelled."
          : "Google sign-in could not be completed. Check your connection and try again.",
        cancelled ? "AUTH_OAUTH_CANCELLED" : "AUTH_OAUTH_FAILED",
      );
    } finally {
      googleSignInInProgress = false;
    }
  };

  const mutateAuth = async (
    operation: () => Promise<{
      data: { user: User | null; session: unknown };
      error: unknown;
    }>,
    requiresEmailConfirmation: boolean,
  ): Promise<AuthResult<SafeAuthMutation>> => {
    const ready = await initialize();
    if (!ready.success) return ready;

    try {
      await clearPasswordRecoveryMarker();
      const { data, error } = await operation();
      if (error) {
        const diagnostic = sanitizeAuthDiagnostic(error);
        return failure(
          "AUTH_REQUEST_FAILED",
          "Supabase could not complete the authentication request.",
          diagnostic.diagnosticCode,
          diagnostic.httpStatus,
        );
      }
      return {
        success: true,
        data: {
          user: safeUser(data.user),
          requiresEmailConfirmation:
            requiresEmailConfirmation && data.session === null,
        },
      };
    } catch (error) {
      const diagnostic = sanitizeAuthDiagnostic(error);
      return failure(
        "AUTH_REQUEST_FAILED",
        "Supabase could not complete the authentication request.",
        diagnostic.diagnosticCode,
        diagnostic.httpStatus,
      );
    }
  };

  return {
    initialize,
    getStatus,
    signUp(email, password) {
      return mutateAuth(
        () => client.auth.signUp({ email, password }),
        true,
      );
    },
    signIn(email, password) {
      return mutateAuth(
        () => client.auth.signInWithPassword({ email, password }),
        false,
      );
    },
    signInWithGoogle,
    async sendPasswordRecovery(email, redirectTo) {
      const ready = await initialize();
      if (!ready.success) return ready;
      try {
        await clearPasswordRecoveryMarker();
        const { error } = await client.auth.resetPasswordForEmail(email, {
          redirectTo,
        });
        if (error) {
          const diagnostic = sanitizeAuthDiagnostic(error);
          return failure(
            "AUTH_REQUEST_FAILED",
            "Supabase could not send the password recovery email.",
            diagnostic.diagnosticCode,
            diagnostic.httpStatus,
          );
        }
        return { success: true, data: null };
      } catch (error) {
        const diagnostic = sanitizeAuthDiagnostic(error);
        return failure(
          "AUTH_REQUEST_FAILED",
          "Supabase could not send the password recovery email.",
          diagnostic.diagnosticCode,
          diagnostic.httpStatus,
        );
      }
    },
    verifyPasswordRecovery(credentials) {
      if (passwordRecoveryVerification) {
        return passwordRecoveryVerification;
      }
      const attempt = (async (): Promise<AuthResult<null>> => {
        const ready = await initialize();
        if (!ready.success) return ready;
        try {
          if (await currentRecoveryUserId()) {
            return { success: true, data: null };
          }

          let recoveredSession: {
            session: Session | null;
            user: User | null;
            error: unknown;
          };
          if ("accessToken" in credentials) {
            const result = await client.auth.setSession({
              access_token: credentials.accessToken,
              refresh_token: credentials.refreshToken,
            });
            recoveredSession = {
              session: result.data.session,
              user: result.data.user,
              error: result.error,
            };
          } else if ("code" in credentials) {
            const result = await client.auth.exchangeCodeForSession(
              credentials.code,
            );
            recoveredSession = {
              session: result.data.session,
              user: result.data.user,
              error: result.error,
            };
          } else {
            const result = await client.auth.verifyOtp({
              token_hash: credentials.tokenHash,
              type: "recovery",
            });
            recoveredSession = {
              session: result.data.session,
              user: result.data.user,
              error: result.error,
            };
          }

          if (
            recoveredSession.error ||
            !recoveredSession.session ||
            !recoveredSession.user
          ) {
            return failure(
              "AUTH_REQUEST_FAILED",
              "This password reset link is invalid or has expired. Request a new one.",
            );
          }

          const { data, error } = await client.auth.getUser();
          if (error || data.user?.id !== recoveredSession.user.id) {
            return failure(
              "AUTH_REQUEST_FAILED",
              "This password reset link is invalid or has expired. Request a new one.",
            );
          }

          await supabaseStorage.setItem(
            PASSWORD_RECOVERY_MARKER_KEY,
            JSON.stringify({
              userId: data.user.id,
              expiresAt: Date.now() + PASSWORD_RECOVERY_MARKER_TTL_MS,
            }),
          );
          return { success: true, data: null };
        } catch (error) {
          const diagnostic = sanitizeAuthDiagnostic(error);
          return failure(
            "AUTH_REQUEST_FAILED",
            "This password reset link is invalid or has expired. Request a new one.",
            diagnostic.diagnosticCode,
            diagnostic.httpStatus,
          );
        }
      })();
      passwordRecoveryVerification = attempt;
      void attempt.finally(() => {
        if (passwordRecoveryVerification === attempt) {
          passwordRecoveryVerification = undefined;
        }
      });
      return attempt;
    },
    async changePassword(currentPassword, newPassword) {
      const ready = await initialize();
      if (!ready.success) return ready;
      try {
        const { data, error: userError } = await client.auth.getUser();
        if (userError || !data.user?.email) {
          return failure(
            "AUTH_REQUEST_FAILED",
            "Your current account could not be verified. Sign in again and retry.",
          );
        }
        if (!safeUser(data.user)?.hasPassword) {
          return failure(
            "AUTH_REQUEST_FAILED",
            "This account has no password. Use Forgot password? to establish one.",
          );
        }

        const verification = await client.auth.signInWithPassword({
          email: data.user.email,
          password: currentPassword,
        });
        if (verification.error) {
          const diagnostic = sanitizeAuthDiagnostic(verification.error);
          return failure(
            "AUTH_REQUEST_FAILED",
            "Your current password is incorrect.",
            diagnostic.diagnosticCode,
            diagnostic.httpStatus,
          );
        }
        const updated = await client.auth.updateUser({ password: newPassword });
        if (updated.error) {
          const diagnostic = sanitizeAuthDiagnostic(updated.error);
          return failure(
            "AUTH_REQUEST_FAILED",
            "Supabase could not update your password.",
            diagnostic.diagnosticCode,
            diagnostic.httpStatus,
          );
        }
        return { success: true, data: null };
      } catch (error) {
        const diagnostic = sanitizeAuthDiagnostic(error);
        return failure(
          "AUTH_REQUEST_FAILED",
          "Supabase could not update your password.",
          diagnostic.diagnosticCode,
          diagnostic.httpStatus,
        );
      }
    },
    async resetPassword(newPassword) {
      const ready = await initialize();
      if (!ready.success) return ready;
      try {
        if (!(await currentRecoveryUserId())) {
          return failure(
            "AUTH_REQUEST_FAILED",
            "This password reset link is invalid or has expired. Request a new one.",
          );
        }
        const update = await client.auth.updateUser({ password: newPassword });
        if (update.error) {
          const diagnostic = sanitizeAuthDiagnostic(update.error);
          return failure(
            "AUTH_REQUEST_FAILED",
            "Supabase could not update your password.",
            diagnostic.diagnosticCode,
            diagnostic.httpStatus,
          );
        }
        const { error } = await client.auth.signOut({ scope: "local" });
        if (error) {
          return failure(
            "AUTH_REQUEST_FAILED",
            "The recovery session could not be cleared. Close this page and sign in again.",
          );
        }
        await clearPasswordRecoveryMarker();
        return { success: true, data: null };
      } catch (error) {
        const diagnostic = sanitizeAuthDiagnostic(error);
        return failure(
          "AUTH_REQUEST_FAILED",
          "Supabase could not update your password.",
          diagnostic.diagnosticCode,
          diagnostic.httpStatus,
        );
      }
    },
    async signOut() {
      const ready = await initialize();
      if (!ready.success) return ready;

      try {
        const { error } = await client.auth.signOut({ scope: "local" });
        if (error) {
          return failure(
            "AUTH_REQUEST_FAILED",
            "Supabase could not complete sign out.",
          );
        }
        await clearPasswordRecoveryMarker();
        return { success: true, data: null };
      } catch {
        return failure(
          "AUTH_REQUEST_FAILED",
          "Supabase could not complete sign out.",
        );
      }
    },
    getAccessToken,
  };
}

let backgroundAuth: BackgroundAuth | undefined;

export function getBackgroundAuth(): BackgroundAuth {
  backgroundAuth ??= createBackgroundAuth(
    {
      url: import.meta.env.VITE_SUPABASE_URL,
      publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    },
    chrome.storage.local,
    chrome.identity,
  );
  return backgroundAuth;
}

export async function handleAuthRuntimeMessage(
  auth: BackgroundAuth,
  request: AuthRuntimeRequest,
  dashboardUrl = "",
): Promise<AuthRuntimeResponse> {
  switch (request.type) {
    case "AUTH_GET_STATUS":
      return { type: request.type, result: await auth.getStatus() };
    case "AUTH_SIGN_UP":
      return {
        type: request.type,
        result: await auth.signUp(request.email, request.password),
      };
    case "AUTH_SIGN_IN":
      return {
        type: request.type,
        result: await auth.signIn(request.email, request.password),
      };
    case "AUTH_SIGN_IN_WITH_GOOGLE":
      return {
        type: request.type,
        result: await auth.signInWithGoogle(),
      };
    case "AUTH_SEND_PASSWORD_RECOVERY":
      return {
        type: request.type,
        result: await auth.sendPasswordRecovery(
          request.email,
          `${dashboardUrl}?flow=recovery`,
        ),
      };
    case "AUTH_VERIFY_PASSWORD_RECOVERY":
      return {
        type: request.type,
        result: await auth.verifyPasswordRecovery(request.credentials),
      };
    case "AUTH_CHANGE_PASSWORD":
      return {
        type: request.type,
        result: await auth.changePassword(
          request.currentPassword,
          request.newPassword,
        ),
      };
    case "AUTH_RESET_PASSWORD":
      return {
        type: request.type,
        result: await auth.resetPassword(request.newPassword),
      };
    case "AUTH_SIGN_OUT":
      return { type: request.type, result: await auth.signOut() };
  }
}

export function dispatchAuthRuntimeMessage(
  auth: BackgroundAuth,
  message: unknown,
  sender: unknown,
  extensionId: string,
  dashboardUrl: string,
  sendResponse: (response: AuthRuntimeResponse) => void,
): boolean {
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    typeof message.type !== "string" ||
    !message.type.startsWith("AUTH_")
  ) {
    return false;
  }

  if (
    !isTrustedDashboardAuthSender(
      sender,
      extensionId,
      dashboardUrl,
      message.type === "AUTH_VERIFY_PASSWORD_RECOVERY" ||
        message.type === "AUTH_RESET_PASSWORD",
    )
  ) {
    sendResponse(
      authRuntimeFailure(
        "AUTH_REQUEST_FAILED",
        "This authentication request is not allowed.",
      ),
    );
    return true;
  }
  if (!isAuthRuntimeRequest(message)) {
    sendResponse(
      authRuntimeFailure(
        "AUTH_REQUEST_FAILED",
        "The authentication request is invalid.",
      ),
    );
    return true;
  }
  void handleAuthRuntimeMessage(auth, message, dashboardUrl).then(sendResponse);
  return true;
}

export function isTrustedDashboardAuthSender(
  sender: unknown,
  extensionId: string,
  dashboardUrl: string,
  requireRecoveryRoute = false,
): boolean {
  if (
    typeof sender !== "object" ||
    sender === null ||
    !("id" in sender) ||
    sender.id !== extensionId ||
    !("url" in sender) ||
    typeof sender.url !== "string"
  ) {
    return false;
  }
  try {
    const senderUrl = new URL(sender.url);
    const expectedUrl = new URL(dashboardUrl);
    return (
      senderUrl.origin === expectedUrl.origin &&
      senderUrl.pathname === expectedUrl.pathname &&
      (requireRecoveryRoute
        ? senderUrl.search === "?flow=recovery"
        : senderUrl.search === "" || senderUrl.search === "?flow=recovery")
    );
  } catch {
    return false;
  }
}

export function isAuthRuntimeRequest(
  value: unknown,
): value is AuthRuntimeRequest {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const request = value as Record<string, unknown>;
  switch (request.type) {
    case "AUTH_GET_STATUS":
    case "AUTH_SIGN_OUT":
      return true;
    case "AUTH_SIGN_UP":
    case "AUTH_SIGN_IN":
      return (
        typeof request.email === "string" &&
        typeof request.password === "string"
      );
    case "AUTH_SIGN_IN_WITH_GOOGLE":
      return true;
    case "AUTH_SEND_PASSWORD_RECOVERY":
      return typeof request.email === "string";
    case "AUTH_VERIFY_PASSWORD_RECOVERY":
      return isRecoveryCredentials(request.credentials);
    case "AUTH_CHANGE_PASSWORD":
      return (
        typeof request.currentPassword === "string" &&
        typeof request.newPassword === "string"
      );
    case "AUTH_RESET_PASSWORD":
      return typeof request.newPassword === "string";
    default:
      return false;
  }
}

function isRecoveryCredentials(value: unknown): value is RecoveryCredentials {
  if (!isRecord(value)) return false;
  if ("accessToken" in value) {
    return (
      typeof value.accessToken === "string" &&
      value.accessToken.length > 0 &&
      value.accessToken.length <= 8192 &&
      typeof value.refreshToken === "string" &&
      value.refreshToken.length > 0 &&
      value.refreshToken.length <= 8192
    );
  }
  if ("code" in value) {
    return (
      typeof value.code === "string" &&
      value.code.length > 0 &&
      value.code.length <= 4096
    );
  }
  return (
    "tokenHash" in value &&
    typeof value.tokenHash === "string" &&
    value.tokenHash.length > 0 &&
    value.tokenHash.length <= 4096
  );
}

export function authRuntimeFailure(
  code: AuthFailure["code"],
  message: string,
): AuthRuntimeResponse {
  return { type: "AUTH_ERROR", result: failure(code, message) };
}
