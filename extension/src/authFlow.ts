import type {
  AuthDiagnosticCode,
  AuthRuntimeRequest,
  AuthRuntimeResponse,
  AuthStatus,
  AuthFailure,
  RecoveryCredentials,
  SafeAuthUser,
} from "./backgroundAuth";

export type AuthOperation =
  | "sign_in"
  | "sign_up"
  | "google_sign_in"
  | "sign_out"
  | null;

export type AuthFlowState =
  | { status: "checking"; pending: AuthOperation }
  | {
      status: "signed_out";
      pending: AuthOperation;
      message?: string;
      messageKind?: "error" | "info";
      diagnosticCode?: AuthDiagnosticCode;
      httpStatus?: number;
    }
  | {
      status: "signed_in";
      pending: AuthOperation;
      user: SafeAuthUser;
      message?: string;
    }
  | { status: "status_error"; pending: null; message: string };

export type AuthMessageSender = (
  request: AuthRuntimeRequest,
) => Promise<AuthRuntimeResponse>;

export type AuthActionResult =
  | { success: true }
  | { success: false; message: string };

export interface AuthFlow {
  getSnapshot(): AuthFlowState;
  subscribe(listener: () => void): () => void;
  clearMessage(): void;
  refreshStatus(): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<void>;
  signInWithGoogle(): Promise<void>;
  signOut(): Promise<void>;
  sendPasswordRecovery(email: string): Promise<AuthActionResult>;
  verifyPasswordRecovery(
    credentials: RecoveryCredentials,
  ): Promise<AuthActionResult>;
  changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<AuthActionResult>;
  resetPassword(newPassword: string): Promise<AuthActionResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeUser(value: unknown): value is SafeAuthUser {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (typeof value.email === "string" || value.email === null)
  );
}

function isAuthFailure(value: unknown): value is AuthFailure {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

const AUTH_DIAGNOSTIC_CODES: readonly AuthDiagnosticCode[] = [
  "AUTH_INVALID_CREDENTIALS",
  "AUTH_PASSWORD_POLICY",
  "AUTH_EMAIL_REGISTERED",
  "AUTH_RATE_LIMITED",
  "AUTH_NETWORK_ERROR",
  "AUTH_SERVER_ERROR",
  "AUTH_OAUTH_CANCELLED",
  "AUTH_OAUTH_FAILED",
  "AUTH_NOT_CONFIGURED",
  "AUTH_UNSUPPORTED_BROWSER",
  "AUTH_STORAGE_UNAVAILABLE",
  "AUTH_UNKNOWN",
];

function safeDiagnostic(error: AuthFailure): {
  diagnosticCode: AuthDiagnosticCode;
  httpStatus?: number;
} {
  const diagnosticCode = AUTH_DIAGNOSTIC_CODES.includes(
    error.diagnosticCode,
  )
    ? error.diagnosticCode
    : "AUTH_UNKNOWN";
  const httpStatus =
    typeof error.httpStatus === "number" &&
    Number.isInteger(error.httpStatus) &&
    error.httpStatus >= 100 &&
    error.httpStatus <= 599
      ? error.httpStatus
      : undefined;
  return {
    diagnosticCode,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

function failureMessage(
  operation: "sign_in" | "sign_up",
  diagnosticCode: AuthDiagnosticCode,
): string {
  switch (diagnosticCode) {
    case "AUTH_INVALID_CREDENTIALS":
      return "The email or password is incorrect. Check them and try again.";
    case "AUTH_PASSWORD_POLICY":
      return "Choose a password that meets the account's password requirements.";
    case "AUTH_EMAIL_REGISTERED":
      return "An account with this email may already exist. Try signing in instead.";
    case "AUTH_RATE_LIMITED":
      return "Too many attempts. Wait a while, then try again.";
    case "AUTH_NETWORK_ERROR":
      return "Check your internet connection, then try again.";
    case "AUTH_SERVER_ERROR":
      return "The authentication service is temporarily unavailable. Try again later.";
    case "AUTH_OAUTH_CANCELLED":
      return "Google sign-in was cancelled.";
    case "AUTH_OAUTH_FAILED":
      return "Google sign-in could not be completed. Check your connection and try again.";
    case "AUTH_NOT_CONFIGURED":
      return "Authentication is not configured. Contact your extension administrator.";
    case "AUTH_UNSUPPORTED_BROWSER":
      return "Secure authentication storage is unavailable. Update Chrome and try again.";
    case "AUTH_STORAGE_UNAVAILABLE":
      return "The saved authentication session could not be accessed. Restart the extension and try again.";
    case "AUTH_UNKNOWN":
      return operation === "sign_up"
        ? "We couldn't create your account. Check the details and try again."
        : "Sign in failed. Check your email and password, then try again.";
  }
}

function responseResult(
  response: AuthRuntimeResponse,
): { success: true; data: unknown } | { success: false; error: AuthFailure } {
  if (!isRecord(response) || !("result" in response) || !isRecord(response.result)) {
    throw new Error("The authentication service returned an invalid response.");
  }
  const result = response.result;
  if (result.success === true && "data" in result) {
    return { success: true, data: result.data };
  }
  if (result.success === false && isAuthFailure(result.error)) {
    return { success: false, error: result.error };
  }
  throw new Error("The authentication service returned an invalid response.");
}

function parseAuthStatus(value: unknown): AuthStatus {
  if (
    !isRecord(value) ||
    typeof value.configured !== "boolean" ||
    typeof value.authenticated !== "boolean" ||
    (value.user !== undefined && !isSafeUser(value.user))
  ) {
    throw new Error("The authentication service returned an invalid status.");
  }
  return {
    configured: value.configured,
    authenticated: value.authenticated,
    ...(isSafeUser(value.user) ? { user: value.user } : {}),
  };
}

export function sendAuthRuntimeMessage(
  request: AuthRuntimeRequest,
): Promise<AuthRuntimeResponse> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) {
      reject(new Error("Open this page from the YouTube Knowledge extension."));
      return;
    }

    try {
      chrome.runtime.sendMessage(request, (response: unknown) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error("Could not reach the authentication service."));
          return;
        }
        if (
          !isRecord(response) ||
          typeof response.type !== "string" ||
          response.type !== request.type &&
            response.type !== "AUTH_ERROR"
        ) {
          reject(new Error("The authentication service returned an invalid response."));
          return;
        }
        resolve(response as AuthRuntimeResponse);
      });
    } catch {
      reject(new Error("Could not reach the authentication service."));
    }
  });
}

