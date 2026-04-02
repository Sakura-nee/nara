// ─────────────────────────────────────────────────────────────
// Agent Tools — Quest answer submission tool
// ─────────────────────────────────────────────────────────────

import type { ToolRegistry } from "ciel-sdk";
import type { Quest } from "../quest.ts";
import pLimit from "p-limit";
import { z } from "zod";
import { MODEL } from "./config.ts";

export interface WalletQuest {
  label: string;
  quest: Quest;
}

export interface ToolCallbacks {
  onSubmitting: (answer: string, walletCount: number) => void;
  onResults: (correct: number, total: number, reward?: string) => void;
  onAbort: () => void;
  markRoundProcessed: () => void;
}

const SUBMIT_CONCURRENCY = 5;

/** Extract reward amount from messages like "Congratulations! Reward received: 0.327" */
function extractReward(message: string): string | undefined {
  const match = message.match(/Reward received:\s*([\d.]+)/);
  return match?.[1];
}

export function registerTools(
  registry: ToolRegistry,
  wallets: WalletQuest[],
  callbacks: ToolCallbacks,
) {
  registry.register({
    name: "submit_answer",
    description: "Submit an answer to the current quest",
    parameters: z.object({
      answer: z
        .string()
        .describe(
          "Exact answer to the quest. DO NOT ADD ANY EXTRA TEXT. JUST THE ANSWER.",
        ),
    }),
    execute: async ({ answer }: { answer: string }) => {
      callbacks.onSubmitting(answer, wallets.length);

      // Limit concurrent submissions so large wallet batches do not overwhelm
      // the relay/API while still preserving partial success behavior.
      const limit = pLimit(Math.min(SUBMIT_CONCURRENCY, wallets.length));
      const settled = await Promise.allSettled(
        wallets.map(({ quest }) =>
          limit(() =>
            quest.answer(answer, { model: MODEL ? MODEL : undefined }),
          ),
        ),
      );

      // Only look at fulfilled results to determine wrong answer
      const fulfilled = settled
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof wallets[0]["quest"]["answer"]>>> =>
          r.status === "fulfilled",
        )
        .map((r) => r.value);

      const wrongAnswers = fulfilled.filter((r) =>
        r.message?.includes("Wrong answer"),
      );
      const correct = fulfilled.length - wrongAnswers.length;

      // Extract reward from the first rewarded wallet (just show one)
      const reward = fulfilled
        .map((r) => extractReward(r.message))
        .find((r) => r !== undefined);

      callbacks.onResults(correct, wallets.length, reward);

      // Retry only if every fulfilled result was explicitly "Wrong answer"
      // (relay errors, stake errors, etc. are ignored — don't block progress)
      if (fulfilled.length > 0 && wrongAnswers.length === fulfilled.length) {
        return wrongAnswers[0]!.message; // signal agent to try a different answer
      }

      // Correct answer (or all errored out) — move on
      callbacks.markRoundProcessed();
      callbacks.onAbort();

      return "Round complete. Waiting for next quest.";
    },
  });
}
