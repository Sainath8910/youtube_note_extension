import { useState } from "react";
import { Languages, LoaderCircle, RotateCcw } from "lucide-react";
import "./transcriptTranslator.css";

const LANGUAGES = [
  { code: "ar", name: "Arabic" },
  { code: "bn", name: "Bengali" },
  { code: "zh", name: "Chinese" },
  { code: "nl", name: "Dutch" },
  { code: "en", name: "English" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "hi", name: "Hindi" },
  { code: "id", name: "Indonesian" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "pl", name: "Polish" },
  { code: "pt", name: "Portuguese" },
  { code: "ru", name: "Russian" },
  { code: "es", name: "Spanish" },
  { code: "th", name: "Thai" },
  { code: "tr", name: "Turkish" },
  { code: "vi", name: "Vietnamese" },
] as const;

type LanguageCode = (typeof LANGUAGES)[number]["code"];
type TranslatorAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable"
  | null;

interface LocalTranslator {
  translate(text: string): Promise<string>;
  destroy(): void;
}

interface LocalTranslatorFactory {
  availability(options: {
    sourceLanguage: LanguageCode;
    targetLanguage: LanguageCode;
  }): Promise<TranslatorAvailability>;
  create(options: {
    sourceLanguage: LanguageCode;
    targetLanguage: LanguageCode;
  }): Promise<LocalTranslator>;
}

declare global {
  interface Window {
    Translator?: LocalTranslatorFactory;
  }
}

type TranslationStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "preparing" }
  | { kind: "translating"; completed: number; total: number }
  | { kind: "error"; message: string };

function languageCode(value: string): LanguageCode | "" {
  const normalized = value.trim().toLocaleLowerCase().replaceAll("_", "-");
  const exactCode = LANGUAGES.find((language) => language.code === normalized);
  if (exactCode) return exactCode.code;

  const baseCode = normalized.split("-")[0];
  const matchingCode = LANGUAGES.find((language) => language.code === baseCode);
  if (matchingCode) return matchingCode.code;

  const matchingName = LANGUAGES.find(
    (language) => language.name.toLocaleLowerCase() === normalized,
  );
  return matchingName?.code ?? "";
}

function initialTargetLanguage(): LanguageCode {
  const browserLanguage =
    typeof navigator === "undefined" ? "" : languageCode(navigator.language);
  return browserLanguage || "en";
}

function splitTranscript(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const word of text.match(/\S+/g) ?? []) {
    if (chunk && chunk.length + word.length + 1 > 1800) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk = chunk ? `${chunk} ${word}` : word;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function TranscriptTranslator({
  transcript,
  sourceLanguage,
}: {
  transcript: string;
  sourceLanguage: string;
}) {
  const [source, setSource] = useState<LanguageCode | "">(
    () => languageCode(sourceLanguage),
  );
  const [target, setTarget] = useState<LanguageCode>(initialTargetLanguage);
  const [translatedText, setTranslatedText] = useState<string | null>(null);
  const [status, setStatus] = useState<TranslationStatus>({ kind: "idle" });
  const chunks = splitTranscript(transcript);
  const busy =
    status.kind === "checking" ||
    status.kind === "preparing" ||
    status.kind === "translating";

  const translate = async () => {
    if (!source || source === target || chunks.length === 0) return;
    const api = window.Translator;
    setTranslatedText(null);
    if (!api) {
      setStatus({
        kind: "error",
        message:
          "Local translation is not available in this browser. Use a recent Chrome or Edge version.",
      });
      return;
    }

    setStatus({ kind: "checking" });
    let translator: LocalTranslator | null = null;
    try {
      const availability = await api.availability({
        sourceLanguage: source,
        targetLanguage: target,
      });
      if (availability === "unavailable" || availability === null) {
        setStatus({
          kind: "error",
          message:
            availability === "unavailable"
              ? "This browser cannot translate that language pair locally. Try another source or target language."
              : "The browser could not check local translation availability. Try again later.",
        });
        return;
      }

      setStatus({ kind: "preparing" });
      translator = await api.create({
        sourceLanguage: source,
        targetLanguage: target,
      });
      const translatedChunks: string[] = [];
      for (const [index, chunk] of chunks.entries()) {
        translatedChunks.push(await translator.translate(chunk));
        setStatus({
          kind: "translating",
          completed: index + 1,
          total: chunks.length,
        });
      }
      const result = translatedChunks.join(" ").trim();
      if (!result) throw new Error("The browser returned an empty translation.");
      setTranslatedText(result);
      setStatus({ kind: "idle" });
    } catch (error) {
      setStatus({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The browser could not translate this transcript.",
      });
    } finally {
      translator?.destroy();
    }
  };

  const updateSource = (value: string) => {
    setSource(languageCode(value));
    setTranslatedText(null);
    setStatus({ kind: "idle" });
  };
  const updateTarget = (value: string) => {
    setTarget(languageCode(value) || "en");
    setTranslatedText(null);
    setStatus({ kind: "idle" });
  };

  return (
    <section className="transcript-translation" aria-label="Translate transcript">
      <div className="transcript-translation-heading">
        <Languages size={16} aria-hidden="true" />
        <strong>Translate transcript</strong>
      </div>
      <div className="transcript-translation-controls">
        <label>
          <span>From</span>
          <select
            aria-label="Transcript source language"
            value={source}
            disabled={busy}
            onChange={(event) => updateSource(event.target.value)}
          >
            <option value="">Choose language</option>
            {LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>
                {language.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>To</span>
          <select
            aria-label="Transcript target language"
            value={target}
            disabled={busy}
            onChange={(event) => updateTarget(event.target.value)}
          >
            {LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>
                {language.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="transcript-translation-button"
          type="button"
          disabled={busy || !source || source === target || chunks.length === 0}
          onClick={() => void translate()}
        >
          {busy ? (
            <LoaderCircle className="is-spinning" size={14} aria-hidden="true" />
          ) : (
            <Languages size={14} aria-hidden="true" />
          )}
          {status.kind === "preparing"
            ? "Preparing model…"
            : status.kind === "translating"
              ? `Translating ${status.completed}/${status.total}…`
              : status.kind === "checking"
                ? "Checking…"
                : "Translate"}
        </button>
        {translatedText !== null && (
          <button
            className="transcript-translation-reset"
            type="button"
            onClick={() => {
              setTranslatedText(null);
              setStatus({ kind: "idle" });
            }}
          >
            <RotateCcw size={13} aria-hidden="true" />
            Show original
          </button>
        )}
      </div>
      <p className="transcript-translation-note">
        Translation runs locally with no API key or per-translation charge. The language model may need to download the first time.
      </p>
      {status.kind === "error" && (
        <p className="transcript-translation-message is-error" role="alert">
          {status.message}
        </p>
      )}
      {status.kind === "preparing" && (
        <p className="transcript-translation-message" role="status">
          Preparing the local language model. This may take a moment.
        </p>
      )}
      {translatedText !== null && (
        <details className="video-transcript-full" open>
          <summary>
            Translated transcript ({LANGUAGES.find((item) => item.code === target)?.name})
          </summary>
          <p>{translatedText}</p>
        </details>
      )}
    </section>
  );
}
