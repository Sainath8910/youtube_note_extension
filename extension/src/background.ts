chrome.action.onClicked.addListener(() => {
  const dashboardPageUrl = chrome.runtime.getURL("index.html");
  const dashboardUrl = `${dashboardPageUrl}#/dashboard`;

  chrome.tabs.query({ url: `${dashboardPageUrl}*` }, (tabs) => {
    const queryError = chrome.runtime.lastError;
    if (queryError) {
      console.error(
        "[YouTube Knowledge] Could not find an existing dashboard tab:",
        queryError.message,
      );
      return;
    }

    const existingDashboardTab = tabs.find(
      (tab) =>
        typeof tab.url === "string" &&
        tab.url.startsWith(dashboardPageUrl),
    );
    const existingDashboardTabId = existingDashboardTab?.id;

    if (
      existingDashboardTab &&
      existingDashboardTabId !== undefined
    ) {
      chrome.windows.update(
        existingDashboardTab.windowId,
        { focused: true },
        () => {
          const windowError = chrome.runtime.lastError;
          if (windowError) {
            console.error(
              "[YouTube Knowledge] Could not focus the dashboard window:",
              windowError.message,
            );
            return;
          }

          chrome.tabs.update(
            existingDashboardTabId,
            { active: true, url: dashboardUrl },
            () => {
              const tabError = chrome.runtime.lastError;
              if (tabError) {
                console.error(
                  "[YouTube Knowledge] Could not focus the dashboard tab:",
                  tabError.message,
                );
              }
            },
          );
        },
      );
      return;
    }

    chrome.tabs.create({ url: dashboardUrl }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        console.error(
          "[YouTube Knowledge] Could not open the dashboard:",
          error.message,
        );
      }
    });
  });
});

