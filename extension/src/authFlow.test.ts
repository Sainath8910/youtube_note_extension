import { describe, expect, it } from "vitest";
import {
  createAuthFlow,
  isDashboardAccessible,
  type AuthMessageSender,
} from "./authFlow";
import type {
  AuthRuntimeRequest,
  AuthRuntimeResponse,
  SafeAuthUser,
} from "./backgroundAuth";

const user: SafeAuthUser = {
  id: "supabase-user-id",
  email: "learner@example.com",
};

function statusResponse(authenticated: boolean): AuthRuntimeResponse {
  return {
    type: "AUTH_GET_STATUS",
    result: {
      success: true,
      data: {
        configured: true,
        authenticated,
        ...(authenticated ? { user } : {}),
      },
    },
  };
}

function mutationResponse(
  type: "AUTH_SIGN_IN" | "AUTH_SIGN_UP" | "AUTH_SIGN_IN_WITH_GOOGLE",
  requiresEmailConfirmation = false,
): AuthRuntimeResponse {
  return {
    type,
    result: {
      success: true,
      data: { user, requiresEmailConfirmation },
    },
  };
}

function failureResponse(
  type:
    | "AUTH_SIGN_IN"
    | "AUTH_SIGN_UP"
    | "AUTH_SIGN_IN_WITH_GOOGLE"
    | "AUTH_SIGN_OUT"
    | "AUTH_GET_STATUS",
): AuthRuntimeResponse {
  return {
    type,
    result: {
      success: false,
      error: {
        code: "AUTH_REQUEST_FAILED",
        message: "safe background failure",
        diagnosticCode: "AUTH_UNKNOWN",
      },
    },
  } as AuthRuntimeResponse;
}

function createSender(
  responses: AuthRuntimeResponse[],
): { send: AuthMessageSender; calls: AuthRuntimeRequest[] } {
  const calls: AuthRuntimeRequest[] = [];
  return {
    calls,
    async send(request) {
      calls.push(request);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected auth request.");
      return response;
    },
  };
}

