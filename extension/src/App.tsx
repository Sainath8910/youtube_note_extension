import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { AlertCircle, BookOpen, Eye, EyeOff, LoaderCircle, ShieldCheck } from "lucide-react";
import Dashboard from "./Dashboard";
import type { RecoveryCredentials } from "./backgroundAuth";
import { createAuthFlow, isDashboardAccessible } from "./authFlow";
import "./auth.css";

type AuthFormMode = "sign_in" | "sign_up" | "forgot_password";

interface RecoveryRedirect {
  active: boolean;
  credentials: RecoveryCredentials | null;
  invalid: boolean;
}

function readRecoveryRedirect(): RecoveryRedirect {
  const url = new URL(window.location.href);
  if (url.searchParams.get("flow") !== "recovery") {
    return { active: false, credentials: null, invalid: false };
  }

  const query = url.searchParams;
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const code = query.get("code");
  const tokenHash = query.get("token_hash");
  const accessToken = fragment.get("access_token");
  const refreshToken = fragment.get("refresh_token");
  const credentials: RecoveryCredentials | null = code
    ? { code }
    : tokenHash
      ? { tokenHash }
      : accessToken && refreshToken && fragment.get("type") === "recovery"
        ? { accessToken, refreshToken }
        : null;

  return {
    active: true,
    credentials,
    invalid:
      !credentials ||
      query.has("error") ||
      fragment.has("error") ||
      fragment.get("type") !== null && fragment.get("type") !== "recovery",
  };
}

