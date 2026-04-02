// ─────────────────────────────────────────────────────────────
// TUI Renderer — Fixed-position UI with in-place updates
//
// The UI occupies a fixed region of the terminal. On each
// update, the cursor moves back to the top of the region
// and redraws all lines, overwriting previous content.
// Nothing is appended — the frame stays in place.
// ─────────────────────────────────────────────────────────────

import type { QuestData } from "../quest.ts";
import {
  Reset,
  Bold,
  Dim,
  fg,
  box,
  sym,
  statusStyle,
  type AgentStatus,
} from "./theme.ts";

const write = (s: string) => process.stdout.write(s);

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";
const MOVE_TO = (row: number, col: number) => `\x1b[${row};${col}H`;

const WIDTH = 58;
const MAX_LOG_LINES = 6;
const MAX_QUESTION_LINES = 6;

// Total fixed height of the UI frame
// header(3) + status(5) + sep(1) + question_label(1) + question(MAX) + sep(1) + log_label(1) + logs(MAX) + footer(1)
const FRAME_HEIGHT = 3 + 5 + 1 + 1 + MAX_QUESTION_LINES + 1 + 1 + MAX_LOG_LINES + 1;

export interface LogEntry {
  text: string;
  color: string;
}

export class TUI {
  private quest: QuestData | null = null;
  private status: AgentStatus = "IDLE";
  private logs: LogEntry[] = [];
  private spinFrame = 0;
  private spinInterval: ReturnType<typeof setInterval> | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private startRow = -1; // The terminal row where our UI begins
  private initialized = false;

  // Stats
  private roundsCompleted = 0;
  private correctCount = 0;
  private wrongCount = 0;
  private errorCount = 0;

  constructor() {
    write(HIDE_CURSOR);

    // Spinner animation
    this.spinInterval = setInterval(() => {
      this.spinFrame = (this.spinFrame + 1) % sym.spin.length;
      if (this.status === "SOLVING" || this.status === "SUBMITTING") {
        this.render();
      }
    }, 80);

    process.on("exit", () => write(SHOW_CURSOR));
    process.on("SIGINT", () => {
      write(SHOW_CURSOR + "\n");
      process.exit(0);
    });
  }

  // ── Public API ───────────────────────────────────────────

  setQuest(quest: QuestData) {
    this.quest = quest;
    this.render();
  }

  setStatus(status: AgentStatus) {
    const prev = this.status;
    this.status = status;
    if (status === "CORRECT") this.correctCount++;
    if (status === "WRONG") this.wrongCount++;
    if (status === "ERROR") this.errorCount++;
    if (
      (status === "WAITING" || status === "CORRECT" || status === "ERROR") &&
      prev !== "WAITING"
    ) {
      this.roundsCompleted++;
    }
    this.render();
  }

