import { useState } from "react";
import type { ThemeColors } from "./Sidebar";

interface CopyButtonProps {
  value: string;
  label?: string;
  colors: ThemeColors;
}

export function CopyButton({
  value,
  label = "Copy",
  colors,
}: CopyButtonProps) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  async function handleCopy(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (!value) {
      return;
    }

    try {
      if (!navigator.clipboard?.writeText) {
        setCopyStatus("failed");
      } else {
        await navigator.clipboard.writeText(value);
        setCopyStatus("copied");
      }
    } catch {
      setCopyStatus("failed");
    }
    window.setTimeout(() => setCopyStatus("idle"), 1200);
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      style={{
        alignSelf: "flex-start",
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        background:
          copyStatus === "copied" ? colors.accentSoft : colors.surface,
        color: copyStatus === "failed" ? colors.danger : copyStatus === "copied" ? colors.accent : colors.muted,
        padding: "6px 10px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {copyStatus === "copied"
        ? "Copied"
        : copyStatus === "failed"
          ? "Copy failed"
          : label}
    </button>
  );
}
