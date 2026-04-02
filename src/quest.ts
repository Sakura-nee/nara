import { $ } from "bun";
import fs from "fs"

export interface QuestData {
  round: string;
  question: string;
  difficulty: number;
  rewardPerWinner: string;
  totalReward: string;
  rewardSlots: string;
  remainingRewardSlots: number;
  deadline: string;
  timeRemaining: string;
  expired: boolean;
  stakeRequired: boolean;
  stakeRequirement: string;
  stakeHigh: string;
  stakeLow: string;
  avgParticipantStake: string;
  freeCredits: number;
}

export interface AnswerResult {
  success: boolean;
  message: string;
  raw: string;
}

export interface QuestOptions {
  wallet?: string;
  session?: string;
}

export class Quest {
  constructor(private readonly options?: QuestOptions) { }

  private get baseArgs(): string[] {
    const args: string[] = [];
    if (this.options?.wallet) args.push("--wallet", this.options.wallet);
    if (this.options?.session) args.push("--session", this.options.session);
    return args;
  }

  /**
   * Fetches the current quest data.
   * Runs: `bunx naracli quest get --json`
   */
  async get(): Promise<QuestData> {
    const args = ["naracli", ...this.baseArgs, "quest", "get", "--json"];
    const proc = Bun.spawn(["bunx", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`Failed to parse quest data. Exit code: ${exitCode}\nStdout: ${stdout}\nStderr: ${stderr}`);
    }

    const result = stdout;

    // The output may contain non-JSON lines before the actual JSON.
    // Extract the JSON object from the output.
    const jsonStart = result.indexOf("{");
    const jsonEnd = result.lastIndexOf("}");

    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error(`Failed to parse quest data. Raw output:\n${result}`);
    }

    const jsonStr = result.slice(jsonStart, jsonEnd + 1);

    try {
      return JSON.parse(jsonStr) as QuestData;
    } catch {
      throw new Error(`Failed to parse quest JSON. Raw output:\n${result}`);
    }
  }

  /**
   * Submits an answer to the current quest.
   * Runs: `bunx naracli quest answer "<answer>" --relay --agent naracli --model deepseek-r1`
   */
  async answer(
    answer: string,
    options?: {
      relay?: boolean;
      agent?: string;
      model?: string;
    }
  ): Promise<AnswerResult> {
    const args: string[] = ["bunx", "naracli", ...this.baseArgs, "quest", "answer", answer];

    const relay = options?.relay ?? true;
    const agent = options?.agent ?? "naracli";
    const model = options?.model ?? "claude-opus-4.5";

    if (relay) args.push("--relay");
    if (agent) args.push("--agent", agent);
    if (model) args.push("--model", model);

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    const raw = (stdout + stderr).trim();

    // Wrong answer detection
    if (raw.includes("Wrong answer") || exitCode !== 0) {
      return {
        success: false,
        message: this.extractMessage(raw) ?? "Wrong answer",
        raw,
      };
    }

    // TODO: Handle correct answer response when known
    return {
      success: true,
      message: this.extractMessage(raw) ?? "Answer submitted",
      raw,
    };
  }

  /**
   * Extracts meaningful message from CLI output.
   * Strips emoji prefixes and info/error markers.
   */
  private extractMessage(output: string): string | null {
    const lines = output.split("\n").filter((l) => l.trim().length > 0);

    // Find the last meaningful line (usually the result)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();

      // Strip common prefixes: ℹ️, ❌, ✅, etc.
      const cleaned = line
        .replace(/^[ℹ️❌✅⚠️🔄]+\s*/, "")
        .replace(/^(Error|Info|Warning):\s*/i, "")
        .trim();

      if (cleaned.length > 0) {
        return cleaned;
      }
    }

    return null;
  }
}
