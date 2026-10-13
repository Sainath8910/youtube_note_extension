import { useState, type ReactNode } from "react";
import {
  BadgeCheck,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FileText,
  GraduationCap,
  Lightbulb,
  ListChecks,
  Play,
  Route,
  Tags,
} from "lucide-react";

const ignoredFields = new Set([
  "id",
  "video",
  "model",
  "analysis_version",
  "created_at",
  "updated_at",
]);

const knownFields = new Set([
  "summary",
  "detailed_notes",
  "topics",
  "concepts",
  "prerequisites",
  "upcoming_topics",
  "key_points",
  "claims",
  "questions",
]);

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function detailedSections(value: unknown): Array<{ heading: string; content: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const section = asObject(item);
    return section &&
      typeof section.heading === "string" &&
      section.heading.trim().length > 0 &&
      typeof section.content === "string" &&
      section.content.trim().length > 0
      ? [{ heading: section.heading, content: section.content }]
      : [];
  });
}

function timestampItems(value: unknown): Array<{ text: string; start: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const timestamp = asObject(item);
    return timestamp &&
      typeof timestamp.text === "string" &&
      timestamp.text.trim().length > 0 &&
      typeof timestamp.start === "number" &&
      Number.isFinite(timestamp.start)
      ? [{ text: timestamp.text, start: timestamp.start }]
      : [];
  });
}

function readableLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toLocaleUpperCase());
}

function formatTimestamp(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function timestampUrl(youtubeId: string | undefined, seconds: number): string | null {
  if (!youtubeId || !/^[A-Za-z0-9_-]{11}$/.test(youtubeId)) return null;
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", youtubeId);
  url.searchParams.set("t", String(Math.max(0, Math.floor(seconds))));
  return url.toString();
}

function hasDisplayableValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasDisplayableValue);
  const object = asObject(value);
  return object
    ? Object.entries(object).some(
        ([key, item]) => !ignoredFields.has(key) && hasDisplayableValue(item),
      )
    : false;
}

function AnalysisCard({
  id,
  title,
  icon,
  children,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(id === "summary");
  return (
    <section className="analysis-display-card">
      <button
        className="analysis-display-card-heading"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="analysis-display-card-icon" aria-hidden="true">
          {icon}
        </span>
        <h3>{title}</h3>
        <span className="analysis-display-card-chevron" aria-hidden="true">
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </span>
      </button>
      {expanded && (
        <div className="analysis-display-card-content">{children}</div>
      )}
    </section>
  );
}

function TextList({ items }: { items: string[] }) {
  return (
    <ul className="analysis-display-list">
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ul>
  );
}

function TimestampList({
  items,
  youtubeId,
}: {
  items: Array<{ text: string; start: number }>;
  youtubeId?: string;
}) {
  return (
    <div className="analysis-display-timestamp-list">
      {items.map((item, index) => {
        const url = timestampUrl(youtubeId, item.start);
        const contents = (
          <>
            <Play size={13} aria-hidden="true" />
            <span className="analysis-display-timestamp">
              {formatTimestamp(item.start)}
            </span>
            <span>{item.text}</span>
          </>
        );
        return url ? (
          <a
            className="analysis-display-timestamp-item"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            key={`${item.start}-${index}`}
          >
            {contents}
          </a>
        ) : (
          <div
            className="analysis-display-timestamp-item"
            key={`${item.start}-${index}`}
          >
            {contents}
          </div>
        );
      })}
    </div>
  );
}

function GenericValue({ value }: { value: unknown }) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <p>{String(value)}</p>;
  }
  if (Array.isArray(value)) {
    const list = value
      .map((item) =>
        typeof item === "string" || typeof item === "number"
          ? String(item)
          : null,
      )
      .filter((item): item is string => item !== null);
    if (list.length === value.length) return <TextList items={list} />;
    return (
      <div className="analysis-display-nested">
        {value.map((item, index) => (
          <div key={index}>
            <GenericValue value={item} />
          </div>
        ))}
      </div>
    );
  }
  const object = asObject(value);
  if (!object) return null;
  const entries = Object.entries(object).filter(
    ([key, item]) =>
      !ignoredFields.has(key) &&
      item !== null &&
      item !== "" &&
      (!Array.isArray(item) || item.length > 0),
  );
  return entries.length ? (
    <dl className="analysis-display-fields">
      {entries.map(([key, item]) => (
        <div key={key}>
          <dt>{readableLabel(key)}</dt>
          <dd>
            <GenericValue value={item} />
          </dd>
        </div>
      ))}
    </dl>
  ) : null;
}

