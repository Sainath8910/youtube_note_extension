import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { AlertCircle, BookOpen, Eye, EyeOff, LoaderCircle, ShieldCheck } from "lucide-react";
import Dashboard from "./Dashboard";
import { createAuthFlow, isDashboardAccessible } from "./authFlow";
import "./auth.css";

type AuthFormMode = "sign_in" | "sign_up";

function App() {
  const authFlow = useMemo(() => createAuthFlow(), []);
  const authState = useSyncExternalStore(
    authFlow.subscribe,
    authFlow.getSnapshot,
    authFlow.getSnapshot,
  );

  useEffect(() => {
    void authFlow.refreshStatus();
  }, [authFlow]);

  if (isDashboardAccessible(authState)) {
    return (
      <Dashboard
        authenticatedUser={authState.user}
        onSignOut={() => authFlow.signOut()}
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
  const pending = state.pending !== null;
  const isSignup = mode === "sign_up";

  const switchMode = (nextMode: AuthFormMode) => {
    if (pending) return;
    setMode(nextMode);
    setPassword("");
    setConfirmPassword("");
    setValidationError("");
    authFlow.clearMessage();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidationError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setValidationError("Enter a valid email address.");
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
        <h1 id="auth-title">{isSignup ? "Create your account" : "Welcome back"}</h1>
        <p className="auth-subtitle">
          {isSignup
            ? "Save what you learn and pick up where you left off."
            : "Sign in to continue to your YouTube Knowledge workspace."}
        </p>

        <div className="auth-security-note">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>Your account is securely managed by Supabase.</span>
        </div>

        <button
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
        </button>

        <div className="auth-divider" aria-hidden="true">
          <span>or continue with email</span>
        </div>

        {state.message && (
          <>
            <p
              className={`auth-message is-${state.messageKind ?? "error"}`}
              role={state.messageKind === "info" ? "status" : "alert"}
            >
              {state.message}
            </p>
            {state.diagnosticCode && state.messageKind !== "info" && (
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

          <label className="auth-field">
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
          </label>

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
                {isSignup ? "Creating account…" : "Signing in…"}
              </>
            ) : isSignup ? (
              "Create account"
            ) : (
              "Sign in"
            )}
          </button>
        </form>

        <p className="auth-switch">
          {isSignup ? "Already have an account?" : "New to YouTube Knowledge?"}{" "}
          <button
            type="button"
            disabled={pending}
            onClick={() => switchMode(isSignup ? "sign_in" : "sign_up")}
          >
            {isSignup ? "Sign in" : "Create an account"}
          </button>
        </p>
        <p className="auth-footer">
          Sign-in credentials are sent directly to Supabase and are not stored by this extension.
        </p>
      </section>
    </main>
  );
}

export default App;
