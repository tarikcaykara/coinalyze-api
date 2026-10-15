const LEGEND_PATTERN = /Predicted Funding Rate[\s\S]*?AVG close 10\s+([+\u2212-]?\d+(?:\.\d+)?)/i;

/** Extracts the "AVG close 10" legend value; TradingView renders negatives with U+2212. */
export const parseLegendValue = (text: string): number | null => {
  const raw = LEGEND_PATTERN.exec(text)?.[1];
  if (raw === undefined) return null;
  const value = Number(raw.replace(/\u2212/g, "-"));
  return Number.isFinite(value) ? value : null;
};

/** Parses a funding-table cell such as "+0.0094%", "−0.0016%" or "n/a". */
export const parsePercent = (text: string): number | null => {
  const match = /^\s*([+\u2212-]?\d+(?:\.\d+)?)\s*%\s*$/.exec(text);
  return match?.[1] === undefined ? null : Number(match[1].replace(/\u2212/g, "-"));
};

export type CloudflareState = "none" | "challenge" | "blocked";

export const classifyCloudflare = (title: string, bodyText: string): CloudflareState => {
  const t = title.toLowerCase();
  const text = bodyText.toLowerCase();
  if (text.includes("you have been blocked")) return "blocked";
  if (
    t.includes("just a moment") ||
    t.includes("attention required") ||
    text.includes("verify you are human") ||
    text.includes("checking your browser") ||
    text.includes("cf-browser-verification")
  ) {
    return "challenge";
  }
  return "none";
};
