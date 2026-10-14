import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertCircle, LoaderCircle, UserRound } from "lucide-react";
import type { SafeAuthUser } from "./backgroundAuth";
import type { AuthActionResult } from "./authFlow";
import {
  getDashboardProfile,
  updateDashboardUsername,
  type DashboardProfile,
} from "./profileApi";
import "./profile.css";

type ProfileLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; profile: DashboardProfile };

export function ProfilePage({
  authenticatedUser,
  onChangePassword,
  onSendPasswordRecovery,
  onUsernameChange,
}: {
  authenticatedUser: SafeAuthUser;
  onUsernameChange: (username: string) => void;
  onChangePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<AuthActionResult>;
  onSendPasswordRecovery: (email: string) => Promise<AuthActionResult>;
}) {
  const [loadState, setLoadState] = useState<ProfileLoadState>({
    status: "loading",
  });
  const [username, setUsername] = useState("");
  const [usernamePending, setUsernamePending] = useState(false);
  const [usernameFeedback, setUsernameFeedback] = useState("");
  const [usernameFeedbackKind, setUsernameFeedbackKind] = useState<
    "error" | "success"
  >("error");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordFeedback, setPasswordFeedback] = useState("");
  const [passwordFeedbackKind, setPasswordFeedbackKind] = useState<
    "error" | "success"
  >("error");

  const loadProfile = useCallback(() => {
    void getDashboardProfile()
      .then((profile) => {
        setUsername(profile.username);
        onUsernameChange(profile.username);
        setLoadState({ status: "ready", profile });
      })
      .catch((error: unknown) => {
        setLoadState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load your profile.",
        });
      });
  }, [onUsernameChange]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const saveUsername = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,30}$/.test(normalized)) {
      setUsernameFeedback("Use 3–30 letters, numbers, or underscores.");
      setUsernameFeedbackKind("error");
      return;
    }
    setUsernamePending(true);
    setUsernameFeedback("");
    void updateDashboardUsername(normalized)
      .then((profile) => {
        setUsername(profile.username);
        onUsernameChange(profile.username);
        setLoadState({ status: "ready", profile });
        setUsernameFeedback("Your username has been saved.");
        setUsernameFeedbackKind("success");
      })
      .catch((error: unknown) => {
        setUsernameFeedback(
          error instanceof Error ? error.message : "Could not save your username.",
        );
        setUsernameFeedbackKind("error");
      })
      .finally(() => setUsernamePending(false));
  };

  const changePassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!currentPassword) {
      setPasswordFeedback("Enter your current password.");
      setPasswordFeedbackKind("error");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordFeedback("Use a new password with at least 8 characters.");
      setPasswordFeedbackKind("error");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordFeedback("Your new passwords don't match.");
      setPasswordFeedbackKind("error");
      return;
    }
    setPasswordPending(true);
    setPasswordFeedback("");
    void onChangePassword(currentPassword, newPassword).then((result) => {
      setPasswordPending(false);
      if (result.success) {
        setPasswordFeedback("Your password has been changed.");
        setPasswordFeedbackKind("success");
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      } else {
        setPasswordFeedback(result.message);
        setPasswordFeedbackKind("error");
      }
    });
  };

  const sendRecoveryEmail = () => {
    const email =
      loadState.status === "ready"
        ? loadState.profile.email
        : authenticatedUser.email ?? "";
    if (!email) {
      setPasswordFeedback("This account does not have an email address.");
      setPasswordFeedbackKind("error");
      return;
    }
    setPasswordPending(true);
    setPasswordFeedback("");
    void onSendPasswordRecovery(email).then((result) => {
      setPasswordPending(false);
      setPasswordFeedback(
        result.success
          ? "If this email is eligible, a password reset link has been sent."
          : result.message,
      );
      setPasswordFeedbackKind(result.success ? "success" : "error");
    });
  };

  return (
    <section className="profile-page">
      <article className="content-card profile-card">
        <header className="profile-card-heading">
          <span className="profile-icon">
            <UserRound size={19} aria-hidden="true" />
          </span>
          <div>
            <h2>Account details</h2>
            <p>Your profile is private and belongs to your signed-in account.</p>
          </div>
        </header>
        {loadState.status === "loading" ? (
          <p className="profile-state" aria-live="polite">
            <LoaderCircle className="auth-spinner" size={17} aria-hidden="true" />
            Loading profile…
          </p>
        ) : loadState.status === "error" ? (
          <div className="profile-state profile-error" role="alert">
            <AlertCircle size={17} aria-hidden="true" />
            <span>{loadState.message}</span>
            <button
              className="workspace-secondary-button"
              type="button"
              onClick={() => {
                setLoadState({ status: "loading" });
                loadProfile();
              }}
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            <div className="profile-readonly-field">
              <span>Email</span>
              <strong>{loadState.profile.email || "No email on this account"}</strong>
            </div>
            <form className="profile-form" onSubmit={saveUsername}>
              <label className="profile-field">
                <span>Username</span>
                <input
                  autoComplete="username"
                  minLength={3}
                  maxLength={30}
                  value={username}
                  onChange={(event) => {
                    setUsername(event.target.value);
                    setUsernameFeedback("");
                  }}
                  placeholder="e.g. learning_notes"
                  required
                />
                <small>3–30 characters: lowercase letters, numbers, and underscores.</small>
              </label>
              {usernameFeedback && (
                <p
                  className={`profile-feedback is-${usernameFeedbackKind}`}
                  role={usernameFeedbackKind === "error" ? "alert" : "status"}
                >
                  {usernameFeedback}
                </p>
              )}
              <button
                className="new-note-button"
                type="submit"
                disabled={usernamePending}
              >
                {usernamePending ? "Saving…" : "Save username"}
              </button>
            </form>
          </>
        )}
      </article>

      <article className="content-card profile-card">
        <header className="profile-card-heading">
          <span className="profile-icon">
            <AlertCircle size={18} aria-hidden="true" />
          </span>
          <div>
            <h2>Change password</h2>
            <p>Password updates are handled securely by Supabase Auth.</p>
          </div>
        </header>
        {authenticatedUser.hasPassword === true ? (
          <form className="profile-form" onSubmit={changePassword}>
            <label className="profile-field">
              <span>Current password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
              />
            </label>
            <label className="profile-field">
              <span>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
            </label>
            <label className="profile-field">
              <span>Confirm new password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />
            </label>
            {passwordFeedback && (
              <p
                className={`profile-feedback is-${passwordFeedbackKind}`}
                role={passwordFeedbackKind === "error" ? "alert" : "status"}
              >
                {passwordFeedback}
              </p>
            )}
            <button
              className="new-note-button"
              type="submit"
              disabled={passwordPending}
            >
              {passwordPending ? "Updating…" : "Change password"}
            </button>
          </form>
        ) : (
          <div className="profile-password-help">
            <p>
              This account uses Google sign-in and has no password to verify.
              Request a reset email to establish a password first.
            </p>
            {passwordFeedback && (
              <p
                className={`profile-feedback is-${passwordFeedbackKind}`}
                role={passwordFeedbackKind === "error" ? "alert" : "status"}
              >
                {passwordFeedback}
              </p>
            )}
            <button
              className="workspace-secondary-button"
              type="button"
              disabled={passwordPending}
              onClick={sendRecoveryEmail}
            >
              {passwordPending ? "Sending…" : "Send password reset email"}
            </button>
          </div>
        )}
      </article>
    </section>
  );
}
