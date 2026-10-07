export interface CapturedVideoScreenshot {
  image: string;
  timestampSeconds: number;
}

interface ScreenshotResponse {
  success: boolean;
  error?: string;
  image?: string;
}

function getWatchVideoId(): string {
  const url = new URL(window.location.href);
  return url.pathname === "/watch" ? (url.searchParams.get("v") ?? "") : "";
}

export function isCurrentVideoPlayerAvailable(expectedVideoId: string): boolean {
  if (!expectedVideoId || getWatchVideoId() !== expectedVideoId) return false;
  const video = window.document.querySelector<HTMLVideoElement>(
    "#movie_player video.html5-main-video",
  );
  if (
    !video ||
    !video.isConnected ||
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    video.videoWidth <= 0 ||
    video.videoHeight <= 0 ||
    !Number.isFinite(video.currentTime) ||
    video.currentTime < 0
  ) {
    return false;
  }
  const bounds = video.getBoundingClientRect();
  return (
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.right > 0 &&
    bounds.bottom > 0 &&
    bounds.left < window.innerWidth &&
    bounds.top < window.innerHeight
  );
}

export async function captureCurrentVideoScreenshot(
  expectedVideoId: string,
): Promise<CapturedVideoScreenshot> {
  if (!expectedVideoId || getWatchVideoId() !== expectedVideoId) {
    throw new Error("The active YouTube video changed. Try capturing again.");
  }

  const video = window.document.querySelector<HTMLVideoElement>(
    "#movie_player video.html5-main-video",
  );
  if (!isCurrentVideoPlayerAvailable(expectedVideoId) || !video) {
    throw new Error("The YouTube player is not ready. Start playback and retry.");
  }

  const bounds = video.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("The YouTube player is not visible. Exit theater or fullscreen mode and retry.");
  }

  const timestampSeconds = Number(video.currentTime.toFixed(2));
  const wasPlaying = !video.paused && !video.ended;
  const sidebar = window.document.getElementById("youtube-knowledge-root");
  const previousVisibility = sidebar?.style.visibility;

  video.pause();
  if (sidebar) sidebar.style.visibility = "hidden";

  try {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      });
    });

    if (getWatchVideoId() !== expectedVideoId || !video.isConnected) {
      throw new Error("The active YouTube video changed. Try capturing again.");
    }

    const response = await new Promise<ScreenshotResponse>((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "CAPTURE_VIDEO_SCREENSHOT",
          videoId: expectedVideoId,
          timestampSeconds,
          bounds: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          },
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
          },
        },
        (result: unknown) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message || "Screenshot capture failed."));
            return;
          }
          if (
            typeof result !== "object" ||
            result === null ||
            !("success" in result) ||
            typeof result.success !== "boolean"
          ) {
            reject(new Error("The screenshot service returned an invalid response."));
            return;
          }
          resolve(result as ScreenshotResponse);
        },
      );
    });

    if (!response.success || typeof response.image !== "string") {
      throw new Error(response.error || "Could not capture the visible video frame.");
    }
    if (!response.image.startsWith("data:image/jpeg;base64,")) {
      throw new Error("The captured frame was not a valid image.");
    }

    return { image: response.image, timestampSeconds };
  } finally {
    if (sidebar && previousVisibility !== undefined) {
      sidebar.style.visibility = previousVisibility;
    }
    if (
      wasPlaying &&
      getWatchVideoId() === expectedVideoId &&
      video.isConnected
    ) {
      void video.play().catch(() => {
        console.warn("[YouTube Knowledge] Could not resume playback after screenshot capture.");
      });
    }
  }
}
