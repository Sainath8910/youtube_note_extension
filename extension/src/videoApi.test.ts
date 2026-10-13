import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filterAndSortDashboardVideos,
  hasUsableVideoAnalysis,
  listDashboardVideos,
  matchesVideoSearch,
  toVideoAvailability,
  type LibraryVideo,
} from "./videoApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

function video(
  overrides: Partial<LibraryVideo> & Pick<LibraryVideo, "youtube_id">,
): LibraryVideo {
  return {
    id: 1,
    title: "Alpha",
    channel_name: "Channel A",
    thumbnail_url: "",
    youtube_url: `https://www.youtube.com/watch?v=${overrides.youtube_id}`,
    notes_count: 0,
    transcript_availability: "missing",
    analysis_availability: "missing",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("video library filtering and sorting", () => {
  const videos = [
    video({
      youtube_id: "abcdefghijk",
      id: 1,
      title: "Zebra",
      channel_name: "Learning",
      notes_count: 5,
      transcript_availability: "available",
      analysis_availability: "missing",
      created_at: "2026-02-01T00:00:00Z",
      updated_at: "2026-02-04T00:00:00Z",
    }),
    video({
      youtube_id: "zyxwvutsrqp",
      id: 2,
      title: "Alpha",
      channel_name: "Example Studio",
      notes_count: 2,
      transcript_availability: "failed",
      analysis_availability: "available",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-05T00:00:00Z",
    }),
    video({
      youtube_id: "mnopqrstuvw",
      id: 3,
      title: "Bravo",
      channel_name: "Learning",
      notes_count: 9,
      transcript_availability: "available",
      analysis_availability: "available",
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-02-03T00:00:00Z",
    }),
  ];

  it("searches titles and channel names case-insensitively", () => {
    expect(matchesVideoSearch(videos[0], "zEb")).toBe(true);
    expect(matchesVideoSearch(videos[0], "LEARNING")).toBe(true);
    expect(matchesVideoSearch(videos[1], "unmatched")).toBe(false);
  });

  describe("video library API pagination", () => {
    it("requests a page and validates the paginated API response", async () => {
      const result = video({
        youtube_id: "abcdefghijk",
        title: "Recent video",
      });
      const sendMessage = vi.fn(
        (
          _message: unknown,
          callback: (response: unknown) => void,
        ) => {
          callback({
            success: true,
            data: {
              count: 25,
              next: "http://localhost:8000/api/videos/?page=2",
              previous: null,
              results: [result],
            },
          });
        },
      );
      vi.stubGlobal("chrome", {
        runtime: {
          id: "test-extension",
          lastError: null,
          sendMessage,
        },
      });

      const page = await listDashboardVideos({
        page: 1,
        pageSize: 5,
        sort: "updated",
      });

      expect(page).toEqual({
        count: 25,
        next: "http://localhost:8000/api/videos/?page=2",
        previous: null,
        results: [result],
      });
      expect(sendMessage).toHaveBeenCalledWith(
        {
          type: "LIST_VIDEOS",
          page: 1,
          pageSize: 5,
          sort: "updated",
        },
        expect.any(Function),
      );
    });

    it("deduplicates concurrent requests for the same page", async () => {
      const sendMessage = vi.fn(
        (
          _message: unknown,
          callback: (response: unknown) => void,
        ) => {
          callback({
            success: true,
            data: {
              count: 0,
              next: null,
              previous: null,
              results: [],
            },
          });
        },
      );
      vi.stubGlobal("chrome", {
        runtime: {
          id: "test-extension",
          lastError: null,
          sendMessage,
        },
      });

      const firstRequest = listDashboardVideos({ page: 1, pageSize: 5 });
      const duplicateRequest = listDashboardVideos({
        page: 1,
        pageSize: 5,
        sort: "updated",
      });

      expect(duplicateRequest).toBe(firstRequest);
      await firstRequest;
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  it("combines transcript and analysis filters independently", () => {
    expect(
      filterAndSortDashboardVideos(
        videos,
        "",
        "available",
        "available",
        "title",
      ).map((item) => item.title),
    ).toEqual(["Bravo"]);
    expect(
      filterAndSortDashboardVideos(
        videos,
        "",
        "available",
        "all",
        "title",
      ).map((item) => item.title),
    ).toEqual(["Bravo", "Zebra"]);
  });

  it("sorts by title, note count, added date, and updated date", () => {
    expect(
      filterAndSortDashboardVideos(videos, "", "all", "all", "title").map(
        (item) => item.title,
      ),
    ).toEqual(["Alpha", "Bravo", "Zebra"]);
    expect(
      filterAndSortDashboardVideos(videos, "", "all", "all", "notes").map(
        (item) => item.title,
      ),
    ).toEqual(["Bravo", "Zebra", "Alpha"]);
    expect(
      filterAndSortDashboardVideos(videos, "", "all", "all", "added").map(
        (item) => item.title,
      ),
    ).toEqual(["Bravo", "Zebra", "Alpha"]);
    expect(
      filterAndSortDashboardVideos(videos, "", "all", "all", "updated").map(
        (item) => item.title,
      ),
    ).toEqual(["Alpha", "Zebra", "Bravo"]);
  });

  it("maps persisted backend statuses without inventing states", () => {
    expect(toVideoAvailability("READY")).toBe("missing");
    expect(toVideoAvailability("READY", true)).toBe("available");
    expect(toVideoAvailability("FETCHING")).toBe("processing");
    expect(toVideoAvailability("ANALYZING")).toBe("processing");
    expect(toVideoAvailability("FAILED")).toBe("failed");
    expect(toVideoAvailability("NOT_STARTED")).toBe("missing");
    expect(toVideoAvailability("UNKNOWN")).toBe("missing");
  });

  it("requires usable content before marking analysis available", () => {
    expect(hasUsableVideoAnalysis(null)).toBe(false);
    expect(hasUsableVideoAnalysis({ summary: "", topics: [] })).toBe(false);
    expect(
      hasUsableVideoAnalysis({
        detailed_notes: { sections: [{ heading: "Topic", content: "Useful" }] },
      }),
    ).toBe(true);
  });
});
