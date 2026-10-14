import { describe, expect, it } from "vitest";
import { isTrustedProfileRequestSender } from "./profileApi";

const extensionId = "extension-id";
const dashboardUrl = `chrome-extension://${extensionId}/index.html`;

describe("isTrustedProfileRequestSender", () => {
  it("allows profile reads and updates from the extension dashboard", () => {
    const sender = {
      id: extensionId,
      url: `${dashboardUrl}#/dashboard`,
    };

    expect(
      isTrustedProfileRequestSender(sender, extensionId, dashboardUrl, "GET"),
    ).toBe(true);
    expect(
      isTrustedProfileRequestSender(sender, extensionId, dashboardUrl, "PATCH"),
    ).toBe(true);
  });

  it("allows read-only profile requests from the YouTube content script", () => {
    const sender = {
      id: extensionId,
      url: "https://www.youtube.com/watch?v=video-id",
      tab: { id: 1 },
    };

    expect(
      isTrustedProfileRequestSender(sender, extensionId, dashboardUrl, "GET"),
    ).toBe(true);
    expect(
      isTrustedProfileRequestSender(sender, extensionId, dashboardUrl, "PATCH"),
    ).toBe(false);
  });

  it("rejects profile requests from untrusted or malformed senders", () => {
    expect(
      isTrustedProfileRequestSender(
        {
          id: extensionId,
          url: "https://www.youtube.com/watch?v=video-id",
        },
        extensionId,
        dashboardUrl,
        "GET",
      ),
    ).toBe(false);
    expect(
      isTrustedProfileRequestSender(
        {
          id: extensionId,
          url: "https://youtube.com.evil.example/watch?v=video-id",
          tab: { id: 1 },
        },
        extensionId,
        dashboardUrl,
        "GET",
      ),
    ).toBe(false);
    expect(
      isTrustedProfileRequestSender(
        {
          id: "another-extension",
          url: `${dashboardUrl}#/dashboard`,
        },
        extensionId,
        dashboardUrl,
        "GET",
      ),
    ).toBe(false);
  });
});
