// ─────────────────────────────────────────────────────────────
// Agent Runner — Observer + Main Agent Loop
// ─────────────────────────────────────────────────────────────

import { Agent, ToolRegistry } from "ciel-sdk";
import { Quest, type QuestData } from "../quest.ts";
import { TUI } from "../tui/renderer.ts";
import { fg } from "../tui/theme.ts";
import { registerTools, type WalletQuest } from "./tools.ts";
import {
  AGENT_CONFIG,
  SYSTEM_PROMPT,
  MAX_ROUND_RETRIES,
  POLL_AGGRESSIVE,
  POLL_MODERATE,
  POLL_NORMAL,
  POLL_DEADLINE_THRESHOLD,
} from "./config.ts";

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
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

  // Use first wallet to poll quest data (they all see the same quest)
  const observerQuest = wallets[0]!.quest;

  const registry = new ToolRegistry();

  let abortController = new AbortController();
  let activeQuest: QuestData | null = null;
  let lastProcessedRound: string | null = null;
  let isWaitingForNextRound = false;

  const walletLabels = wallets.map((w) => w.label).join(", ");
  tui.addLog(`Wallets: ${walletLabels}`, fg.brightBlack);

  // ── Register Tools (wired to TUI) ─────────────────────────

  registerTools(registry, wallets, {
    onSubmitting(answer, walletCount) {
      tui.setStatus("SUBMITTING");
      tui.addLog(`Submitting: ${answer} (${walletCount} wallets)`, fg.yellow);
    },
    onResults(correct, total, reward) {
      const rewardStr = reward ? ` (+${reward})` : "";
      if (correct === total) {
        tui.setStatus("CORRECT");
        tui.addLog(`✓ Correct — ${correct}/${total} wallets${rewardStr}`, fg.brightGreen);
      } else if (correct > 0) {
        tui.setStatus("CORRECT");
        tui.addLog(`⚡ Partial — ${correct}/${total} wallets${rewardStr}`, fg.green);
      } else {
        tui.setStatus("ERROR");
        tui.addLog(`✗ All failed — 0/${total} wallets`, fg.brightRed);
      }
    },
    onAbort() {
      isWaitingForNextRound = true;
      abortController.abort();
    },
    markRoundProcessed() {
      if (activeQuest) {
        lastProcessedRound = activeQuest.round;
      }
    },
  });


  // ── Create Agent ───────────────────────────────────────────

  const agent = new Agent({
    baseURL: AGENT_CONFIG.baseURL,
    apiKey: AGENT_CONFIG.apiKey,
    tools: registry,
    maxIterations: AGENT_CONFIG.maxIterations,
    onContent(_delta) {
      // Suppressed — we don't show raw content in the TUI
    },
    onReasoning(_delta) {
      // Suppressed — we don't show reasoning in the TUI
    },
    onToolCall(toolCall) {
      tui.addLog(`Calling: ${toolCall.function.name}`, fg.cyan);
    },
    onToolResult(_toolCall, _result) {
      // Result is already handled by tool callbacks
    },
  });

  // ── Background Observer ────────────────────────────────────

  async function startObserver() {
    tui.addLog("Observer started", fg.brightBlack);

    while (true) {
      try {
        const tempQuest = await observerQuest.get();

        if (!activeQuest || tempQuest.round !== activeQuest.round) {
          activeQuest = tempQuest;
          isWaitingForNextRound = false;

          tui.clearLogs();
          tui.setQuest(activeQuest);
          tui.addLog(`New round detected: #${activeQuest.round}`, fg.magenta);
          tui.addLog(`Wallets: ${walletLabels}`, fg.brightBlack);
          tui.startCountdown();

          // Abort the running agent so main instantly picks up the new quest
          abortController.abort();
        }

        // Dynamic polling speed
        const deadlineMs = new Date(tempQuest.deadline).getTime();
        const remaining = deadlineMs - Date.now();

        if (remaining > 0 && remaining <= POLL_DEADLINE_THRESHOLD) {
          await sleep(POLL_AGGRESSIVE);
        } else if (remaining <= 0) {
          await sleep(POLL_MODERATE);
        } else {
          await sleep(POLL_NORMAL);
        }
      } catch {
        await sleep(POLL_MODERATE);
      }
    }
  }

  // ── Main Agent Loop ────────────────────────────────────────

  async function mainLoop() {
    // Wait for observer to fetch the first quest
    while (!activeQuest) {
      await sleep(100);
    }

    let roundRetries = 0;
    let currentRetryRound: string | null = null;

    let waitingLogged = false;

    while (true) {
      try {
        // If we already finished this round, idle until observer wakes us
        if (activeQuest && activeQuest.round === lastProcessedRound) {
          isWaitingForNextRound = true;
        }

        if (isWaitingForNextRound) {
          if (!waitingLogged) {
            tui.setStatus("WAITING");
            tui.addLog("Waiting for next round...", fg.yellow);
            waitingLogged = true;
          }
          // Use abort-aware sleep so observer can wake us instantly
          await sleep(10_000, abortController.signal);
          continue;
        }

        // Reset waiting flag when we start a new round
        waitingLogged = false;

        // Track retries per round
        if (currentRetryRound !== activeQuest.round) {
          currentRetryRound = activeQuest.round;
          roundRetries = 0;
        }

        // If we've exhausted retries on this round, skip it
        if (roundRetries >= MAX_ROUND_RETRIES) {
          tui.addLog(
            `Skipping round #${activeQuest.round} after ${roundRetries} failed attempts`,
            fg.brightRed,
          );
          lastProcessedRound = activeQuest.round;
          isWaitingForNextRound = true;
          continue;
        }

        // Fresh quest — go!
        abortController = new AbortController();
        tui.setStatus("SOLVING");
        tui.addLog(
          roundRetries > 0
            ? `Retrying... (attempt ${roundRetries + 1}/${MAX_ROUND_RETRIES})`
            : "Agent thinking...",
          fg.cyan,
        );

        await agent.run({
          model: AGENT_CONFIG.model,
          thinking: AGENT_CONFIG.thinking,
          thinking_params: AGENT_CONFIG.thinking_params,
          signal: abortController.signal,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `Question: ${activeQuest.question}` },
          ],
        });

        // Agent finished naturally (no abort) — mark round done
        if (activeQuest) {
          lastProcessedRound = activeQuest.round;
          isWaitingForNextRound = true;
        }
      } catch (error: any) {
        if (error.name === "AbortError") {
          // Either tool aborted (answer submitted) or observer detected new round
          tui.addLog("Process interrupted. Syncing...", fg.brightBlack);
        } else {
          // Empty completion, API error, etc. — count as a retry
          roundRetries++;
          tui.setStatus("ERROR");
          tui.addLog(
            `${error.message?.slice(0, 50) || "Unknown error"} (${roundRetries}/${MAX_ROUND_RETRIES})`,
            fg.brightRed,
          );
          await sleep(2000);
        }
      }
    }
  }

  // ── Start ──────────────────────────────────────────────────

  tui.addLog("Nara Quest Agent starting...", fg.brightMagenta);

  // Fire and forget observer, then run main loop
  startObserver();
  await mainLoop();
}
