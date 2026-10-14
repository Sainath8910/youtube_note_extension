import type { RecoveryCredentials } from "./backgroundAuth";

export interface RecoveryRedirect {
  active: boolean;
  credentials: RecoveryCredentials | null;
  invalid: boolean;
}

export function readPasswordRecoveryRedirect(href: string): RecoveryRedirect {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { active: false, credentials: null, invalid: false };
  }

  const query = url.searchParams;
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const queryType = query.get("type");
  const fragmentType = fragment.get("type");
  const active =
    query.get("flow") === "recovery" ||
    queryType === "recovery" ||
    fragmentType === "recovery";
  if (!active) return { active: false, credentials: null, invalid: false };

  const code = query.get("code");
  const tokenHash = query.get("token_hash");
  const accessToken = fragment.get("access_token");
  const refreshToken = fragment.get("refresh_token");
  const credentials: RecoveryCredentials | null = code
    ? { code }
    : tokenHash
      ? { tokenHash }
      : accessToken && refreshToken && fragmentType === "recovery"
        ? { accessToken, refreshToken }
        : null;

  const invalid =
    !credentials ||
    query.has("error") ||
    query.has("error_code") ||
    fragment.has("error") ||
    fragment.has("error_code") ||
    (fragmentType !== null && fragmentType !== "recovery") ||
    (queryType !== null && queryType !== "recovery");

  return {
    active: true,
    credentials: invalid ? null : credentials,
    invalid,
  };
}
