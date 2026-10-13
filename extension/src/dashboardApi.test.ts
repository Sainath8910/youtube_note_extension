import { describe, expect, it } from "vitest";
import { isDashboardRequestCurrent } from "./dashboardApi";

describe("protected dashboard request guard", () => {
  it("accepts only the active request version", () => {
    expect(isDashboardRequestCurrent(true, 3, 3)).toBe(true);
    expect(isDashboardRequestCurrent(false, 3, 3)).toBe(false);
    expect(isDashboardRequestCurrent(true, 3, 4)).toBe(false);
  });
});
