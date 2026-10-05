import React from "react"
import {
  createRoot,
  type Root,
} from "react-dom/client"
import Sidebar, {
  type VideoAnalysis,
  type TranscriptStatus,
  type VideoNote,
} from "./Sidebar"


interface VideoContext {
  video: {
    youtube_id: string
    title: string
    transcript_status: TranscriptStatus
    analysis_status: "NOT_STARTED" | "ANALYZING" | "READY" | "FAILED"
    analysis: VideoAnalysis | null
  } | null
  notes: VideoNote[]
}

type VideoContextStatus = "loading" | "loaded" | "error"

let sidebarRoot: Root | null = null
let lastVideoId: string | null = null
let videoContextRequestVersion = 0

function getYouTubeVideoId(): string | null {
  const url = new URL(window.location.href)

  if (url.pathname !== "/watch") {
    return null
  }

  return url.searchParams.get("v")
}

/**
 * Extract channel metadata from the current YouTube page.
 */

/**
 * Extract basic metadata from the currently open
 * YouTube page.
 */


function renderSidebar(
  data: VideoContext,
  detectedVideoId: string,
  contextStatus: VideoContextStatus,
) {
  let container =
    window.document.getElementById(
      "youtube-knowledge-root",
    )

  if (!container) {
    container =
      window.document.createElement(
        "div",
      )

    container.id =
      "youtube-knowledge-root"

    window.document.body.appendChild(
      container,
    )
  }

  if (!sidebarRoot) {
    sidebarRoot =
      createRoot(container)
  }

  sidebarRoot.render(
    <React.StrictMode>
      <Sidebar
        key={detectedVideoId}
        videoId={detectedVideoId}
        videoTitle={
          data.video?.youtube_id === detectedVideoId
            ? data.video.title
            : ""
        }
        notes={
          contextStatus === "loaded" &&
          data.video?.youtube_id === detectedVideoId
            ? data.notes
            : []
        }
        contextStatus={contextStatus}
        transcriptStatus={
          contextStatus === "loaded" &&
          data.video?.youtube_id === detectedVideoId
            ? data.video.transcript_status
            : null
        }
        analysisStatus={
          contextStatus === "loaded" &&
          data.video?.youtube_id === detectedVideoId
            ? data.video.analysis_status
            : null
        }
        persistedAnalysis={
          contextStatus === "loaded" &&
          data.video?.youtube_id === detectedVideoId
            ? data.video.analysis
            : null
        }
      />
    </React.StrictMode>,
  )
}

function fetchVideoContext(
  videoId: string,
) {
  const requestVersion = ++videoContextRequestVersion

  renderSidebar(
    {
      video: null,
      notes: [],
    },
    videoId,
    "loading",
  )

  chrome.runtime.sendMessage(
    {
      type: "GET_VIDEO_CONTEXT",
      videoId,
    },
    (response) => {
      if (
        requestVersion !== videoContextRequestVersion ||
        getYouTubeVideoId() !== videoId
      ) {
        return
      }

      if (
        chrome.runtime.lastError
      ) {
        console.error(
          "[YouTube Knowledge] Extension messaging error:",
          chrome.runtime.lastError
            .message,
        )

        renderSidebar(
          {
            video: null,
            notes: [],
          },
          videoId,
          "error",
        )

        return
      }

      if (!response?.success) {
        console.error(
          "[YouTube Knowledge] Failed to fetch video context:",
          response?.error,
        )

        renderSidebar(
          {
            video: null,
            notes: [],
          },
          videoId,
          "error",
        )

        return
      }

      renderSidebar(
        response.data,
        videoId,
        "loaded",
      )
    },
  )
}

function checkForVideoChange() {
  const videoId =
    getYouTubeVideoId()

  if (!videoId) {
    if (lastVideoId !== null) {
      lastVideoId = null
      videoContextRequestVersion += 1
    }

    return
  }

  if (
    videoId === lastVideoId
  ) {
    return
  }

  lastVideoId = videoId

  console.log(
    "[YouTube Knowledge] New YouTube video:",
    videoId,
  )

  /*
   * YouTube is a SPA and some metadata elements
   * may appear shortly after the URL changes.
   *
   * Perform an immediate extraction.
   */
    /*
  * Only fetch existing knowledge for this video.
  *
  * Opening a YouTube video must not automatically
  * create or persist a Video record.
  */
  fetchVideoContext(
    videoId,
  )
}

function initialize() {
  checkForVideoChange()

  /*
   * YouTube is a SPA.
   *
   * The URL can change without the
   * page/content script being reloaded.
   *
   * A lightweight interval makes sure
   * we detect the new video.
   */
  window.setInterval(
    checkForVideoChange,
    500,
  )
}

initialize()