export function AnalysisDisplay({
  analysis,
  youtubeId,
}: {
  analysis: Record<string, unknown>;
  youtubeId?: string;
}) {
  const detailedNotes = asObject(analysis.detailed_notes);
  const sections = detailedSections(detailedNotes?.sections);
  const definitions = strings(detailedNotes?.definitions);
  const examples = strings(detailedNotes?.examples);
  const topics = strings(analysis.topics);
  const concepts = strings(analysis.concepts);
  const prerequisites = strings(analysis.prerequisites);
  const upcomingTopics = strings(analysis.upcoming_topics);
  const keyPoints = timestampItems(analysis.key_points);
  const claims = timestampItems(analysis.claims);
  const questions = strings(analysis.questions);
  const summary =
    typeof analysis.summary === "string" ? analysis.summary : "";
  const extraFields = Object.entries(analysis).filter(
    ([key, value]) =>
      !knownFields.has(key) &&
      !ignoredFields.has(key) &&
      hasDisplayableValue(value),
  );
  const hasDisplayableSections =
    summary.trim().length > 0 ||
    sections.length > 0 ||
    definitions.length > 0 ||
    examples.length > 0 ||
    topics.length > 0 ||
    concepts.length > 0 ||
    prerequisites.length > 0 ||
    upcomingTopics.length > 0 ||
    keyPoints.length > 0 ||
    claims.length > 0 ||
    questions.length > 0 ||
    extraFields.length > 0;

  return (
    <section className="analysis-display" aria-label="AI Video Analysis">
      <h2>AI Video Analysis</h2>
      {!hasDisplayableSections && (
        <p className="analysis-display-empty">
          Analysis exists, but it contains no displayable content.
        </p>
      )}
      <div className="analysis-display-cards">
        {summary.trim() && (
          <AnalysisCard id="summary" title="Summary" icon={<FileText size={14} />}>
            <p className="analysis-display-summary">{summary}</p>
          </AnalysisCard>
        )}
        {(sections.length > 0 || definitions.length > 0 || examples.length > 0) && (
          <AnalysisCard
            id="detailed-notes"
            title="Detailed Notes"
            icon={<BookOpen size={14} />}
          >
            <div className="analysis-display-subsections">
              {sections.map((section, index) => (
                <section key={`${section.heading}-${index}`}>
                  <h4>{section.heading}</h4>
                  <p>{section.content}</p>
                </section>
              ))}
              {definitions.length > 0 && (
                <section>
                  <h4>Definitions</h4>
                  <TextList items={definitions} />
                </section>
              )}
              {examples.length > 0 && (
                <section>
                  <h4>Examples</h4>
                  <TextList items={examples} />
                </section>
              )}
            </div>
          </AnalysisCard>
        )}
        {topics.length > 0 && (
          <AnalysisCard id="topics" title="Topics" icon={<Tags size={14} />}>
            <TextList items={topics} />
          </AnalysisCard>
        )}
        {concepts.length > 0 && (
          <AnalysisCard id="concepts" title="Concepts" icon={<Lightbulb size={14} />}>
            <TextList items={concepts} />
          </AnalysisCard>
        )}
        {prerequisites.length > 0 && (
          <AnalysisCard
            id="prerequisites"
            title="Prerequisites"
            icon={<GraduationCap size={14} />}
          >
            <TextList items={prerequisites} />
          </AnalysisCard>
        )}
        {upcomingTopics.length > 0 && (
          <AnalysisCard
            id="upcoming-topics"
            title="Upcoming Topics"
            icon={<Route size={14} />}
          >
            <TextList items={upcomingTopics} />
          </AnalysisCard>
        )}
        {keyPoints.length > 0 && (
          <AnalysisCard
            id="key-points"
            title="Key Points"
            icon={<ListChecks size={14} />}
          >
            <TimestampList items={keyPoints} youtubeId={youtubeId} />
          </AnalysisCard>
        )}
        {claims.length > 0 && (
          <AnalysisCard id="claims" title="Claims" icon={<BadgeCheck size={14} />}>
            <TimestampList items={claims} youtubeId={youtubeId} />
          </AnalysisCard>
        )}
        {questions.length > 0 && (
          <AnalysisCard
            id="questions"
            title="Questions"
            icon={<CircleHelp size={14} />}
          >
            <TextList items={questions} />
          </AnalysisCard>
        )}
        {extraFields.map(([key, value]) => (
          <AnalysisCard
            id={key}
            key={key}
            title={readableLabel(key)}
            icon={<FileText size={14} />}
          >
            <GenericValue value={value} />
          </AnalysisCard>
        ))}
      </div>
    </section>
  );
}
