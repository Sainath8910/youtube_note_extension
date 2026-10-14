import { describe, expect, it } from "vitest";
import { readPasswordRecoveryRedirect } from "./authRecovery";

describe("password recovery callback parsing", () => {
  it("recognizes a PKCE recovery code on the configured extension route", () => {
    expect(
      readPasswordRecoveryRedirect(
        "chrome-extension://extension-id/index.html?flow=recovery&code=private-code",
      ),
    ).toEqual({
      active: true,
      credentials: { code: "private-code" },
      invalid: false,
    });
  });

  it("recognizes token-hash callbacks marked as recovery", () => {
    expect(
      readPasswordRecoveryRedirect(
        "chrome-extension://extension-id/index.html?token_hash=private-hash&type=recovery",
      ),
    ).toEqual({
      active: true,
      credentials: { tokenHash: "private-hash" },
      invalid: false,
    });
  });

  it("recognizes implicit recovery tokens only with the recovery type", () => {
    expect(
      readPasswordRecoveryRedirect(
        "chrome-extension://extension-id/index.html#access_token=private-access&refresh_token=private-refresh&type=recovery",
      ),
    ).toEqual({
      active: true,
      credentials: {
        accessToken: "private-access",
        refreshToken: "private-refresh",
      },
      invalid: false,
    });
    expect(
      readPasswordRecoveryRedirect(
        "chrome-extension://extension-id/index.html#access_token=private-access&refresh_token=private-refresh",
      ).active,
    ).toBe(false);
  });

  it("marks expired provider callbacks invalid without surfacing query details", () => {
    const result = readPasswordRecoveryRedirect(
      "chrome-extension://extension-id/index.html?flow=recovery&error=access_denied&error_code=otp_expired&error_description=private",
    );

    expect(result).toEqual({
      active: true,
      credentials: null,
      invalid: true,
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("does not treat unrelated authorization codes as recovery credentials", () => {
    expect(
      readPasswordRecoveryRedirect(
        "chrome-extension://extension-id/index.html?code=unrelated-auth-code",
      ),
    ).toEqual({
      active: false,
      credentials: null,
      invalid: false,
    });
  });
});
