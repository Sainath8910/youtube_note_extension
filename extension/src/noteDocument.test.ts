import { describe, expect, it } from "vitest";
import {
  documentToPlainText,
  getChecklistItems,
  getTableRows,
  hasMeaningfulBlockContent,
  type NoteBlock,
} from "./noteDocument";

describe("table note blocks", () => {
  const table: NoteBlock = {
    id: "table-1",
    type: "table",
    content: "",
    metadata: {
      table_rows: [
        ["Topic", "Status"],
        ["Algebra", "Complete"],
      ],
    },
  };

  it("reads table rows and includes them in plain-text note content", () => {
    expect(getTableRows(table)).toEqual([
      ["Topic", "Status"],
      ["Algebra", "Complete"],
    ]);
    expect(
      documentToPlainText({ version: 1, blocks: [table] }),
    ).toBe("| Topic | Status |\n| Algebra | Complete |");
  });

  it("treats an empty table as meaningful structured content", () => {
    expect(
      hasMeaningfulBlockContent({
        id: "empty-table",
        type: "table",
        content: "",
        metadata: { table_rows: [["", ""]] },
      }),
    ).toBe(true);
  });
});

describe("checklist note blocks", () => {
  const checklist: NoteBlock = {
    id: "checklist-1",
    type: "checklist",
    content: "",
    metadata: {
      checklist_items: [
        { id: "first", text: "Watch lesson", checked: true },
        { id: "second", text: "Take notes", checked: false },
      ],
    },
  };

  it("keeps completion state in plain-text note content", () => {
    expect(getChecklistItems(checklist)).toEqual([
      { id: "first", text: "Watch lesson", checked: true },
      { id: "second", text: "Take notes", checked: false },
    ]);
    expect(
      documentToPlainText({ version: 1, blocks: [checklist] }),
    ).toBe("[x] Watch lesson\n[ ] Take notes");
  });
});
