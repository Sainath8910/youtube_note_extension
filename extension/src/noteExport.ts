import {
  getListItems,
  type NoteBlock,
  type NoteDocument,
  type VideoNote,
} from "./noteDocument";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: string | undefined | null): string {
  return (value ?? "").replace(/\r\n/g, "\n").trim();
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseTimestampValue(raw: string): number | null {
  if (!raw) return null;

  const components = raw.trim().split(":");
  if (
    (components.length !== 2 && components.length !== 3) ||
    components.some((part) => !/^\d+$/.test(part))
  ) {
    return null;
  }
  const parts = components.map(Number);

  if (parts.length !== 2 && parts.length !== 3) {
    return null;
  }

  if (parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    if (minutes < 0 || seconds < 0 || seconds >= 60) {
      return null;
    }
    return minutes * 60 + seconds;
  }

  const [hours, minutes, seconds] = parts;
  if (
    hours < 0 ||
    minutes < 0 ||
    seconds < 0 ||
    minutes >= 60 ||
    seconds >= 60
  ) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

function formatTimestampLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) {
    return "[Timestamp]";
  }

  const safeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;

  const formattedMinutes = String(minutes).padStart(2, "0");
  const formattedSeconds = String(remainingSeconds).padStart(2, "0");

  return hours > 0
    ? `[${String(hours).padStart(2, "0")}:${formattedMinutes}:${formattedSeconds}]`
    : `[${formattedMinutes}:${formattedSeconds}]`;
}

function getHeadingLevel(block: NoteBlock): number {
  const metadata = block.metadata ?? {};
  const candidateKeys = [
    "level",
    "headingLevel",
    "heading_level",
    "depth",
  ] as const;

  for (const key of candidateKeys) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isInteger(value)) {
      const safeLevel = Math.min(6, Math.max(1, value));
      return safeLevel;
    }
  }

  return 2;
}

