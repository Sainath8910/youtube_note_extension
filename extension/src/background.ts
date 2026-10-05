chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "ASK_RAG") {
    const question =
      typeof message.question === "string" ? message.question.trim() : "";
    const scope =
      message.scope === "CURRENT_VIDEO" ||
      message.scope === "PERSONAL_KB" ||
      message.scope === "COMBINED"
        ? message.scope
        : null;
    const videoId =
      typeof message.videoId === "string" ? message.videoId.trim() : "";
    const youtubeId = scope === "PERSONAL_KB" ? null : videoId;

    if (!question || !scope || (scope !== "PERSONAL_KB" && !youtubeId)) {
      sendResponse({
        success: false,
        status: 400,
        data: null,
      });
      return;
    }

    fetch("http://localhost:8000/api/knowledge/ask/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Dev-User": "devuser",
      },
      body: JSON.stringify({
        question,
        scope,
        youtube_id: youtubeId,
        folder_id: null,
        top_k: 5,
      }),
    })
      .then(async (response) => {
        let data: unknown = null;
        if (response.ok) {
          try {
            data = await response.json();
          } catch {
            data = null;
          }
        }

        sendResponse({
          success: response.ok,
          status: response.status,
          data,
        });
      })
      .catch(() => {
        sendResponse({
          success: false,
          status: 0,
          data: null,
        });
      });

    return true;
  }

  /*
   * --------------------------------------------------
   * GET VIDEO CONTEXT
   * --------------------------------------------------
   */
  if (message.type === "GET_VIDEO_CONTEXT") {
    const videoId = message.videoId;

    if (!videoId) {
      sendResponse({
        success: false,
        error: "Video ID is missing.",
      });

      return;
    }

    fetch(`http://localhost:8000/api/videos/${videoId}/`, {
      method: "GET",
      headers: {
        "X-Dev-User": "devuser",
      },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `API request failed: ${response.status} ${response.statusText}`,
          );
        }

        const data = await response.json();

        sendResponse({
          success: true,
          data,
        });
      })
      .catch((error) => {
        console.error("[YouTube Knowledge] Background API error:", error);

        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });

    return true;
  }

  /*
   * --------------------------------------------------
   * ANALYZE VIDEO
   * --------------------------------------------------
   */
  if (message.type === "ANALYZE_VIDEO") {
    const videoId =
      typeof message.videoId === "string" ? message.videoId.trim() : "";

    if (!videoId) {
      sendResponse({
        success: false,
        error: "Video ID is missing.",
      });

      return;
    }

    fetch(
      `http://localhost:8000/api/videos/${encodeURIComponent(videoId)}/analyze/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Dev-User": "devuser",
        },
        body: JSON.stringify({}),
      },
    )
      .then(async (response) => {
        const responseText = await response.text();
        let data: unknown;

        try {
          data = responseText ? JSON.parse(responseText) : null;
        } catch {
          data = {
            error: responseText || response.statusText,
          };
        }

        sendResponse({
          success: response.ok,
          status: response.status,
          data,
          ...(!response.ok && {
            error:
              typeof data === "object" &&
              data !== null &&
              "error" in data &&
              typeof data.error === "string"
                ? data.error
                : `API request failed: ${response.status} ${response.statusText}`,
          }),
        });
      })
      .catch((error) => {
        console.error("[YouTube Knowledge] Analyze video error:", error);

        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to analyze video.",
        });
      });

    return true;
  }

  /*
   * --------------------------------------------------
   * FETCH TRANSCRIPT
   * --------------------------------------------------
   */
  if (message.type === "FETCH_TRANSCRIPT") {
    const videoId =
      typeof message.videoId === "string" ? message.videoId.trim() : "";

    if (!videoId) {
      sendResponse({
        success: false,
        error: "Video ID is missing.",
      });

      return;
    }

    fetch(
      `http://localhost:8000/api/videos/${encodeURIComponent(videoId)}/transcript/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Dev-User": "devuser",
        },
        body: JSON.stringify({}),
      },
    )
      .then(async (response) => {
        const responseText = await response.text();
        let data: unknown;

        try {
          data = responseText ? JSON.parse(responseText) : null;
        } catch {
          data = {
            error: responseText || response.statusText,
          };
        }

        sendResponse({
          success: response.ok,
          status: response.status,
          data,
          ...(!response.ok && {
            error:
              typeof data === "object" &&
              data !== null &&
              "error" in data &&
              typeof data.error === "string"
                ? data.error
                : `API request failed: ${response.status} ${response.statusText}`,
          }),
        });
      })
      .catch((error) => {
        console.error("[YouTube Knowledge] Fetch transcript error:", error);

        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch transcript.",
        });
      });

    return true;
  }

  /*
   * --------------------------------------------------
   * CREATE NOTE
   * --------------------------------------------------
   */
  if (message.type === "CREATE_NOTE") {
    const note = message.data;

    if (!note) {
      sendResponse({
        success: false,
        error: "Note data is missing.",
      });

      return;
    }

    if (!note.title?.trim()) {
      sendResponse({
        success: false,
        error: "Note title is required.",
      });

      return;
    }

    if (!note.document) {
      sendResponse({
        success: false,
        error: "Note document is required.",
      });

      return;
    }

    if (!note.youtube_id) {
      sendResponse({
        success: false,
        error: "YouTube video ID is required.",
      });

      return;
    }

    fetch("http://localhost:8000/api/notes/video/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Dev-User": "devuser",
      },
      body: JSON.stringify({
        youtube_id: note.youtube_id,
        title: note.title,

        content: note.content || "",

        document: note.document,

        note_type: note.note_type || "VIDEO",

        folder: note.folder ?? null,

        timestamp_seconds: note.timestamp_seconds ?? null,
      }),
    })
      .then(async (response) => {
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data?.detail || data?.error || JSON.stringify(data));
        }

        sendResponse({
          success: true,
          data,
        });
      })
      .catch((error) => {
        console.error("[YouTube Knowledge] Create note error:", error);

        sendResponse({
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to create note.",
        });
      });

    return true;
  }

  /*
   * --------------------------------------------------
   * UPDATE NOTE
   * --------------------------------------------------
   */
  if (message.type === "UPDATE_NOTE") {
    const noteId = message.noteId;

    const note = message.data;

    if (!noteId) {
      sendResponse({
        success: false,
        error: "Note ID is missing.",
      });

      return;
    }

    if (!note) {
      sendResponse({
        success: false,
        error: "Note data is missing.",
      });

      return;
    }

    fetch(`http://localhost:8000/api/notes/${noteId}/`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Dev-User": "devuser",
      },
      body: JSON.stringify(note),
    })
      .then(async (response) => {
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data?.detail || JSON.stringify(data));
        }

        sendResponse({
          success: true,
          data,
        });
      })
      .catch((error) => {
        console.error("[YouTube Knowledge] Update note error:", error);

        sendResponse({
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to update note.",
        });
      });

    return true;
  }

  /*
   * --------------------------------------------------
   * DELETE NOTE
   * --------------------------------------------------
   */
  if (message.type === "DELETE_NOTE") {
    const noteId = message.noteId;

    if (!noteId) {
      sendResponse({
        success: false,
        error: "Note ID is missing.",
      });

      return;
    }

    fetch(`http://localhost:8000/api/notes/${noteId}/`, {
      method: "DELETE",
      headers: {
        "X-Dev-User": "devuser",
      },
    })
      .then(async (response) => {
        if (!response.ok) {
          const responseText = await response.text();
          let errorMessage = responseText;

          try {
            const data = JSON.parse(responseText);
            errorMessage = data?.detail || data?.error || responseText;
          } catch {
            // Keep the response text when the server did not return JSON.
          }

          throw new Error(
            errorMessage ||
              `API request failed: ${response.status} ${response.statusText}`,
          );
        }

        sendResponse({
          success: true,
        });
      })
      .catch((error) => {
        console.error("[YouTube Knowledge] Delete note error:", error);

        sendResponse({
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to delete note.",
        });
      });

    return true;
  }
});
