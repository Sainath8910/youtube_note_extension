import { describe, expect, it } from "vitest";
import {
  isDashboardRequestCurrent,
  matchesDashboardNoteSearch,
} from "./dashboardApi";

describe("protected dashboard request guard", () => {
  it("accepts only the active request version", () => {
    expect(isDashboardRequestCurrent(true, 3, 3)).toBe(true);
    expect(isDashboardRequestCurrent(false, 3, 3)).toBe(false);
    expect(isDashboardRequestCurrent(true, 3, 4)).toBe(false);
  });
});

describe("dashboard note search", () => {
  const note = {
    title: "React hooks",
    folder_path: [
      { id: 1, name: "Frontend" },
      { id: 2, name: "JavaScript" },
    ],
  };

  it("matches note titles but not assigned folder names", () => {
    expect(matchesDashboardNoteSearch(note, "  REACT ")).toBe(true);
    expect(matchesDashboardNoteSearch(note, "JavaScript")).toBe(false);
    expect(matchesDashboardNoteSearch(note, "frontend")).toBe(false);
  });

  it("does not match note content", () => {
    expect(
      matchesDashboardNoteSearch(
        { ...note, title: "Hooks overview" },
        "some note body text",
      ),
    ).toBe(false);
  });

  it("matches every note when the query is blank", () => {
    expect(matchesDashboardNoteSearch(note, "  ")).toBe(true);
  });
});