function fencedMarkdownBlock(
  language: string | null | undefined,
  content: string,
): string {
  const longestFence = [...content.matchAll(/`+/g)].reduce((max, match) => {
    return Math.max(max, match[0].length);
  }, 0);
  const fenceLength = Math.max(3, longestFence + 1);
  const fence = "`".repeat(fenceLength);
  const label = toStringValue(language)?.trim().replace(/[\r\n\s]+/g, "") ?? "";
  return `${fence}${label ? ` ${label}` : ""}\n${content}\n${fence}`;
}

function getValidUrl(value: string | undefined | null): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;

  try {
    const candidate = new URL(raw);
    if (
      (candidate.protocol === "http:" || candidate.protocol === "https:") &&
      candidate.hostname
    ) {
      return candidate.href;
    }
  } catch {
    return null;
  }

  return null;
}

function getValidImageSource(value: string): string | null {
  const source = getValidUrl(value);
  if (source) return source;

  return /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(
    value,
  )
    ? value
    : null;
}

function escapeMarkdownAltText(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1").replace(/[\r\n]+/g, " ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatLinkMarkdown(url: string, title?: string): string {
  const safeUrl = getValidUrl(url);
  if (!safeUrl) {
    const fallbackText = title ? title.trim() : "URL";
    return fallbackText || "URL";
  }

  const displayText = (title && title.trim()) || safeUrl;
  const safeDisplayText = displayText.replace(/([\\[\]])/g, "\\$1");
  return `[${safeDisplayText}](<${safeUrl}>)`;
}

function formatEquationMarkdown(raw: string): string {
  const content = normalizeText(raw);
  if (!content) {
    return "";
  }

  if (
    /^(?:\$\$[\s\S]*\$\$|\$[^\n]*\$|\\\([^\n]*\\\)|\\\[[\s\S]*\\\]|\\begin\{.*\}.*\\end\{.*\})$/.test(
      content,
    )
  ) {
    return content;
  }

  return content.includes("\n") ? `$$\n${content}\n$$` : `$${content}$`;
}

function coerceResourceTitle(value: string | null | undefined): string | null {
  const title = normalizeText(value);
  return title || null;
}

function getYoutubeIdFromNote(note: Record<string, unknown>): string | null {
  const validYoutubeId = (value: unknown): string | null =>
    typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value)
      ? value
      : null;
  const candidates = [
    note.youtube_id,
    note.youtubeId,
    note.video_id,
    note.videoId,
    note.video_detail,
  ];

  for (const candidate of candidates) {
    const directId = validYoutubeId(candidate);
    if (directId) return directId;

    if (isObject(candidate)) {
      const nested =
        candidate.youtube_id ?? candidate.youtubeId ?? candidate.video_id ?? candidate.videoId;
      const nestedId = validYoutubeId(nested);
      if (nestedId) return nestedId;
    }
  }

  return null;
}

function formatTimestampWithUrl(
  note: Record<string, unknown> | undefined,
  block: NoteBlock,
): string {
  const timestampValue = normalizeText(block.content);
  const seconds =
    parseTimestampValue(timestampValue) ??
    (typeof block.metadata?.timestamp_seconds === "number" &&
    Number.isFinite(block.metadata.timestamp_seconds) &&
    block.metadata.timestamp_seconds >= 0
      ? block.metadata.timestamp_seconds
      : null);

  if (seconds === null) {
    return formatTimestampLabel(null);
  }

  const youtubeId = getYoutubeIdFromNote(note ?? {});
  if (!youtubeId) {
    return formatTimestampLabel(seconds);
  }

  const formatted = formatTimestampLabel(seconds).replace(/^\[|\]$/g, "");
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}&t=${Math.max(0, Math.round(seconds))}s`;
  return `[${formatted}](${url})`;
}

function normalizeDocumentForExport(value: unknown): NoteDocument | null {
  if (!isObject(value)) {
    return null;
  }

  if (value.version === 1 && Array.isArray(value.blocks)) {
    const blocks = value.blocks.filter((block): block is NoteBlock => {
      return (
        isObject(block) &&
        typeof block.id === "string" &&
        typeof block.type === "string" &&
        typeof block.content === "string"
      );
    });
    return { version: 1, blocks };
  }

  return null;
}

function resolveNoteDocument(note: unknown): {
  document: NoteDocument;
  title: string | null;
  noteLike: Record<string, unknown> | undefined;
} {
  if (isObject(note)) {
    const directDocument = normalizeDocumentForExport(note);
    if (directDocument) {
      return {
        document: directDocument,
        title: typeof note.title === "string" ? note.title.trim() : null,
        noteLike: note as Record<string, unknown>,
      };
    }

    const title = typeof note.title === "string" ? note.title.trim() : null;
    const document: NoteDocument =
      normalizeDocumentForExport(note.document) ?? { version: 1, blocks: [] };
    const noteLike = note as Record<string, unknown>;
    return {
      document,
      title,
      noteLike,
    };
  }

  return {
    document: { version: 1, blocks: [] },
    title: null,
    noteLike: undefined,
  };
}

function blockToMarkdown(
  block: NoteBlock,
  noteLike: Record<string, unknown> | undefined,
): string {
  const content = normalizeText(block.content);

  switch (block.type) {
    case "heading": {
      const level = getHeadingLevel(block);
      const text = content || "Untitled heading";
      return `${"#".repeat(level)} ${text}`;
    }
    case "paragraph":
      return content || "";
    case "bullet_list": {
      const items = getListItems(block.content);
      return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "";
    }
    case "numbered_list": {
      const items = getListItems(block.content);
      return items.length > 0
        ? items.map((item, index) => `${index + 1}. ${item}`).join("\n")
        : "";
    }
    case "code": {
      return fencedMarkdownBlock(
        toStringValue(block.metadata?.language),
        block.content ?? "",
      );
    }
    case "command": {
      const shellLabel =
        toStringValue(block.metadata?.shell) ??
        toStringValue(block.metadata?.environment) ??
        toStringValue(block.metadata?.language);
      return fencedMarkdownBlock(shellLabel, block.content ?? "");
    }
    case "url": {
      const url =
        getValidUrl(block.content) ??
        getValidUrl(toStringValue(block.metadata?.url)) ??
        null;
      const title =
        coerceResourceTitle(toStringValue(block.metadata?.title)) ??
        coerceResourceTitle(block.content);
      if (!url) {
        return title ?? "URL";
      }
      return formatLinkMarkdown(url, title ?? undefined);
    }
    case "equation":
      return formatEquationMarkdown(block.content ?? "");
    case "timestamp":
      return formatTimestampWithUrl(noteLike, block);
    case "image": {
      const rawSource =
        normalizeText(block.content) ||
        normalizeText(toStringValue(block.metadata?.image));
      const source = rawSource ? getValidImageSource(rawSource) : null;
      const altText = escapeMarkdownAltText(
        normalizeText(toStringValue(block.metadata?.alt)) || "Image",
      );
      if (!source) {
        return `[Image: ${altText} (source unavailable)]`;
      }
      return `![${altText}](<${source}>)`;
    }
    case "screenshot": {
      const rawScreenshotSource =
        normalizeText(block.content) ||
        normalizeText(toStringValue(block.metadata?.image));
      const screenshotSource = rawScreenshotSource
        ? getValidImageSource(rawScreenshotSource)
        : null;
      const timestampSeconds =
        typeof block.metadata?.timestamp_seconds === "number" &&
        Number.isFinite(block.metadata.timestamp_seconds)
          ? Math.max(0, Math.round(block.metadata.timestamp_seconds))
          : null;
      const altText =
        timestampSeconds !== null
          ? `Video screenshot at ${formatTimestampLabel(timestampSeconds).replace(/^\[|\]$/g, "")}`
          : "Video screenshot";
      const safeAltText = escapeMarkdownAltText(altText);
      if (!screenshotSource) {
        return `[${safeAltText} (image source unavailable)]`;
      }
      return `![${safeAltText}](<${screenshotSource}>)`;
    }
    default:
      return content || "";
  }
}

function htmlText(value: string): string {
  return escapeHtml(value);
}

function htmlAttribute(value: string): string {
  return escapeHtml(value);
}

function getHtmlTimestamp(
  note: Record<string, unknown> | undefined,
  block: NoteBlock,
): { label: string; url: string | null } {
  const timestampValue = normalizeText(block.content);
  const seconds =
    parseTimestampValue(timestampValue) ??
    (typeof block.metadata?.timestamp_seconds === "number" &&
    Number.isFinite(block.metadata.timestamp_seconds) &&
    block.metadata.timestamp_seconds >= 0
      ? block.metadata.timestamp_seconds
      : null);
  const label =
    seconds === null
      ? timestampValue || "Timestamp"
      : formatTimestampLabel(seconds).replace(/^\[|\]$/g, "");
  const youtubeId = getYoutubeIdFromNote(note ?? {});
  return {
    label,
    url:
      seconds !== null && youtubeId
        ? `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}&t=${Math.max(0, Math.round(seconds))}s`
        : null,
  };
}

function safeCodeLanguage(block: NoteBlock): string {
  const language = toStringValue(block.metadata?.language)?.trim() ?? "";
  return language.replace(/[^A-Za-z0-9_-]/g, "");
}

function blockToHtml(
  block: NoteBlock,
  noteLike: Record<string, unknown> | undefined,
): string {
  const content = block.content;

  switch (block.type) {
    case "paragraph":
      return content.trim()
        ? `<p>${htmlText(content)}</p>`
        : "";
    case "heading": {
      const tag = `h${getHeadingLevel(block)}`;
      return `<${tag}>${htmlText(content || "Untitled heading")}</${tag}>`;
    }
    case "bullet_list":
    case "numbered_list": {
      const tag = block.type === "bullet_list" ? "ul" : "ol";
      const items = getListItems(content)
        .map((item) => `<li>${htmlText(item)}</li>`)
        .join("");
      return items ? `<${tag}>${items}</${tag}>` : "";
    }
    case "code": {
      const language = safeCodeLanguage(block);
      const classAttribute = language
        ? ` class="language-${htmlAttribute(language)}"`
        : "";
      return `<pre class="code-block"><code${classAttribute}>${htmlText(content)}</code></pre>`;
    }
    case "command":
      return `<figure class="command-block"><figcaption>Command</figcaption><pre><code>${htmlText(content)}</code></pre></figure>`;
    case "url": {
      const rawUrl =
        getValidUrl(content) ??
        getValidUrl(toStringValue(block.metadata?.url));
      const title = coerceResourceTitle(toStringValue(block.metadata?.title));
      const description = coerceResourceTitle(
        toStringValue(block.metadata?.description),
      );
      const domain = coerceResourceTitle(toStringValue(block.metadata?.domain));
      if (!rawUrl) {
        const fallback = title || content || "URL";
        return `<p class="resource">${htmlText(fallback)}</p>`;
      }
      const label = title || rawUrl;
      const anchor = `<a href="${htmlAttribute(rawUrl)}" target="_blank" rel="noopener noreferrer">${htmlText(label)}</a>`;
      const details = [
        domain ? `<span class="resource-domain">${htmlText(domain)}</span>` : "",
        description ? `<p>${htmlText(description)}</p>` : "",
      ].filter(Boolean).join("");
      return `<aside class="resource">${anchor}${details}</aside>`;
    }
    case "equation":
      return `<div class="equation" aria-label="Equation"><code>${htmlText(content)}</code></div>`;
    case "timestamp": {
      const timestamp = getHtmlTimestamp(noteLike, block);
      const label = htmlText(timestamp.label);
      return timestamp.url
        ? `<p class="timestamp"><a href="${htmlAttribute(timestamp.url)}" target="_blank" rel="noopener noreferrer">${label}</a></p>`
        : `<p class="timestamp">${label}</p>`;
    }
    case "image": {
      const rawSource =
        normalizeText(content) ||
        normalizeText(toStringValue(block.metadata?.image));
      const source = rawSource ? getValidImageSource(rawSource) : null;
      const alt = normalizeText(toStringValue(block.metadata?.alt)) || "Image";
      return source
        ? `<figure class="note-image"><img src="${htmlAttribute(source)}" alt="${htmlAttribute(alt)}"></figure>`
        : `<p class="image-unavailable">Image: ${htmlText(alt)} (source unavailable)</p>`;
    }
    case "screenshot": {
      const rawSource =
        normalizeText(content) ||
        normalizeText(toStringValue(block.metadata?.image));
      const source = rawSource ? getValidImageSource(rawSource) : null;
      const alt = normalizeText(toStringValue(block.metadata?.alt)) ||
        (typeof block.metadata?.timestamp_seconds === "number" &&
        Number.isFinite(block.metadata.timestamp_seconds) &&
        block.metadata.timestamp_seconds >= 0
          ? `Video screenshot at ${formatTimestampLabel(block.metadata.timestamp_seconds).replace(/^\[|\]$/g, "")}`
          : "Video screenshot");
      if (!source) {
        return `<p class="image-unavailable">${htmlText(alt)} (image source unavailable)</p>`;
      }

      const timestampSeconds =
        typeof block.metadata?.timestamp_seconds === "number" &&
        Number.isFinite(block.metadata.timestamp_seconds) &&
        block.metadata.timestamp_seconds >= 0
          ? block.metadata.timestamp_seconds
          : null;
      const timestampInfo =
        timestampSeconds === null
          ? null
          : getHtmlTimestamp(noteLike, {
              ...block,
              content: formatTimestampLabel(timestampSeconds).replace(/^\[|\]$/g, ""),
            });
      const timestampHtml =
        timestampInfo && timestampSeconds !== null
          ? timestampInfo.url
            ? `<figcaption class="timestamp"><a href="${htmlAttribute(timestampInfo.url)}" target="_blank" rel="noopener noreferrer">${htmlText(timestampInfo.label)}</a></figcaption>`
            : `<figcaption class="timestamp">${htmlText(timestampInfo.label)}</figcaption>`
          : "";
      return `<figure class="note-image screenshot"><img src="${htmlAttribute(source)}" alt="${htmlAttribute(alt)}">${timestampHtml}</figure>`;
    }
    default:
      return content.trim()
        ? `<p class="unknown-block">${htmlText(content)}</p>`
        : "";
  }
}

function noteTitle(note: Record<string, unknown> | undefined): string {
  return typeof note?.title === "string" ? note.title.trim() : "";
}

const exportedHtmlStyles = `
  :root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #fff; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 24px; font-size: 16px; line-height: 1.7; }
  main { width: min(100%, 820px); margin: 0 auto; overflow-wrap: anywhere; }
  h1, h2, h3, h4, h5, h6 { margin: 1.5em 0 .55em; line-height: 1.25; color: #101827; }
  h1 { margin-top: 0; font-size: 2.15rem; }
  p { margin: 0 0 1em; white-space: pre-wrap; }
  ul, ol { margin: 0 0 1.25em; padding-left: 1.7em; }
  li { padding-left: .2em; margin: .25em 0; }
  pre { max-width: 100%; margin: 0 0 1.25em; padding: 16px; overflow: auto; border: 1px solid #d7dee8; border-radius: 8px; background: #f3f6fa; white-space: pre-wrap; overflow-wrap: anywhere; }
  pre code, .equation code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; }
  .command-block { margin: 0 0 1.25em; border: 1px solid #b7c4d4; border-left: 4px solid #52677f; border-radius: 8px; background: #edf1f6; }
  .command-block figcaption { padding: 8px 14px 0; color: #45556a; font-size: .78rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
  .command-block pre { margin: 0; border: 0; background: transparent; }
  .resource { margin: 0 0 1.25em; padding: 12px 15px; border: 1px solid #d7dee8; border-radius: 8px; }
  .resource a, .timestamp a { color: #075985; text-decoration: underline; text-underline-offset: 2px; }
  .resource-domain { display: block; margin-top: 3px; color: #64748b; font-size: .82rem; }
  .resource p { margin: 8px 0 0; color: #475569; font-size: .92rem; }
  .equation { margin: 0 0 1.25em; padding: 14px 16px; border-left: 3px solid #64748b; background: #f8fafc; overflow-x: auto; white-space: pre-wrap; }
  .note-image { margin: 0 0 1.5em; text-align: center; }
  .note-image img { display: inline-block; max-width: 100%; max-height: 85vh; height: auto; object-fit: contain; }
  .screenshot img { max-height: 75vh; }
  .timestamp { margin-top: .35em; color: #475569; font-size: .92rem; }
  .image-unavailable { color: #64748b; font-style: italic; }
  @media print {
    @page { margin: 18mm; }
    body { padding: 0; font-size: 11pt; }
    main { width: 100%; max-width: none; overflow: visible; }
    h1, h2, h3, h4, h5, h6 { break-after: avoid-page; }
    p, li, .resource, .equation, .command-block, .note-image { break-inside: avoid-page; }
    pre { max-height: none; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere; }
    .note-image img { max-height: 230mm; }
    a { color: inherit; }
  }
`;

function documentToHtml(
  document: NoteDocument,
  title: string,
  noteLike: Record<string, unknown> | undefined,
): string {
  const renderedBlocks = document.blocks
    .map((block) => blockToHtml(block, noteLike))
    .filter(Boolean)
    .join("\n");
  const showTitle = title && !shouldSkipTitle(document, title);
  const content = [
    showTitle ? `<h1 class="note-title">${htmlText(title)}</h1>` : "",
    renderedBlocks,
  ]
    .filter(Boolean)
    .join("\n");
  const safeTitle = htmlText(title || "Untitled note");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>${safeTitle}</title>
  <style>${exportedHtmlStyles}</style>
</head>
<body>
  <main class="note-document">
${content}
  </main>
</body>
</html>`;
}

function shouldSkipTitle(document: NoteDocument, title: string): boolean {
  if (!title) {
    return true;
  }

  const firstBlock = document.blocks[0];
  return (
    firstBlock?.type === "heading" &&
    normalizeText(firstBlock.content).toLowerCase() === title.toLowerCase()
  );
}

export function exportDocumentAsMarkdown(
  document: NoteDocument | undefined,
  title?: string | null,
): string {
  const safeDocument: NoteDocument =
    document && Array.isArray(document.blocks)
      ? document
      : { version: 1, blocks: [] };

  const markdownBlocks = safeDocument.blocks
    .map((block) => blockToMarkdown(block, undefined))
    .filter((block) => block && block.trim().length > 0);

  const header =
    title && !shouldSkipTitle(safeDocument, title)
      ? `# ${title.trim()}`
      : null;

  const sections = [header, ...markdownBlocks].filter(
    (section): section is string => Boolean(section && section.trim().length > 0),
  );

  return sections.join("\n\n").trim();
}

export function exportNoteAsMarkdown(note: VideoNote | NoteDocument): string {
  const { document, title, noteLike } = resolveNoteDocument(note);
  const safeDocument: NoteDocument =
    document && Array.isArray(document.blocks)
      ? document
      : { version: 1, blocks: [] };

  const markdownBlocks = safeDocument.blocks
    .map((block) => blockToMarkdown(block, noteLike))
    .filter((block) => block && block.trim().length > 0);

  const header =
    title && !shouldSkipTitle(safeDocument, title)
      ? `# ${title}`
      : null;

  const sections = [header, ...markdownBlocks].filter(
    (section): section is string => Boolean(section && section.trim().length > 0),
  );

  return sections.join("\n\n").trim();
}

export function exportNoteToHtml(note: VideoNote | NoteDocument): string {
  const resolved = resolveNoteDocument(note);
  return documentToHtml(
    resolved.document,
    resolved.title ?? noteTitle(resolved.noteLike),
    resolved.noteLike,
  );
}

export default exportNoteAsMarkdown;