async function respondToConversationRequest(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  sendResponse: (response: unknown) => void,
  data?: unknown,
): Promise<void> {
  try {
    const response = await fetch(
      `http://localhost:8000/api/knowledge/conversations/${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Dev-User": "devuser",
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      },
    );
    const responseText = await response.text();
    let responseData: unknown = null;
    if (responseText) {
      try {
        responseData = JSON.parse(responseText);
      } catch {
        if (response.ok) {
          sendResponse({
            success: false,
            status: 502,
            data: { detail: "The Conversations service returned invalid JSON." },
          });
          return;
        }
      }
    }
    sendResponse({
      success: response.ok,
      status: response.status,
      data: responseData,
    });
  } catch (error) {
    console.error("[YouTube Knowledge] Conversation request failed:", error);
    sendResponse({
      success: false,
      status: 0,
      data: { detail: "Could not reach the Conversations service." },
    });
  }
}

async function respondToFolderRequest(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  sendResponse: (response: unknown) => void,
  data?: unknown,
): Promise<void> {
  try {
    const response = await fetch(
      `http://localhost:8000/api/folders/${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Dev-User": "devuser",
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      },
    );
    const responseText = await response.text();
    let responseData: unknown = null;
    if (responseText) {
      try {
        responseData = JSON.parse(responseText);
      } catch {
        sendResponse({
          success: false,
          status: response.ok ? 502 : response.status,
          data: { detail: "The Folders service returned invalid JSON." },
        });
        return;
      }
    }
    sendResponse({
      success: response.ok,
      status: response.status,
      data: responseData,
    });
  } catch (error) {
    console.error("[YouTube Knowledge] Folder request failed:", error);
    sendResponse({
      success: false,
      status: 0,
      data: { detail: "Could not reach the Folders service." },
    });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SEARCH_FOLDERS") {
    if (typeof message.query !== "string") {
      sendResponse({
        success: false,
        status: 400,
        data: { detail: "A folder search query is required." },
      });
      return;
    }
    const query = encodeURIComponent(message.query.trim());
    void respondToFolderRequest(
      `search/?q=${query}`,
      "GET",
      sendResponse,
    );
    return true;
  }

  if (message.type === "LIST_FOLDERS") {
    let path = "";
    if (Object.prototype.hasOwnProperty.call(message, "parent")) {
      if (message.parent === null) {
        path = "?parent=null";
      } else if (
        typeof message.parent === "number" &&
        Number.isSafeInteger(message.parent) &&
        message.parent > 0
      ) {
        path = `?parent=${encodeURIComponent(String(message.parent))}`;
      } else {
        sendResponse({
          success: false,
          status: 400,
          data: { detail: "Use null or a valid parent folder ID." },
        });
        return;
      }
    }
    void respondToFolderRequest(path, "GET", sendResponse);
    return true;
  }

  if (message.type === "CREATE_FOLDER") {
    if (
      typeof message.data !== "object" ||
      message.data === null ||
      Array.isArray(message.data)
    ) {
      sendResponse({
        success: false,
        status: 400,
        data: { detail: "Folder details are required." },
      });
      return;
    }
    void respondToFolderRequest("", "POST", sendResponse, message.data);
    return true;
  }

  if (
    message.type === "GET_FOLDER" ||
    message.type === "GET_FOLDER_NOTES" ||
    message.type === "UPDATE_FOLDER" ||
    message.type === "DELETE_FOLDER"
  ) {
    const folderId = message.folderId;
    if (
      typeof folderId !== "number" ||
      !Number.isSafeInteger(folderId) ||
      folderId < 1
    ) {
      sendResponse({
        success: false,
        status: 400,
        data: { detail: "A valid folder ID is required." },
      });
      return;
    }
    const folderPath = `${encodeURIComponent(String(folderId))}/`;
    const path =
      message.type === "GET_FOLDER_NOTES"
        ? `${folderPath}notes/`
        : folderPath;
    if (message.type === "UPDATE_FOLDER") {
      if (
        typeof message.data !== "object" ||
        message.data === null ||
        Array.isArray(message.data)
      ) {
        sendResponse({
          success: false,
          status: 400,
          data: { detail: "Folder update details are required." },
        });
        return;
      }
      void respondToFolderRequest(
        path,
        "PATCH",
        sendResponse,
        message.data,
      );
      return true;
    }
    void respondToFolderRequest(
      path,
      message.type === "DELETE_FOLDER" ? "DELETE" : "GET",
      sendResponse,
    );
    return true;
  }

  if (message.type === "REQUEST_NOTE_ASSISTANCE") {
    const noteId = message.noteId;
    if (
      typeof noteId !== "number" ||
      !Number.isSafeInteger(noteId) ||
      noteId < 1 ||
      message.operation !== "improve" ||
      typeof message.base_updated_at !== "string" ||
      typeof message.target !== "object" ||
      message.target === null ||
      Array.isArray(message.target) ||
      message.target.kind !== "block" ||
      typeof message.target.block_id !== "string" ||
      !message.target.block_id
    ) {
      sendResponse({
        success: false,
        status: 400,
        data: { detail: "A valid note assistance request is required." },
      });
      return;
    }

    fetch(
      `http://localhost:8000/api/notes/${encodeURIComponent(String(noteId))}/assistance/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Dev-User": "devuser",
        },
        body: JSON.stringify({
          operation: message.operation,
          target: message.target,
          base_updated_at: message.base_updated_at,
        }),
      },
    )
      .then(async (response) => {
        const responseText = await response.text();
        let data: unknown = null;
        if (responseText) {
          try {
            data = JSON.parse(responseText);
          } catch {
            sendResponse({
              success: false,
              status: response.ok ? 502 : response.status,
              data: null,
            });
            return;
          }
        }
        sendResponse({
          success: response.ok,
          status: response.status,
          data,
        });
      })
      .catch((error) => {
        console.error(
          "[YouTube Knowledge] Note assistance request failed:",
          error,
        );
        sendResponse({
          success: false,
          status: 0,
          data: null,
        });
      });
    return true;
  }

  if (message.type === "LIST_CONVERSATIONS") {
    void respondToConversationRequest("", "GET", sendResponse);
    return true;
  }

  if (message.type === "CREATE_CONVERSATION") {
    if (
      typeof message.data !== "object" ||
      message.data === null ||
      Array.isArray(message.data)
    ) {
      sendResponse({
        success: false,
        status: 400,
        data: { detail: "Conversation details are required." },
      });
      return;
    }
    void respondToConversationRequest("", "POST", sendResponse, message.data);
    return true;
  }

  if (
    message.type === "GET_CONVERSATION" ||
    message.type === "ASK_CONVERSATION" ||
    message.type === "RENAME_CONVERSATION" ||
    message.type === "DELETE_CONVERSATION"
  ) {
    const conversationId = message.conversationId;
    if (
      typeof conversationId !== "number" ||
      !Number.isSafeInteger(conversationId) ||
      conversationId < 1
    ) {
      sendResponse({
        success: false,
        status: 400,
        data: { detail: "A valid conversation ID is required." },
      });
      return;
    }
    const path = `${encodeURIComponent(String(conversationId))}/`;
    if (message.type === "GET_CONVERSATION") {
      void respondToConversationRequest(path, "GET", sendResponse);
      return true;
    }
    if (message.type === "ASK_CONVERSATION") {
      if (typeof message.question !== "string") {
        sendResponse({
          success: false,
          status: 400,
          data: { detail: "A question is required." },
        });
        return;
      }
      void respondToConversationRequest(
        `${path}ask/`,
        "POST",
        sendResponse,
        { question: message.question },
      );
      return true;
    }
    if (message.type === "RENAME_CONVERSATION") {
      if (typeof message.title !== "string") {
        sendResponse({
          success: false,
          status: 400,
          data: { detail: "A conversation title is required." },
        });
        return;
      }
      void respondToConversationRequest(
        path,
        "PATCH",
        sendResponse,
        { title: message.title },
      );
      return true;
    }
    void respondToConversationRequest(path, "DELETE", sendResponse);
    return true;
  }

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

  if (message.type === "CREATE_PREVIOUS_CONTEXT_JOB") {
    const videoId =
      typeof message.videoId === "string" ? message.videoId.trim() : "";

    if (!videoId) {
      sendResponse({
        success: false,
        status: 400,
        data: null,
      });
      return;
    }

    fetch("http://localhost:8000/api/knowledge/previous-context/jobs/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Dev-User": "devuser",
      },
      body: JSON.stringify({ youtube_id: videoId }),
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
      .catch((error) => {
        console.error(
          "[YouTube Knowledge] Previous Context job creation failed:",
          error,
        );
        sendResponse({
          success: false,
          status: 0,
          data: null,
        });
      });

    return true;
  }

  if (message.type === "GET_PREVIOUS_CONTEXT_JOB") {
    const jobId =
      typeof message.jobId === "string" ? message.jobId.trim() : "";

    if (!jobId) {
      sendResponse({
        success: false,
        status: 400,
        data: null,
      });
      return;
    }

    fetch(
      `http://localhost:8000/api/knowledge/previous-context/jobs/${encodeURIComponent(jobId)}/`,
      {
        method: "GET",
        headers: {
          "X-Dev-User": "devuser",
        },
      },
    )
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
      .catch((error) => {
        console.error(
          "[YouTube Knowledge] Previous Context job status request failed:",
          error,
        );
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
   * LIST NOTES
   * --------------------------------------------------
   */
  if (message.type === "GET_NOTES") {
    fetch("http://localhost:8000/api/notes/", {
      method: "GET",
      headers: {
        "X-Dev-User": "devuser",
      },
    })
      .then(async (response) => {
        const responseText = await response.text();
        let data: unknown;

        try {
          data = responseText ? JSON.parse(responseText) : null;
        } catch {
          throw new Error("The notes API returned invalid JSON.");
        }

        if (!response.ok) {
          const detail =
            typeof data === "object" &&
            data !== null &&
            "detail" in data &&
            typeof data.detail === "string"
              ? data.detail
              : `API request failed: ${response.status} ${response.statusText}`;
          throw new Error(detail);
        }

        sendResponse({
          success: true,
          data,
        });
      })
      .catch((error) => {
        console.error("[YouTube Knowledge] Load notes error:", error);
        sendResponse({
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to load notes.",
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
  if (message.type === "CREATE_STANDALONE_NOTE") {
    const note = message.data;

    if (!note || typeof note !== "object") {
      sendResponse({
        success: false,
        error: "Note data is missing.",
      });

      return;
    }

    if (typeof note.title !== "string" || !note.title.trim()) {
      sendResponse({
        success: false,
        error: "Note title is required.",
      });

      return;
    }

    if (!note.document || typeof note.document !== "object") {
      sendResponse({
        success: false,
        error: "Note document is required.",
      });

      return;
    }

    fetch("http://localhost:8000/api/notes/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Dev-User": "devuser",
      },
      body: JSON.stringify({
        title: note.title.trim(),
        content: typeof note.content === "string" ? note.content : "",
        document: note.document,
        note_type: "STANDALONE",
        video: null,
        folder: note.folder ?? null,
        timestamp_seconds: null,
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
        console.error("[YouTube Knowledge] Create standalone note error:", error);

        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to create standalone note.",
        });
      });

    return true;
  }

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
