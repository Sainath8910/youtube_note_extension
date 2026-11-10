interface DashboardTab {
  id?: number;
  windowId?: number;
  url?: string;
}

interface DashboardTabApi {
  runtime: {
    getURL(path: string): string;
    lastError: { message?: string } | null | undefined;
  };
  tabs: {
    query(
      queryInfo: { url: string },
      callback: (tabs: DashboardTab[]) => void,
    ): void;
    update(
      tabId: number,
      properties: { active: boolean; url: string },
      callback: () => void,
    ): void;
    create(properties: { url: string }, callback: () => void): void;
  };
  windows: {
    update(
      windowId: number,
      properties: { focused: boolean },
      callback: () => void,
    ): void;
  };
}

export function openDashboardTab(api: DashboardTabApi): void {
  const dashboardPageUrl = api.runtime.getURL("index.html");
  const dashboardUrl = `${dashboardPageUrl}#/dashboard`;

  api.tabs.query({ url: `${dashboardPageUrl}*` }, (tabs) => {
    const queryError = api.runtime.lastError;
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
    const tabId = existingDashboardTab?.id;
    const windowId = existingDashboardTab?.windowId;
    if (tabId !== undefined && windowId !== undefined) {
      api.windows.update(windowId, { focused: true }, () => {
        const windowError = api.runtime.lastError;
        if (windowError) {
          console.error(
            "[YouTube Knowledge] Could not focus the dashboard window:",
            windowError.message,
          );
          return;
        }

        api.tabs.update(
          tabId,
          { active: true, url: dashboardUrl },
          () => {
            const tabError = api.runtime.lastError;
            if (tabError) {
              console.error(
                "[YouTube Knowledge] Could not focus the dashboard tab:",
                tabError.message,
              );
            }
          },
        );
      });
      return;
    }

    api.tabs.create({ url: dashboardUrl }, () => {
      const error = api.runtime.lastError;
      if (error) {
        console.error(
          "[YouTube Knowledge] Could not open the dashboard:",
          error.message,
        );
      }
    });
  });
}
