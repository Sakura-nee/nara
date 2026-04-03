// ─────────────────────────────────────────────────────────────
// Agent Tools — Quest answer submission tool
// ─────────────────────────────────────────────────────────────

import type { ToolRegistry } from "ciel-sdk";
import type { Quest, QuestSnapshot } from "../quest.ts";
import { generateProof, submitAnswerViaRelay } from "nara-sdk";
import { z } from "zod";

export interface WalletQuest {
  label: string;
  quest: Quest;
}

export interface ToolCallbacks {
  onProving: (answer: string, walletCount: number) => void;
  onSubmitting: (walletCount: number) => void;
  onTimings: (proveMs: number, submitMs: number) => void;
  onWalletTiming: (walletLabel: string, phase: "prove" | "submit", ms: number, message: string) => void;
  onResults: (
    outcome: "correct" | "partial" | "wrong" | "error",
    correct: number,
    total: number,
    reward?: string,
  ) => void;
  onAbort: () => void;
  markRoundProcessed: () => void;
  getActiveSnapshot: () => QuestSnapshot | null;
}

interface SubmitBatchResult {
  success: boolean;
  message: string;
  raw: string;
  txHash?: string;
  walletIndex: number;
}

interface SuccessfulSubmitBatchResult extends SubmitBatchResult {
  success: true;
  txHash: string;
}

/** Extract reward amount from messages like "Congratulations! Reward received: 0.327" */
function extractReward(message: string): string | undefined {
  const match = message.match(/Reward received:\s*([\d.]+)/);
  return match?.[1];
}

function isWrongAnswerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /assert failed|wrong answer|constraint|witness|error in template/i.test(message);
}

function isFulfilled<T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> {
  return result.status === "fulfilled";
}

function hasTxHash(result: SubmitBatchResult): result is SuccessfulSubmitBatchResult {
  return result.success && typeof result.txHash === "string";
}

const QUEST_RELAY_URL = "https://quest-api.nara.build/";
const RELAY_SUBMIT_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
      callbacks.onProving(answer, wallets.length);
      const snapshot = callbacks.getActiveSnapshot();
      if (!snapshot) {
        return "No active quest snapshot available. Waiting for sync.";
      }
      const quest = snapshot.quest;

      if (!quest.active) {
        return "No active quest at the moment";
      }
      if (quest.expired) {
        return "Quest has expired";
      }
      if (quest.remainingSlots <= 0) {
        return "Correct answer, but no reward — all reward slots have been claimed";
      }
      if (snapshot.stakeRequired) {
        return `Quest requires stake`;
      }

      const proveStartedAt = Date.now();
      const proved = await Promise.allSettled(
        wallets.map(async ({ label, quest: walletQuest }) => {
          const startedAt = Date.now();
          const keypair = await walletQuest.getKeypair();

          try {
            const proof = await generateProof(
              answer,
              quest.answerHash,
              keypair.publicKey,
              quest.round,
            );

            callbacks.onWalletTiming(label, "prove", Date.now() - startedAt, "ok");
            return {
              success: true as const,
              proof,
              keypair,
            };
          } catch (error: any) {
            const message = isWrongAnswerError(error)
              ? "Wrong answer"
              : `ZK proof generation failed: ${error?.message ?? String(error)}`;
            callbacks.onWalletTiming(label, "prove", Date.now() - startedAt, message);
            return {
              success: false as const,
              message,
            };
          }
        }),
      );
      const proveMs = Date.now() - proveStartedAt;

      callbacks.onSubmitting(wallets.length);

      const submitStartedAt = Date.now();
      const submitJobs: Promise<SubmitBatchResult>[] = proved.map((result, index) => {
        const wallet = wallets[index]!;

        if (result.status !== "fulfilled") {
          return Promise.resolve<SubmitBatchResult>({
            success: false,
            message: result.reason instanceof Error ? result.reason.message : String(result.reason),
            raw: result.reason instanceof Error ? result.reason.message : String(result.reason),
            walletIndex: index,
          });
        }

        const provedWallet = result.value;
        if (!provedWallet.success) {
          return Promise.resolve<SubmitBatchResult>({
            success: false,
            message: provedWallet.message,
            raw: provedWallet.message,
            walletIndex: index,
          });
        }

        return (async (): Promise<SubmitBatchResult> => {
          const startedAt = Date.now();
          try {
            const relayResult = await withTimeout(
              submitAnswerViaRelay(
                QUEST_RELAY_URL,
                provedWallet.keypair.publicKey,
                provedWallet.proof.hex,
                "claude",
                "claude-sonnet-4.6"
              ),
              RELAY_SUBMIT_TIMEOUT_MS,
              `Relay submit for ${wallet.label}`,
            );
            callbacks.onWalletTiming(wallet.label, "submit", Date.now() - startedAt, "ok");
            return {
              success: true,
              message: "Answer submitted",
              raw: `Answer submitted\nTransaction: ${relayResult.txHash}`,
              txHash: relayResult.txHash,
              walletIndex: index,
            };
          } catch (error: any) {
            const message = error?.message ?? String(error);
            callbacks.onWalletTiming(wallet.label, "submit", Date.now() - startedAt, message);
            return {
              success: false,
              message,
              raw: message,
              walletIndex: index,
            };
          }
        })();
      });

      const settled = await Promise.allSettled(submitJobs);
      const submitMs = Date.now() - submitStartedAt;
      callbacks.onTimings(proveMs, submitMs);

      // Only look at fulfilled results to determine wrong answer
      const fulfilled = settled
        .filter(isFulfilled)
        .map((r) => r.value);

      const wrongAnswers = fulfilled.filter((r) =>
        r.message?.includes("Wrong answer"),
      );
      const correct = fulfilled.filter((r) => r.success).length;
      const allWrong = fulfilled.length > 0 && wrongAnswers.length === fulfilled.length;
      const outcome =
        correct === wallets.length
          ? "correct"
          : correct > 0
            ? "partial"
            : allWrong
              ? "wrong"
              : "error";

      let reward: string | undefined;
      const rewardedSubmissions = fulfilled.filter(hasTxHash);
      if (rewardedSubmissions.length > 0) {
        const rewardChecks = await Promise.allSettled(
          rewardedSubmissions.map(async (submission) => {
            const walletQuest = wallets[submission.walletIndex]!.quest;
            const rewardInfo = await walletQuest.parseReward(submission.txHash);
            return rewardInfo.rewarded ? rewardInfo.rewardNso : 0;
          }),
        );

        const totalReward = rewardChecks.reduce((sum, result) => {
          if (result.status === "fulfilled") {
            return sum + result.value;
          }
          return sum;
        }, 0);

        if (totalReward > 0) {
          reward = totalReward.toString();
        } else {
          reward = fulfilled
            .map((r) => extractReward(r.message))
            .find((value) => value !== undefined);
        }
      }

      callbacks.onResults(outcome, correct, wallets.length, reward);

      // Retry only if every fulfilled result was explicitly "Wrong answer"
      // (relay errors, stake errors, etc. are ignored — don't block progress)
      if (allWrong) {
        return wrongAnswers[0]!.message; // signal agent to try a different answer
      }

      // Correct answer (or all errored out) — move on
      callbacks.markRoundProcessed();
      callbacks.onAbort();

      return "Round complete. Waiting for next quest.";
    },
  });
}