  addLog(text: string, color: string = fg.white) {
    this.logs.push({ text, color });
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs = this.logs.slice(-MAX_LOG_LINES);
    }
    this.render();
  }

  clearLogs() {
    this.logs = [];
  }

  startCountdown() {
    this.stopCountdown();
    this.countdownInterval = setInterval(() => {
      this.render();
    }, 1000);
  }

  stopCountdown() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  destroy() {
    this.stopCountdown();
    if (this.spinInterval) {
      clearInterval(this.spinInterval);
      this.spinInterval = null;
    }
    write(SHOW_CURSOR);
  }

  // ── Rendering ────────────────────────────────────────────

  private init() {
    if (this.initialized) return;
    this.initialized = true;

    // Print enough blank lines to reserve space, then figure out our start row
    write("\n".repeat(FRAME_HEIGHT));
    // Query: We can't easily get cursor position in all terminals,
    // so we use the alternate screen buffer approach instead.
    // Actually, let's just use a simpler method: move cursor up by FRAME_HEIGHT
    // and mark that as our start position. We'll use absolute row 1 after clearing.
    write("\x1b[2J"); // Clear entire screen
    write(MOVE_TO(1, 1)); // Move to top-left
    this.startRow = 1;
  }

  render() {
    this.init();

    const lines: string[] = [];

    // ── Header ──
    lines.push(this.line("top"));
    lines.push(this.row(`${sym.crystal}  ${Bold}${fg.brightMagenta}NARA QUEST AGENT${Reset}`));
    lines.push(this.line("mid"));

    // ── Status Block ──
    const st = statusStyle(this.status);
    const spinner =
      this.status === "SOLVING" || this.status === "SUBMITTING"
        ? ` ${fg.cyan}${sym.spin[this.spinFrame]}${Reset}`
        : "";

    const roundStr = this.quest
      ? `${Bold}#${this.quest.round}${Reset}`
      : `${Dim}—${Reset}`;

    lines.push(this.row(`${Dim}Round${Reset}    ${roundStr}`));
    lines.push(this.row(`${Dim}Status${Reset}   ${st.color}${Bold}${st.symbol} ${st.label}${Reset}${spinner}`));
    lines.push(this.row(`${Dim}Time${Reset}     ${this.timeStr()}`));
    lines.push(
      this.row(
        `${Dim}Stats${Reset}    ${fg.green}${this.correctCount}${sym.check}${Reset}  ${fg.red}${this.wrongCount}${sym.cross}${Reset}  ${fg.yellow}${this.errorCount}${sym.warn}${Reset}  ${Dim}(${this.roundsCompleted} rounds)${Reset}`,
      ),
    );
    // Difficulty bar
    const diff = this.quest ? this.quest.difficulty : 0;
    lines.push(this.row(`${Dim}Diff${Reset}     ${this.difficultyBar(diff)}`));
    lines.push(this.line("mid"));

    // ── Question Block ──
    lines.push(this.row(`${Bold}${fg.brightWhite}Question${Reset}`));
    const questionLines: string[] = [];
    if (this.quest?.question) {
      const wrapped = this.wordWrap(this.quest.question, WIDTH - 8);
      for (const wl of wrapped) {
        questionLines.push(this.row(`  ${fg.white}${wl}${Reset}`));
      }
    } else {
      questionLines.push(this.row(`  ${Dim}Waiting for quest...${Reset}`));
    }
    // Pad to fixed height
    while (questionLines.length < MAX_QUESTION_LINES) {
      questionLines.push(this.row(""));
    }
    lines.push(...questionLines.slice(0, MAX_QUESTION_LINES));

    lines.push(this.line("mid"));

    // ── Activity Log ──
    lines.push(this.row(`${Bold}${fg.brightWhite}Activity${Reset}`));
    const logLines: string[] = [];
    for (const entry of this.logs) {
      const truncated = this.truncate(entry.text, WIDTH - 10);
      logLines.push(this.row(`  ${entry.color}${sym.arrow} ${truncated}${Reset}`));
    }
    while (logLines.length < MAX_LOG_LINES) {
      logLines.push(this.row(""));
    }
    lines.push(...logLines.slice(0, MAX_LOG_LINES));

    lines.push(this.line("bottom"));

    // ── Write to terminal ──
    // Move cursor to start position, then write each line clearing the old content
    write(MOVE_TO(this.startRow, 1));
    for (const l of lines) {
      write(`${CLEAR_LINE}${l}\n`);
    }
  }

  // ── Drawing Primitives ───────────────────────────────────

  private line(type: "top" | "mid" | "bottom"): string {
    const bar = box.horizontal.repeat(WIDTH - 2);
    const c = `${Dim}${fg.brightBlack}`;
    switch (type) {
      case "top":
        return `  ${c}${box.topLeft}${bar}${box.topRight}${Reset}`;
      case "mid":
        return `  ${c}${box.teeLeft}${bar}${box.teeRight}${Reset}`;
      case "bottom":
        return `  ${c}${box.bottomLeft}${bar}${box.bottomRight}${Reset}`;
    }
  }

  private row(content: string): string {
    const visible = this.stripAnsi(content);
    const innerWidth = WIDTH - 4;
    const pad = Math.max(0, innerWidth - visible.length);
    const c = `${Dim}${fg.brightBlack}`;
    return `  ${c}${box.vertical}${Reset} ${content}${" ".repeat(pad)} ${c}${box.vertical}${Reset}`;
  }

  private stripAnsi(str: string): string {
    return str
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/[\u{1F300}-\u{1F9FF}]/gu, "  ");
  }

  private truncate(str: string, maxLen: number): string {
    const visible = this.stripAnsi(str);
    if (visible.length <= maxLen) return str;
    // Find how many raw chars to keep
    let visCount = 0;
    let rawIdx = 0;
    const ansiRegex = /\x1b\[[0-9;]*m/g;
    let cleaned = str;
    // Simple approach: just strip and cut
    if (visible.length > maxLen) {
      cleaned = visible.slice(0, maxLen - 1) + "…";
    }
    return cleaned;
  }

  private wordWrap(text: string, maxWidth: number): string[] {
    const result: string[] = [];
    for (const rawLine of text.split("\n")) {
      if (rawLine.length <= maxWidth) {
        result.push(rawLine);
        continue;
      }
      const words = rawLine.split(" ");
      let current = "";
      for (const word of words) {
        if (current.length + word.length + 1 > maxWidth) {
          result.push(current);
          current = word;
        } else {
          current = current ? `${current} ${word}` : word;
        }
      }
      if (current) result.push(current);
    }
    return result;
  }

  private timeStr(): string {
    if (!this.quest) return `${Dim}—${Reset}`;

    const deadlineMs = new Date(this.quest.deadline).getTime();
    const remaining = deadlineMs - Date.now();

    if (remaining <= 0) return `${fg.red}${Bold}EXPIRED${Reset}`;

    const totalSec = Math.ceil(remaining / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;

    let color = fg.green;
    if (totalSec <= 30) color = fg.red;
    else if (totalSec <= 60) color = fg.yellow;

    return `${color}${Bold}${min}m ${sec.toString().padStart(2, "0")}s${Reset} ${Dim}remaining${Reset}`;
  }

  private difficultyBar(level: number): string {
    const max = 10;
    const filled = Math.min(level, max);
    let color = fg.green;
    if (filled >= 7) color = fg.red;
    else if (filled >= 4) color = fg.yellow;

    return `${color}${"█".repeat(filled)}${Dim}${"░".repeat(max - filled)}${Reset} ${Dim}${level}/${max}${Reset}`;
  }
}