function App() {
  const authFlow = useMemo(() => createAuthFlow(), []);
  const [recovery] = useState(readRecoveryRedirect);
  const authState = useSyncExternalStore(
    authFlow.subscribe,
    authFlow.getSnapshot,
    authFlow.getSnapshot,
  );

  useEffect(() => {
    if (recovery.active) return;
    void authFlow.refreshStatus();
  }, [authFlow, recovery.active]);

  useLayoutEffect(() => {
    if (!recovery.active) return;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?flow=recovery`,
    );
  }, [recovery.active]);

  if (recovery.active) {
    return (
      <PasswordResetForm
        authFlow={authFlow}
        credentials={recovery.credentials}
        invalidLink={recovery.invalid}
      />
    );
  }

  if (isDashboardAccessible(authState)) {
    return (
      <Dashboard
        authenticatedUser={authState.user}
        onSignOut={() => authFlow.signOut()}
        onChangePassword={(currentPassword, newPassword) =>
          authFlow.changePassword(currentPassword, newPassword)
        }
        onSendPasswordRecovery={(email) =>
          authFlow.sendPasswordRecovery(email)
        }
        signingOut={authState.pending === "sign_out"}
        signOutError={authState.message}
      />
    );
  }

  if (authState.status === "checking") {
    return (
      <main className="auth-loading" aria-live="polite">
        <LoaderCircle className="auth-spinner" size={28} aria-hidden="true" />
        <p>Checking your session…</p>
      </main>
    );
  }

  if (authState.status === "status_error") {
    return (
      <main className="auth-loading">
        <section className="auth-status-error" role="alert">
          <AlertCircle size={22} aria-hidden="true" />
          <h1>We couldn't verify your session</h1>
          <p>{authState.message}</p>
          <button
            className="auth-primary-button"
            type="button"
            onClick={() => void authFlow.refreshStatus()}
          >
            Try again
          </button>
        </section>
      </main>
    );
  }

  return <AuthForm authFlow={authFlow} state={authState} />;
}

function AuthForm({
  authFlow,
  state,
}: {
  authFlow: ReturnType<typeof createAuthFlow>;
  state: Extract<ReturnType<typeof authFlow.getSnapshot>, { status: "signed_out" }>;
}) {
  const [mode, setMode] = useState<AuthFormMode>("sign_in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [validationError, setValidationError] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [actionMessageKind, setActionMessageKind] = useState<"error" | "info">("error");
  const pending = state.pending !== null || actionPending;
  const isSignup = mode === "sign_up";

  const switchMode = (nextMode: AuthFormMode) => {
    if (pending) return;
    setMode(nextMode);
    setPassword("");
    setConfirmPassword("");
    setValidationError("");
    setActionMessage("");
    authFlow.clearMessage();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidationError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setValidationError("Enter a valid email address.");
      return;
    }
    if (mode === "forgot_password") {
      setActionPending(true);
      setActionMessage("");
      void authFlow.sendPasswordRecovery(email.trim()).then((result) => {
        setActionPending(false);
        setActionMessageKind(result.success ? "info" : "error");
        setActionMessage(
          result.success
            ? "If an account uses this email, a password reset link has been sent."
            : result.message,
        );
      });
      return;
    }
    if (!password) {
      setValidationError("Enter your password.");
      return;
    }
    if (isSignup) {
      if (password.length < 8) {
        setValidationError("Use a password with at least 8 characters.");
        return;
      }
      if (password !== confirmPassword) {
        setValidationError("Your passwords don't match.");
        return;
      }
      void authFlow.signUp(email.trim(), password);
      return;
    }
    void authFlow.signIn(email.trim(), password);
  };

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand-mark">
          <BookOpen size={24} aria-hidden="true" />
        </div>
        <p className="auth-eyebrow">YOUR LEARNING SPACE</p>
        <h1 id="auth-title">
          {isSignup
            ? "Create your account"
            : mode === "forgot_password"
              ? "Reset your password"
              : "Welcome back"}
        </h1>
        <p className="auth-subtitle">
          {isSignup
            ? "Save what you learn and pick up where you left off."
            : mode === "forgot_password"
              ? "Enter the email address on your account and we'll send a reset link."
              : "Sign in to continue to your YouTube Knowledge workspace."}
        </p>

        {mode !== "forgot_password" && (
          <div className="auth-security-note">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>Your account is securely managed by Supabase.</span>
          </div>
        )}

        {mode !== "forgot_password" && <button
          className="auth-google-button"
          type="button"
          disabled={pending}
          onClick={() => void authFlow.signInWithGoogle()}
        >
          {pending && state.pending === "google_sign_in" ? (
            <>
              <LoaderCircle className="auth-spinner" size={17} aria-hidden="true" />
              Continuing with Google…
            </>
          ) : (
            <>
              <span className="auth-google-mark" aria-hidden="true">G</span>
              Continue with Google
            </>
          )}
        </button>}

        {mode !== "forgot_password" && (
          <div className="auth-divider" aria-hidden="true">
            <span>or continue with email</span>
          </div>
        )}

        {(state.message || actionMessage) && (
          <>
            <p
              className={`auth-message is-${actionMessage ? actionMessageKind : state.messageKind ?? "error"}`}
              role={(actionMessage ? actionMessageKind : state.messageKind) === "info" ? "status" : "alert"}
            >
              {actionMessage || state.message}
            </p>
            {!actionMessage && state.diagnosticCode && state.messageKind !== "info" && (
              <p className="auth-diagnostic" aria-label="Authentication diagnostic">
                Diagnostic: {state.diagnosticCode}
                {state.httpStatus !== undefined && ` (HTTP ${state.httpStatus})`}
              </p>
            )}
          </>
        )}

        <form className="auth-form" onSubmit={submit} noValidate>
          <label className="auth-field">
            <span>Email</span>
            <input
              autoComplete="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>

          {mode !== "forgot_password" && <label className="auth-field">
            <span>Password</span>
            <span className="auth-password-wrap">
              <input
                autoComplete={isSignup ? "new-password" : "current-password"}
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={isSignup ? "At least 8 characters" : "Enter your password"}
                required
                minLength={isSignup ? 8 : undefined}
              />
              <button
                className="auth-password-toggle"
                type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((visible) => !visible)}
              >
                {showPassword ? (
                  <EyeOff size={17} aria-hidden="true" />
                ) : (
                  <Eye size={17} aria-hidden="true" />
                )}
              </button>
            </span>
          </label>}

          {isSignup && (
            <label className="auth-field">
              <span>Confirm password</span>
              <input
                autoComplete="new-password"
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Enter your password again"
                required
              />
            </label>
          )}

          {validationError && (
            <p className="auth-message is-error" role="alert">
              {validationError}
            </p>
          )}

          <button className="auth-primary-button" type="submit" disabled={pending}>
            {pending ? (
              <>
                <LoaderCircle className="auth-spinner" size={17} aria-hidden="true" />
                {mode === "forgot_password"
                  ? "Sending reset link…"
                  : isSignup
                    ? "Creating account…"
                    : "Signing in…"}
              </>
            ) : mode === "forgot_password" ? (
              "Send reset link"
            ) : isSignup ? (
              "Create account"
            ) : (
              "Sign in"
            )}
          </button>
        </form>

        <p className="auth-switch">
          {mode === "forgot_password"
            ? "Remembered your password?"
            : isSignup
              ? "Already have an account?"
              : "New to YouTube Knowledge?"}{" "}
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (mode === "forgot_password") switchMode("sign_in");
              else switchMode(isSignup ? "sign_in" : "sign_up");
            }}
          >
            {mode === "forgot_password"
              ? "Sign in"
              : isSignup
                ? "Sign in"
                : "Create an account"}
          </button>
        </p>
        {mode === "sign_in" && (
          <p className="auth-forgot">
            <button
              type="button"
              disabled={pending}
              onClick={() => switchMode("forgot_password")}
            >
              Forgot password?
            </button>
          </p>
        )}
        <p className="auth-footer">
          Sign-in credentials are sent directly to Supabase and are not stored by this extension.
        </p>
      </section>
    </main>
  );
}

function PasswordResetForm({
  authFlow,
  credentials,
  invalidLink,
}: {
  authFlow: ReturnType<typeof createAuthFlow>;
  credentials: RecoveryCredentials | null;
  invalidLink: boolean;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState(
    invalidLink
      ? "This password reset link is invalid or expired. Request a new link to continue."
      : "",
  );
  const [success, setSuccess] = useState(false);
  const [pending, setPending] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!credentials || invalidLink) return;
    if (password.length < 8) {
      setMessage("Use a password with at least 8 characters.");
      return;
    }
    if (password !== confirmation) {
      setMessage("Your passwords don't match.");
      return;
    }
    setPending(true);
    setMessage("");
    void authFlow.resetPassword(credentials, password).then((result) => {
      setPending(false);
      if (result.success) {
        setSuccess(true);
        setMessage("Your password has been updated. You can now sign in.");
        setPassword("");
        setConfirmation("");
      } else {
        setMessage(result.message);
      }
    });
  };

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand-mark">
          <BookOpen size={24} aria-hidden="true" />
        </div>
        <p className="auth-eyebrow">YOUR LEARNING SPACE</p>
        <h1 id="auth-title">Choose a new password</h1>
        <p className="auth-subtitle">
          Set a new password for your YouTube Knowledge account.
        </p>
        {message && (
          <p
            className={`auth-message is-${success ? "info" : "error"}`}
            role={success ? "status" : "alert"}
          >
            {message}
          </p>
        )}
        {!success && (
          <form className="auth-form" onSubmit={submit}>
            <label className="auth-field">
              <span>New password</span>
              <input
                autoComplete="new-password"
                type="password"
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                disabled={pending || !credentials || invalidLink}
              />
            </label>
            <label className="auth-field">
              <span>Confirm new password</span>
              <input
                autoComplete="new-password"
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                required
                disabled={pending || !credentials || invalidLink}
              />
            </label>
            <button
              className="auth-primary-button"
              type="submit"
              disabled={pending || !credentials || invalidLink}
            >
              {pending ? (
                <>
                  <LoaderCircle className="auth-spinner" size={17} aria-hidden="true" />
                  Updating password…
                </>
              ) : (
                "Update password"
              )}
            </button>
          </form>
        )}
        <p className="auth-switch">
          <a href={`${window.location.pathname}#/dashboard`}>Return to sign in</a>
        </p>
      </section>
    </main>
  );
}

export default App;