async function runAuthAction(
  send: AuthMessageSender,
  request: AuthRuntimeRequest,
): Promise<AuthActionResult> {
  try {
    const response = await send(request);
    if (response.type !== request.type && response.type !== "AUTH_ERROR") {
      return {
        success: false,
        message: "The authentication service returned an invalid response.",
      };
    }
    if (!("result" in response)) {
      return {
        success: false,
        message: "The authentication service returned an invalid response.",
      };
    }
    return response.result.success
      ? { success: true }
      : { success: false, message: response.result.error.message };
  } catch {
    return {
      success: false,
      message: "Could not reach the authentication service. Please try again.",
    };
  }
}

export function isDashboardAccessible(
  state: AuthFlowState,
): state is Extract<AuthFlowState, { status: "signed_in" }> {
  return state.status === "signed_in";
}

export function createAuthFlow(send: AuthMessageSender = sendAuthRuntimeMessage): AuthFlow {
  let state: AuthFlowState = { status: "checking", pending: null };
  let operationInProgress = false;
  let version = 0;
  const listeners = new Set<() => void>();

  const publish = (nextState: AuthFlowState) => {
    state = nextState;
    listeners.forEach((listener) => listener());
  };

  const readStatus = async (): Promise<AuthStatus> => {
    const response = await send({ type: "AUTH_GET_STATUS" });
    if (response.type !== "AUTH_GET_STATUS") {
      throw new Error("The authentication service returned an invalid status.");
    }
    const result = responseResult(response);
    if (!result.success) {
      throw new Error("Could not verify your account status. Please try again.");
    }
    return parseAuthStatus(result.data);
  };

  const applyStatus = (status: AuthStatus): void => {
    if (status.configured && status.authenticated && status.user) {
      publish({ status: "signed_in", pending: null, user: status.user });
    } else {
      publish({ status: "signed_out", pending: null });
    }
  };

  const flow: AuthFlow = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearMessage() {
      if (state.status === "signed_out") {
        publish({ status: "signed_out", pending: state.pending });
      } else if (state.status === "signed_in") {
        publish({
          status: "signed_in",
          pending: state.pending,
          user: state.user,
        });
      }
    },
    async refreshStatus() {
      const attempt = ++version;
      publish({ status: "checking", pending: null });
      try {
        const status = await readStatus();
        if (version === attempt) applyStatus(status);
      } catch {
        if (version === attempt) {
          publish({
            status: "status_error",
            pending: null,
            message: "We couldn't verify your session. Check your connection and retry.",
          });
        }
      }
    },
    async signIn(email, password) {
      if (operationInProgress) return;
      operationInProgress = true;
      const attempt = ++version;
      publish({ status: "signed_out", pending: "sign_in" });
      try {
        let result: ReturnType<typeof responseResult>;
        try {
          const response = await send({
            type: "AUTH_SIGN_IN",
            email,
            password,
          });
          if (response.type !== "AUTH_SIGN_IN") {
            throw new Error("Invalid authentication response.");
          }
          result = responseResult(response);
        } catch {
          if (version === attempt) {
            publish({
              status: "signed_out",
              pending: "sign_in",
              message: "We couldn't reach the authentication service. Please try again.",
              messageKind: "error",
            });
          }
          return;
        }
        if (!result.success) {
          if (version === attempt) {
            const diagnostic = safeDiagnostic(result.error);
            publish({
              status: "signed_out",
              pending: "sign_in",
              message: failureMessage("sign_in", diagnostic.diagnosticCode),
              messageKind: "error",
              ...diagnostic,
            });
          }
          return;
        }

        let status: AuthStatus;
        try {
          status = await readStatus();
        } catch {
          if (version === attempt) {
            publish({
              status: "status_error",
              pending: null,
              message: "We couldn't verify your session. Check your connection and retry.",
            });
          }
          return;
        }
        if (version === attempt) {
          if (status.configured && status.authenticated && status.user) {
            publish({ status: "signed_in", pending: "sign_in", user: status.user });
          } else {
            publish({
              status: "signed_out",
              pending: "sign_in",
              message: "Your session isn't ready yet. Please try signing in again.",
              messageKind: "error",
            });
          }
        }
      } finally {
        operationInProgress = false;
        if (version === attempt) state = { ...state, pending: null };
        listeners.forEach((listener) => listener());
      }
    },
    async signUp(email, password) {
      if (operationInProgress) return;
      operationInProgress = true;
      const attempt = ++version;
      publish({ status: "signed_out", pending: "sign_up" });
      try {
        let result: ReturnType<typeof responseResult>;
        try {
          const response = await send({
            type: "AUTH_SIGN_UP",
            email,
            password,
          });
          if (response.type !== "AUTH_SIGN_UP") {
            throw new Error("Invalid authentication response.");
          }
          result = responseResult(response);
        } catch {
          if (version === attempt) {
            publish({
              status: "signed_out",
              pending: "sign_up",
              message: "We couldn't reach the authentication service. Please try again.",
              messageKind: "error",
            });
          }
          return;
        }
        if (!result.success) {
          if (version === attempt) {
            const diagnostic = safeDiagnostic(result.error);
            publish({
              status: "signed_out",
              pending: "sign_up",
              message: failureMessage("sign_up", diagnostic.diagnosticCode),
              messageKind: "error",
              ...diagnostic,
            });
          }
          return;
        }
        if (!isRecord(result.data)) {
          if (version === attempt) {
            publish({
              status: "signed_out",
              pending: "sign_up",
              message: "The authentication service returned an invalid response.",
              messageKind: "error",
            });
          }
          return;
        }
        if (result.data.requiresEmailConfirmation === true) {
          if (version === attempt) {
            publish({
              status: "signed_out",
              pending: "sign_up",
              message: "Check your email to confirm your account, then sign in.",
              messageKind: "info",
            });
          }
          return;
        }

        let status: AuthStatus;
        try {
          status = await readStatus();
        } catch {
          if (version === attempt) {
            publish({
              status: "status_error",
              pending: null,
              message: "We couldn't verify your session. Check your connection and retry.",
            });
          }
          return;
        }
        if (version === attempt) {
          if (status.configured && status.authenticated && status.user) {
            publish({ status: "signed_in", pending: "sign_up", user: status.user });
          } else {
            publish({
              status: "signed_out",
              pending: "sign_up",
              message: "Your account was created. You can sign in now.",
              messageKind: "info",
            });
          }
        }
      } finally {
        operationInProgress = false;
        if (version === attempt) state = { ...state, pending: null };
        listeners.forEach((listener) => listener());
      }
    },
    async signInWithGoogle() {
      if (operationInProgress) return;
      operationInProgress = true;
      const attempt = ++version;
      publish({ status: "signed_out", pending: "google_sign_in" });
      try {
        let result: ReturnType<typeof responseResult>;
        try {
          const response = await send({ type: "AUTH_SIGN_IN_WITH_GOOGLE" });
          if (response.type !== "AUTH_SIGN_IN_WITH_GOOGLE") {
            throw new Error("Invalid authentication response.");
          }
          result = responseResult(response);
        } catch {
          if (version === attempt) {
            publish({
              status: "signed_out",
              pending: "google_sign_in",
              message: "We couldn't reach Google sign-in. Please try again.",
              messageKind: "error",
              diagnosticCode: "AUTH_OAUTH_FAILED",
            });
          }
          return;
        }
        if (!result.success) {
          if (version === attempt) {
            const diagnostic = safeDiagnostic(result.error);
            publish({
              status: "signed_out",
              pending: "google_sign_in",
              message: failureMessage(
                "sign_in",
                diagnostic.diagnosticCode,
              ),
              messageKind: "error",
              ...diagnostic,
            });
          }
          return;
        }

        let status: AuthStatus;
        try {
          status = await readStatus();
        } catch {
          if (version === attempt) {
            publish({
              status: "status_error",
              pending: null,
              message: "We couldn't verify your session. Check your connection and retry.",
            });
          }
          return;
        }
        if (version === attempt) {
          if (status.configured && status.authenticated && status.user) {
            publish({
              status: "signed_in",
              pending: "google_sign_in",
              user: status.user,
            });
          } else {
            publish({
              status: "signed_out",
              pending: "google_sign_in",
              message: "Google sign-in didn't create a usable session. Try again.",
              messageKind: "error",
              diagnosticCode: "AUTH_OAUTH_FAILED",
            });
          }
        }
      } finally {
        operationInProgress = false;
        if (version === attempt) state = { ...state, pending: null };
        listeners.forEach((listener) => listener());
      }
    },
    async signOut() {
      if (operationInProgress || state.status !== "signed_in") return;
      operationInProgress = true;
      const attempt = ++version;
      const user = state.user;
      publish({ status: "signed_in", pending: "sign_out", user });
      try {
        const response = await send({ type: "AUTH_SIGN_OUT" });
        if (response.type !== "AUTH_SIGN_OUT") {
          throw new Error("The authentication service returned an invalid response.");
        }
        const result = responseResult(response);
        if (!result.success) {
          publish({
            status: "signed_in",
            pending: "sign_out",
            user,
            message: "We couldn't sign you out. Please try again.",
          });
          return;
        }
        if (version === attempt) publish({ status: "signed_out", pending: "sign_out" });
      } catch {
        if (version === attempt) {
          publish({
            status: "signed_in",
            pending: "sign_out",
            user,
            message: "We couldn't reach the authentication service. Please try again.",
          });
        }
      } finally {
        operationInProgress = false;
        if (version === attempt) state = { ...state, pending: null };
        listeners.forEach((listener) => listener());
      }
    },
    sendPasswordRecovery(email) {
      return runAuthAction(send, {
        type: "AUTH_SEND_PASSWORD_RECOVERY",
        email,
      });
    },
    verifyPasswordRecovery(credentials) {
      return runAuthAction(send, {
        type: "AUTH_VERIFY_PASSWORD_RECOVERY",
        credentials,
      });
    },
    changePassword(currentPassword, newPassword) {
      return runAuthAction(send, {
        type: "AUTH_CHANGE_PASSWORD",
        currentPassword,
        newPassword,
      });
    },
    resetPassword(newPassword) {
      return runAuthAction(send, {
        type: "AUTH_RESET_PASSWORD",
        newPassword,
      });
    },
  };
  return flow;
}
