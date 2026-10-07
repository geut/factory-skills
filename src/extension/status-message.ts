import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export type StatusTheme = {
  fg: (color: "customMessageLabel" | "customMessageText" | "muted", text: string) => string;
};

export type FactoryStatusDetails = {
  text: string;
};

function clip(text: string, max: number): string {
  const line = text.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function statusParts(text: string): { body: string; summary: string; title: string; } {
  const lines = text.split("\n");
  const displayRef = lines[0]?.trim() ?? "factory";
  let cursor = 1;
  const stage = lines[cursor]?.startsWith("stage: ") === true ? lines[cursor]?.slice("stage: ".length) ?? "" : "";
  if (stage.length > 0) {cursor += 1;}
  const status = lines[cursor]?.startsWith("status: ") === true ? lines[cursor]?.slice("status: ".length) ?? "" : "";
  if (status.length > 0) {cursor += 1;}
  const bodyLines = lines.slice(cursor);
  const useful = bodyLines.map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("Run ended with "));
  return {
    body: bodyLines.join("\n").trim(),
    summary: clip(useful[0] ?? bodyLines.find((line) => line.trim().length > 0) ?? status, 100),
    title: [displayRef, stage, status].filter((part) => part.length > 0).join(" · "),
  };
}

export function factoryStatusPayload(text: string): { content: string; details: FactoryStatusDetails; } {
  const parts = statusParts(text);
  const content = parts.summary.length > 0 ? `${parts.title}\n${parts.summary}` : parts.title;
  return { content, details: { text } };
}

export function renderFactoryStatus(input: { expanded: boolean; text: string; theme: StatusTheme; width: number; }): Array<string> {
  const parts = statusParts(input.text);
  const width = Math.max(1, input.width);
  const wrapped = wrapTextWithAnsi(parts.body, width);
  const preview = input.expanded ? wrapped : wrapTextWithAnsi(parts.summary, width);
  const omitted = input.expanded ? 0 : Math.max(0, wrapped.length - preview.length);
  return [
    input.theme.fg("customMessageLabel", parts.title),
    ...preview.filter((row) => row.length > 0).map((row) => input.theme.fg("customMessageText", row)),
    ...(omitted > 0 ? [input.theme.fg("muted", `+${omitted} lines · expand to read`)] : []),
  ];
}

function detailsText(details: unknown): string | null {
  if (typeof details !== "object" || details === null || !("text" in details)) {return null;}
  return typeof details.text === "string" ? details.text : null;
}

function textOf(content: string | ReadonlyArray<{ text?: string; type: string; }>): string {
  if (typeof content === "string") {return content;}
  return content.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}

export const factoryStatusRenderer: MessageRenderer<FactoryStatusDetails> = (message, options, theme): Component => {
  return {
    invalidate() {
      return undefined;
    },
    render(width) {
      return renderFactoryStatus({
        expanded: options.expanded,
        text: detailsText(message.details) ?? textOf(message.content),
        theme: {
          fg: (color, text) => theme.fg(color, text),
        },
        width: Math.max(1, width - Math.max(0, options.outputPad)),
      });
    },
  };
};
