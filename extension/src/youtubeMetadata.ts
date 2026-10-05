export function getActiveYouTubeVideoId(): string {
  const url = new URL(window.location.href);

  if (url.pathname !== "/watch") {
    return "";
  }

  return url.searchParams.get("v")?.trim() ?? "";
}
