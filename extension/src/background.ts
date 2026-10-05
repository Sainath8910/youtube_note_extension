chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
});