describe("dashboard authentication flow", () => {
  it("starts signed out when the initial status has no session", async () => {
    const { send, calls } = createSender([statusResponse(false)]);
    const flow = createAuthFlow(send);

    await flow.refreshStatus();

    expect(flow.getSnapshot()).toEqual({ status: "signed_out", pending: null });
    expect(isDashboardAccessible(flow.getSnapshot())).toBe(false);
    expect(calls).toEqual([{ type: "AUTH_GET_STATUS" }]);
  });

  it("opens the dashboard only after a valid initial status", async () => {
    const { send } = createSender([statusResponse(true)]);
    const flow = createAuthFlow(send);

    await flow.refreshStatus();

    expect(flow.getSnapshot()).toEqual({
      status: "signed_in",
      pending: null,
      user,
    });
    expect(isDashboardAccessible(flow.getSnapshot())).toBe(true);
  });

  it("shows a retryable status error and recovers on retry", async () => {
    const { send, calls } = createSender([
      failureResponse("AUTH_GET_STATUS"),
      statusResponse(false),
    ]);
    const flow = createAuthFlow(send);

    await flow.refreshStatus();
    expect(flow.getSnapshot().status).toBe("status_error");
    await flow.refreshStatus();

    expect(flow.getSnapshot()).toEqual({ status: "signed_out", pending: null });
    expect(calls).toHaveLength(2);
  });

  it("signs in and verifies the session before opening the dashboard", async () => {
    const { send, calls } = createSender([
      mutationResponse("AUTH_SIGN_IN"),
      statusResponse(true),
    ]);
    const flow = createAuthFlow(send);

    await flow.signIn("learner@example.com", "password");

    expect(flow.getSnapshot()).toEqual({
      status: "signed_in",
      pending: null,
      user,
    });
    expect(calls.map((request) => request.type)).toEqual([
      "AUTH_SIGN_IN",
      "AUTH_GET_STATUS",
    ]);
  });

  it("completes Google sign-in only after verifying the Supabase session", async () => {
    const { send, calls } = createSender([
      mutationResponse("AUTH_SIGN_IN_WITH_GOOGLE"),
      statusResponse(true),
    ]);
    const flow = createAuthFlow(send);

    await flow.signInWithGoogle();

    expect(flow.getSnapshot()).toEqual({
      status: "signed_in",
      pending: null,
      user,
    });
    expect(calls.map((request) => request.type)).toEqual([
      "AUTH_SIGN_IN_WITH_GOOGLE",
      "AUTH_GET_STATUS",
    ]);
  });

  it("shows a sanitized cancellation message and permits retry", async () => {
    const { send, calls } = createSender([
      {
        type: "AUTH_SIGN_IN_WITH_GOOGLE",
        result: {
          success: false,
          error: {
            code: "AUTH_REQUEST_FAILED",
            message: "safe background error",
            diagnosticCode: "AUTH_OAUTH_CANCELLED",
          },
        },
      },
      mutationResponse("AUTH_SIGN_IN_WITH_GOOGLE"),
      statusResponse(true),
    ]);
    const flow = createAuthFlow(send);

    await flow.signInWithGoogle();
    expect(flow.getSnapshot()).toMatchObject({
      status: "signed_out",
      pending: null,
      message: "Google sign-in was cancelled.",
      diagnosticCode: "AUTH_OAUTH_CANCELLED",
    });

    await flow.signInWithGoogle();
    expect(flow.getSnapshot().status).toBe("signed_in");
    expect(calls.map((request) => request.type)).toEqual([
      "AUTH_SIGN_IN_WITH_GOOGLE",
      "AUTH_SIGN_IN_WITH_GOOGLE",
      "AUTH_GET_STATUS",
    ]);
  });

  it("prevents duplicate Google sign-in attempts while OAuth is pending", async () => {
    let resolveGoogle!: (response: AuthRuntimeResponse) => void;
    const calls: AuthRuntimeRequest[] = [];
    const send: AuthMessageSender = (request) => {
      calls.push(request);
      if (request.type === "AUTH_SIGN_IN_WITH_GOOGLE") {
        return new Promise((resolve) => {
          resolveGoogle = resolve;
        });
      }
      return Promise.resolve(statusResponse(true));
    };
    const flow = createAuthFlow(send);

    const first = flow.signInWithGoogle();
    const second = flow.signInWithGoogle();
    expect(calls).toHaveLength(1);
    expect(flow.getSnapshot()).toMatchObject({
      status: "signed_out",
      pending: "google_sign_in",
    });
    resolveGoogle(mutationResponse("AUTH_SIGN_IN_WITH_GOOGLE"));
    await Promise.all([first, second]);

    expect(calls.map((request) => request.type)).toEqual([
      "AUTH_SIGN_IN_WITH_GOOGLE",
      "AUTH_GET_STATUS",
    ]);
  });

  it("shows a retryable status error if signin succeeds but status cannot be verified", async () => {
    const { send } = createSender([
      mutationResponse("AUTH_SIGN_IN"),
      failureResponse("AUTH_GET_STATUS"),
      statusResponse(true),
    ]);
    const flow = createAuthFlow(send);

    await flow.signIn("learner@example.com", "password");
    expect(flow.getSnapshot().status).toBe("status_error");
    expect(isDashboardAccessible(flow.getSnapshot())).toBe(false);

    await flow.refreshStatus();
    expect(flow.getSnapshot()).toMatchObject({
      status: "signed_in",
      user,
    });
  });

  it("keeps the user signed out after invalid credentials", async () => {
    const { send } = createSender([failureResponse("AUTH_SIGN_IN")]);
    const flow = createAuthFlow(send);

    await flow.signIn("learner@example.com", "wrong-password");

    expect(flow.getSnapshot()).toMatchObject({
      status: "signed_out",
      pending: null,
      messageKind: "error",
      message: "Sign in failed. Check your email and password, then try again.",
    });
    expect(isDashboardAccessible(flow.getSnapshot())).toBe(false);
  });

  it("shows safe signup diagnostics and never exposes raw service errors", async () => {
      const { send } = createSender([
        {
          type: "AUTH_SIGN_UP",
          result: {
            success: false,
            error: {
              code: "AUTH_REQUEST_FAILED",
              message: "safe background failure",
              diagnosticCode: "AUTH_EMAIL_REGISTERED",
              httpStatus: 400,
              rawMessage: "email=learner@example.com password=secret",
            } as never,
          },
        },
      ]);
      const flow = createAuthFlow(send);

      await flow.signUp("learner@example.com", "password123");

      expect(flow.getSnapshot()).toMatchObject({
        status: "signed_out",
        messageKind: "error",
        message: "An account with this email may already exist. Try signing in instead.",
        diagnosticCode: "AUTH_EMAIL_REGISTERED",
        httpStatus: 400,
      });
      expect(JSON.stringify(flow.getSnapshot())).not.toContain(
        "learner@example.com",
      );
      expect(JSON.stringify(flow.getSnapshot())).not.toContain("password=secret");
  });

  it("uses the generic signup message for unknown or malformed diagnostics", async () => {
      const { send } = createSender([
        {
          type: "AUTH_SIGN_UP",
          result: {
            success: false,
            error: {
              code: "AUTH_REQUEST_FAILED",
              message: "sensitive raw SDK detail",
              diagnosticCode: "sensitive raw SDK detail",
              httpStatus: 999,
            } as never,
          },
        },
      ]);
      const flow = createAuthFlow(send);

      await flow.signUp("learner@example.com", "password123");

      expect(flow.getSnapshot()).toMatchObject({
        status: "signed_out",
        message:
          "We couldn't create your account. Check the details and try again.",
        diagnosticCode: "AUTH_UNKNOWN",
      });
      expect(JSON.stringify(flow.getSnapshot())).not.toContain(
        "sensitive raw SDK detail",
      );
  });

  it("shows specific actionable categories only for recognized diagnostic codes", async () => {
      const { send } = createSender([
        {
          type: "AUTH_SIGN_UP",
          result: {
            success: false,
            error: {
              code: "AUTH_REQUEST_FAILED",
              message: "safe background failure",
              diagnosticCode: "AUTH_PASSWORD_POLICY",
              httpStatus: 422,
            },
          },
        },
      ]);
      const flow = createAuthFlow(send);

      await flow.signUp("learner@example.com", "password123");

      expect(flow.getSnapshot()).toMatchObject({
        message:
          "Choose a password that meets the account's password requirements.",
        diagnosticCode: "AUTH_PASSWORD_POLICY",
        httpStatus: 422,
      });
  });

  it("opens the dashboard after signup only when a session is verified", async () => {
    const { send } = createSender([
      mutationResponse("AUTH_SIGN_UP"),
      statusResponse(true),
    ]);
    const flow = createAuthFlow(send);

    await flow.signUp("learner@example.com", "password123");

    expect(flow.getSnapshot()).toMatchObject({
      status: "signed_in",
      user,
      pending: null,
    });
  });

  it("stays signed out when signup requires email confirmation", async () => {
    const { send, calls } = createSender([
      mutationResponse("AUTH_SIGN_UP", true),
    ]);
    const flow = createAuthFlow(send);

    await flow.signUp("learner@example.com", "password123");

    expect(flow.getSnapshot()).toMatchObject({
      status: "signed_out",
      pending: null,
      messageKind: "info",
      message: "Check your email to confirm your account, then sign in.",
    });
    expect(calls).toHaveLength(1);
    expect(isDashboardAccessible(flow.getSnapshot())).toBe(false);
  });

  it("prevents duplicate signup submissions while a request is pending", async () => {
    let resolveSignup!: (response: AuthRuntimeResponse) => void;
    const calls: AuthRuntimeRequest[] = [];
    const send: AuthMessageSender = (request) => {
      calls.push(request);
      if (request.type === "AUTH_SIGN_UP") {
        return new Promise((resolve) => {
          resolveSignup = resolve;
        });
      }
      return Promise.resolve(statusResponse(true));
    };
    const flow = createAuthFlow(send);

    const first = flow.signUp("learner@example.com", "password123");
    const second = flow.signUp("learner@example.com", "password123");
    expect(calls).toHaveLength(1);
    resolveSignup(mutationResponse("AUTH_SIGN_UP"));
    await Promise.all([first, second]);

    expect(calls).toHaveLength(2);
    expect(calls.map((request) => request.type)).toEqual([
      "AUTH_SIGN_UP",
      "AUTH_GET_STATUS",
    ]);
  });

  it("returns to signed out only after successful logout", async () => {
    const { send } = createSender([
      statusResponse(true),
      { type: "AUTH_SIGN_OUT", result: { success: true, data: null } },
    ]);
    const flow = createAuthFlow(send);
    await flow.refreshStatus();

    await flow.signOut();

    expect(flow.getSnapshot()).toEqual({ status: "signed_out", pending: null });
    expect(isDashboardAccessible(flow.getSnapshot())).toBe(false);
  });

  it("keeps the dashboard available when logout fails", async () => {
    const { send } = createSender([
      statusResponse(true),
      failureResponse("AUTH_SIGN_OUT"),
    ]);
    const flow = createAuthFlow(send);
    await flow.refreshStatus();

    await flow.signOut();

    expect(flow.getSnapshot()).toMatchObject({
      status: "signed_in",
      pending: null,
      user,
      message: "We couldn't sign you out. Please try again.",
    });
    expect(isDashboardAccessible(flow.getSnapshot())).toBe(true);
  });
});
