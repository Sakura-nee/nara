// ─────────────────────────────────────────────────────────────
// TUI Theme — Colors, Symbols & Box Drawing
// ─────────────────────────────────────────────────────────────

// ANSI escape helpers
const esc = (code: string) => `\x1b[${code}m`;

export const Reset = esc("0");

// ── Text Styles ──────────────────────────────────────────────
export const Bold = esc("1");
export const Dim = esc("2");
export const Italic = esc("3");

// ── Foreground Colors ────────────────────────────────────────
export const fg = {
  black: esc("30"),
  red: esc("31"),
  green: esc("32"),
  yellow: esc("33"),
  blue: esc("34"),
  magenta: esc("35"),
  cyan: esc("36"),
  white: esc("37"),

  // Bright variants
  brightBlack: esc("90"),
  brightRed: esc("91"),
  brightGreen: esc("92"),
  brightYellow: esc("93"),
  brightBlue: esc("94"),
  brightMagenta: esc("95"),
  brightCyan: esc("96"),
  brightWhite: esc("97"),
} as const;

// ── Background Colors ────────────────────────────────────────
export const bg = {
  black: esc("40"),
  red: esc("41"),
  green: esc("42"),
  yellow: esc("43"),
  blue: esc("44"),
  magenta: esc("45"),
  cyan: esc("46"),
  white: esc("47"),
} as const;

// ── Box Drawing ──────────────────────────────────────────────
export const box = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  teeLeft: "├",
  teeRight: "┤",
} as const;

// ── Status Symbols ───────────────────────────────────────────
export const sym = {
  dot: "●",
  check: "✓",
  cross: "✗",
  arrow: "▸",
  hourglass: "⏳",
  bolt: "⚡",
  eye: "👁",
  crystal: "🔮",
  rocket: "🚀",
  warn: "⚠",
  spin: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
} as const;

// ── Agent Status Enum ────────────────────────────────────────
export type AgentStatus =
  | "IDLE"
  | "SOLVING"
  | "SUBMITTING"
  | "CORRECT"
  | "WRONG"
  | "WAITING"
  | "ERROR";

export function statusStyle(status: AgentStatus): {
  label: string;
  color: string;
  symbol: string;
} {
  switch (status) {
    case "IDLE":
      return { label: "IDLE", color: fg.brightBlack, symbol: sym.dot };
    case "SOLVING":
      return { label: "SOLVING", color: fg.cyan, symbol: sym.bolt };
    case "SUBMITTING":
      return { label: "SUBMITTING", color: fg.yellow, symbol: sym.arrow };
    case "CORRECT":
      return { label: "CORRECT", color: fg.green, symbol: sym.check };
    case "WRONG":
      return { label: "WRONG", color: fg.red, symbol: sym.cross };
    case "WAITING":
      return { label: "WAITING", color: fg.yellow, symbol: sym.hourglass };
    case "ERROR":
      return { label: "ERROR", color: fg.brightRed, symbol: sym.warn };
  }
}
