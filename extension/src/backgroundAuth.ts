import {
  createClient,
  type User,
} from "@supabase/supabase-js";

const ACCESS_TOKEN_REFRESH_MARGIN_SECONDS = 60;
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

export interface SafeAuthUser {
  id: string;
  email: string | null;
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
  | { type: "AUTH_SIGN_OUT" };

export type AuthRuntimeResponse =
  | { type: "AUTH_ERROR"; result: AuthResult<never> }
  | { type: "AUTH_GET_STATUS"; result: AuthResult<AuthStatus> }
  | { type: "AUTH_SIGN_UP"; result: AuthResult<SafeAuthMutation> }
  | { type: "AUTH_SIGN_IN"; result: AuthResult<SafeAuthMutation> }
  | { type: "AUTH_SIGN_OUT"; result: AuthResult<null> };

export interface BackgroundAuth {
  initialize(): Promise<AuthResult<null>>;
  getStatus(): Promise<AuthResult<AuthStatus>>;
  signUp(email: string, password: string): Promise<AuthResult<SafeAuthMutation>>;
  signIn(email: string, password: string): Promise<AuthResult<SafeAuthMutation>>;
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
  return { id: user.id, email: user.email ?? null };
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

  const client = createClient(config.url, config.publishableKey, {
    auth: {
      storage: createChromeStorageAdapter(storageArea),
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  let initialization: Promise<AuthResult<null>> | undefined;

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
  );
  return backgroundAuth;
}

export async function handleAuthRuntimeMessage(
  auth: BackgroundAuth,
  request: AuthRuntimeRequest,
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

  if (!isTrustedDashboardAuthSender(sender, extensionId, dashboardUrl)) {
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
  void handleAuthRuntimeMessage(auth, message).then(sendResponse);
  return true;
}

export function isTrustedDashboardAuthSender(
  sender: unknown,
  extensionId: string,
  dashboardUrl: string,
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
      senderUrl.search === ""
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
    default:
      return false;
  }
}

export function authRuntimeFailure(
  code: AuthFailure["code"],
  message: string,
): AuthRuntimeResponse {
  return { type: "AUTH_ERROR", result: failure(code, message) };
}
