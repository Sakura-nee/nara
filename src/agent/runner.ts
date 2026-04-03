// ─────────────────────────────────────────────────────────────
// Agent Runner — Deadline-Anchored Quest Loop
// ─────────────────────────────────────────────────────────────

import { Agent, ToolRegistry } from "ciel-sdk";
import { Quest, type QuestData, type QuestSnapshot, warmupZk } from "../quest.ts";
import { TUI } from "../tui/renderer.ts";
import { fg } from "../tui/theme.ts";
import { registerTools, type WalletQuest } from "./tools.ts";
import {
  AGENT_CONFIG,
  SYSTEM_PROMPT,
  MAX_ROUND_RETRIES,
  POLL_MODERATE,
} from "./config.ts";

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export interface WalletConfig {
  wallet?: string;
  session?: string;
}

export async function startAgent(options?: {
  // Single wallet (legacy)
  wallet?: string;
  session?: string;
  // Multiple wallets
  wallets?: WalletConfig[];
}) {
  const tui = new TUI();

  // Build wallet list — support both single and multi-wallet
  let walletConfigs: WalletConfig[];
  if (options?.wallets && options.wallets.length > 0) {
    walletConfigs = options.wallets;
  } else {
    walletConfigs = [
      { wallet: options?.wallet, session: options?.session },
    ];
  }

  // One Quest instance per wallet for submitting answers
  const wallets: WalletQuest[] = walletConfigs.map((cfg, i) => {
    const label = cfg.wallet
      ? cfg.wallet.replace(/^.*\//, "").replace(/\.json$/, "")
      : `wallet${i + 1}`;
    return { label, quest: new Quest(cfg) };
  });

  // Use first wallet to fetch quest data (they all see the same quest)
  const readerQuest = wallets[0]!.quest;

  const registry = new ToolRegistry();

  let abortController = new AbortController();
  let activeSnapshot: QuestSnapshot | null = null;
  let lastToolOutcome: "correct" | "partial" | "wrong" | "error" | null = null;
  let roundCompleted = false;

  const walletLabels = wallets.map((w) => w.label).join(", ");
  tui.addLog(`Wallets: ${walletLabels}`, fg.brightBlack);

  // ── Register Tools (wired to TUI) ─────────────────────────

  registerTools(registry, wallets, {
    onProving(answer, walletCount) {
      tui.setStatus("SOLVING");
      tui.addLog(`Proving: ${answer} (${walletCount} wallets)`, fg.cyan);
    },
    onSubmitting(walletCount) {
      tui.setStatus("SUBMITTING");
      tui.addLog(`Submitting proofs (${walletCount} wallets)`, fg.yellow);
    },
    onTimings(proveMs, submitMs) {
      tui.addLog(`Prove batch: ${proveMs}ms`, fg.brightBlack);
      tui.addLog(`Submit batch: ${submitMs}ms`, fg.brightBlack);
    },
    onWalletTiming(walletLabel, phase, ms, message) {
      const shortMessage = message.length > 36 ? `${message.slice(0, 36)}...` : message;
      tui.addLog(`${walletLabel} ${phase} ${ms}ms: ${shortMessage}`, fg.brightBlack);
    },
    onResults(outcome, correct, total, reward) {
      lastToolOutcome = outcome;
      const rewardStr = reward ? ` (+${reward})` : "";
      if (outcome === "correct") {
        tui.setStatus("CORRECT");
        tui.addLog(`✓ Correct — ${correct}/${total} wallets${rewardStr}`, fg.brightGreen);
      } else if (outcome === "partial") {
        tui.setStatus("CORRECT");
        tui.addLog(`⚡ Partial — ${correct}/${total} wallets${rewardStr}`, fg.green);
      } else if (outcome === "wrong") {
        tui.setStatus("WRONG");
        tui.addLog("✗ Wrong answer — retrying...", fg.red);
      } else {
        tui.setStatus("ERROR");
        tui.addLog(`✗ All failed — 0/${total} wallets`, fg.brightRed);
      }
    },
    onAbort() {
      roundCompleted = true;
      abortController.abort();
    },
    markRoundProcessed() {
      roundCompleted = true;
    },
    getActiveSnapshot() {
      return activeSnapshot;
    },
  });

  // ── Create Agent ───────────────────────────────────────────

  const agent = new Agent({
    baseURL: AGENT_CONFIG.baseURL,
    apiKey: AGENT_CONFIG.apiKey,
    tools: registry,
    maxIterations: AGENT_CONFIG.maxIterations,
    onContent(_delta) {
      // Suppressed
    },
    onReasoning(_delta) {
      // Suppressed
    },
    onToolCall(toolCall) {
      tui.addLog(`Calling: ${toolCall.function.name}`, fg.cyan);
    },
    onToolResult(_toolCall, _result) {
      // Result is already handled by tool callbacks
    },
  });

  // ── Fetch Quest (with retry) ───────────────────────────────

  async function fetchQuest(): Promise<QuestSnapshot> {
    while (true) {
      try {
        return await readerQuest.getSnapshot();
      } catch (err: any) {
        tui.addLog(`Fetch error: ${err?.message?.slice(0, 50) ?? "unknown"}`, fg.brightRed);
        await sleep(POLL_MODERATE);
      }
    }
  }

  // ── Wait until deadline passes, then aggressively poll for next quest ──

  async function waitForNextQuest(currentDeadlineMs: number): Promise<QuestSnapshot> {
    const waitMs = Math.max(0, currentDeadlineMs - Date.now());

    if (waitMs > 0) {
      tui.setStatus("WAITING");
      tui.addLog(`Waiting ${Math.round(waitMs / 1000)}s for deadline...`, fg.yellow);
      tui.startCountdown();
      await sleep(waitMs);
    }

    // Deadline passed — poll aggressively until new round appears
    tui.addLog("Deadline passed, polling for next round...", fg.yellow);
    const snapshot = await fetchQuest();
    return snapshot;
  }

  // ── Main Loop ──────────────────────────────────────────────

  async function mainLoop() {
    let roundRetries = 0;
    let currentRound: string | null = null;

    // Initial fetch
    tui.setStatus("WAITING");
    tui.addLog("Fetching current quest...", fg.brightBlack);
    let snapshot = await fetchQuest();

    while (true) {
      const quest = snapshot.data;

      // ── Check if this is a new round ───────────────────────
      if (quest.round !== currentRound) {
        currentRound = quest.round;
        roundRetries = 0;
        lastToolOutcome = null;
        roundCompleted = false;

        tui.clearLogs();
        tui.setQuest(quest);
        tui.addLog(`New round: #${quest.round}`, fg.magenta);
        tui.addLog(`Wallets: ${walletLabels}`, fg.brightBlack);
        tui.startCountdown();
      }

      // ── Skip conditions ────────────────────────────────────
      const deadlineMs = new Date(quest.deadline).getTime();

      if (!quest.active) {
        tui.setStatus("WAITING");
        tui.addLog("No active quest — waiting for deadline...", fg.yellow);
        snapshot = await waitForNextQuest(deadlineMs);
        continue;
      }

      if (quest.remainingRewardSlots <= 0) {
        tui.setStatus("WAITING");
        tui.addLog(`No reward slots left — waiting for next round...`, fg.yellow);
        snapshot = await waitForNextQuest(deadlineMs);
        continue;
      }

      if (quest.stakeRequired) {
        tui.setStatus("WAITING");
        tui.addLog(`Stake required — waiting for next round...`, fg.yellow);
        snapshot = await waitForNextQuest(deadlineMs);
        continue;
      }

      if (quest.expired) {
        tui.setStatus("WAITING");
        tui.addLog(`Quest expired — polling for next round...`, fg.yellow);
        snapshot = await waitForNextQuest(deadlineMs);
        continue;
      }

      if (roundCompleted) {
        // Round already processed (correct/partial/error) — wait for next
        tui.setStatus("WAITING");
        tui.addLog(`Round #${quest.round} done — waiting for next...`, fg.yellow);
        snapshot = await waitForNextQuest(deadlineMs);
        continue;
      }

      if (roundRetries >= MAX_ROUND_RETRIES) {
        tui.addLog(
          `Max retries (${MAX_ROUND_RETRIES}) reached — waiting for next round...`,
          fg.brightRed,
        );
        snapshot = await waitForNextQuest(deadlineMs);
        continue;
      }

      // ── Run Agent ──────────────────────────────────────────
      abortController = new AbortController();
      activeSnapshot = snapshot;

      tui.setStatus("SOLVING");
      tui.addLog(
        roundRetries > 0
          ? `Retrying... (attempt ${roundRetries + 1}/${MAX_ROUND_RETRIES})`
          : "Agent thinking...",
        fg.cyan,
      );

      try {
        const result = await agent.run({
          model: AGENT_CONFIG.model,
          thinking: AGENT_CONFIG.thinking,
          thinking_params: AGENT_CONFIG.thinking_params,
          signal: abortController.signal,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `Question: ${quest.question}` },
          ],
        });

        if (roundCompleted) {
          // Tool already handled the round — re-fetch for the next
          snapshot = await waitForNextQuest(deadlineMs);
          continue;
        }

        // Agent returned without calling the tool
        roundRetries++;
        tui.setStatus("ERROR");
        tui.addLog(
          `${result.content?.trim().slice(0, 50) || "Agent stopped without submitting"} (${roundRetries}/${MAX_ROUND_RETRIES})`,
          fg.brightRed,
        );
        await sleep(500);

        // Re-fetch to keep snapshot fresh for retry
        const fresh = await fetchQuest();
        if (fresh.data.round !== currentRound) {
          snapshot = fresh;
        }
      } catch (error: any) {
        if (error.name === "AbortError") {
          // Tool aborted after submitting — re-fetch for next round
          tui.addLog("Submitted, waiting for next round...", fg.brightBlack);
          snapshot = await waitForNextQuest(deadlineMs);
        } else {
          roundRetries++;
          tui.setStatus("ERROR");
          tui.addLog(
            `${error.message?.slice(0, 50) || "Unknown error"} (${roundRetries}/${MAX_ROUND_RETRIES})`,
            fg.brightRed,
          );
          await sleep(500);

          // Re-fetch on error
          try {
            const fresh = await fetchQuest();
            if (fresh.data.round !== currentRound) {
              snapshot = fresh;
            }
          } catch {
            // keep current snapshot
          }
        }
      }

      // Wrong answer retry — keep same snapshot, don't re-fetch
      if (lastToolOutcome === "wrong" && roundRetries < MAX_ROUND_RETRIES) {
        tui.addLog(`Wrong answer, retrying with same quest...`, fg.red);
        await sleep(200);
        // Refresh snapshot in case quest state changed (deadline, slots, etc)
        try {
          const fresh = await fetchQuest();
          if (fresh.data.round === currentRound) {
            snapshot = fresh;
            activeSnapshot = fresh;
          }
        } catch {
          // keep current snapshot
        }
      }
    }
  }

  // ── Start ──────────────────────────────────────────────────

  tui.addLog("Nara Quest Agent starting...", fg.brightMagenta);
  tui.addLog("Warming up ZK...", fg.brightBlack);

  const zkWarmup = warmupZk()
    .then(() => {
      tui.addLog("ZK warmup complete", fg.brightBlack);
    })
    .catch((error: any) => {
      tui.addLog(
        `ZK warmup failed: ${error?.message ?? String(error)}`,
        fg.brightRed,
      );
    });

  await zkWarmup;
  await mainLoop();
}
