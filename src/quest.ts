import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Connection, Keypair } from "@solana/web3.js";
import {
  DEFAULT_RPC_URL,
  generateProof,
  getQuestConfig,
  getQuestInfo,
  parseQuestReward,
  submitAnswer,
  submitAnswerViaRelay,
  warmupSnarkjs,
} from "nara-sdk";

export interface QuestData {
  active: boolean;
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
  txHash?: string;
}

type QuestProofData = Awaited<ReturnType<typeof generateProof>>;

export type ProveResult =
  | {
    success: true;
    proof: QuestProofData;
    snapshot: QuestSnapshot;
  }
  | {
    success: false;
    message: string;
    raw: string;
  };

export interface QuestOptions {
  wallet?: string;
  session?: string;
}

interface GlobalConfig {
  rpc_url?: string;
  wallet?: string;
}

type NativeQuest = Awaited<ReturnType<typeof getQuestInfo>>;
type NativeQuestConfig = Awaited<ReturnType<typeof getQuestConfig>>;

export interface QuestSnapshot {
  quest: NativeQuest;
  questConfig: NativeQuestConfig;
  stakeRequired: boolean;
  data: QuestData;
}

const DEFAULT_QUEST_RELAY_URL = process.env.QUEST_RELAY_URL || "https://quest-api.nara.build/";
const CONFIG_DIR = join(homedir(), ".config", "nara");
const GLOBAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DEFAULT_WALLET_PATH = join(CONFIG_DIR, "id.json");
const QUEST_CONFIG_TTL_MS = 15_000;

const QUEST_ERRORS: Record<number, string> = {
  6001: "poolNotActive",
  6002: "deadlineExpired",
  6003: "invalidProof",
  6007: "alreadyAnswered",
  6011: "insufficientStakeBalance",
};

function loadGlobalConfig(): GlobalConfig {
  try {
    return JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")) as GlobalConfig;
  } catch {
    return {};
  }
}

function resolvePath(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

function formatStakeAmount(amount: number): string {
  return amount.toFixed(9).replace(/\.?0+$/, "");
}

function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return "expired";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function anchorErrorCode(err: any): string {
  const code = err?.error?.errorCode?.code;
  if (code) return code;
  const raw = err?.message ?? JSON.stringify(err) ?? "";
  const match = raw.match(/"Custom":(\d+)/);
  if (match) return QUEST_ERRORS[parseInt(match[1]!, 10)] ?? "";
  return "";
}

function getMessageFromSubmitError(err: any): string {
  const errCode = anchorErrorCode(err);
  if (errCode === "alreadyAnswered" || /already answered/i.test(err?.message ?? "")) {
    return "You have already answered this round";
  }
  if (errCode === "deadlineExpired" || /expired/i.test(err?.message ?? "")) {
    return "Quest has expired";
  }
  if (errCode === "invalidProof" || /invalid proof/i.test(err?.message ?? "")) {
    return "Wrong answer";
  }
  if (errCode === "poolNotActive" || /no active quest/i.test(err?.message ?? "")) {
    return "No active quest at the moment";
  }
  if (errCode === "insufficientStakeBalance" || /stake/i.test(err?.message ?? "")) {
    return "Quest requires stake";
  }
  return err?.message ?? String(err);
}

function createInactiveQuestData(): QuestData {
  return {
    active: false,
    round: "",
    question: "",
    difficulty: 0,
    rewardPerWinner: "0 NARA",
    totalReward: "0 NARA",
    rewardSlots: "0/0",
    remainingRewardSlots: 0,
    deadline: new Date(0).toISOString(),
    timeRemaining: "expired",
    expired: true,
    stakeRequired: false,
    stakeRequirement: "0 NARA",
    stakeHigh: "0 NARA",
    stakeLow: "0 NARA",
    avgParticipantStake: "0 NARA",
    freeCredits: 0,
  };
}

function buildQuestData(
  quest: NativeQuest,
  questConfig: NativeQuestConfig,
): QuestData {
  if (!quest.active) {
    return createInactiveQuestData();
  }

  const stakeRequired =
    quest.effectiveStakeRequirement > 0 &&
    quest.rewardCount >= questConfig.maxRewardCount;

  return {
    active: true,
    round: quest.round,
    question: quest.question,
    difficulty: quest.difficulty,
    rewardPerWinner: `${quest.rewardPerWinner} NARA`,
    totalReward: `${quest.totalReward} NARA`,
    rewardSlots: `${quest.winnerCount}/${quest.rewardCount}`,
    remainingRewardSlots: quest.remainingSlots,
    deadline: new Date(quest.deadline * 1000).toISOString(),
    timeRemaining: formatTimeRemaining(quest.timeRemaining),
    expired: quest.expired,
    stakeRequired,
    stakeRequirement: stakeRequired ? `${formatStakeAmount(quest.effectiveStakeRequirement)} NARA` : "0 NARA",
    stakeHigh: `${quest.stakeHigh} NARA`,
    stakeLow: `${quest.stakeLow} NARA`,
    avgParticipantStake: `${quest.avgParticipantStake} NARA`,
    freeCredits: 0,
  };
}

export class Quest {
  private static readonly questConfigCache = new Map<string, { data: NativeQuestConfig; fetchedAt: number }>();
  private static readonly questConfigInflight = new Map<string, Promise<NativeQuestConfig>>();
  private readonly connection: Connection;
  private readonly walletPromise: Promise<Keypair>;

  constructor(private readonly options?: QuestOptions) {
    const rpcUrl = loadGlobalConfig().rpc_url || DEFAULT_RPC_URL;
    this.connection = new Connection(rpcUrl, "confirmed");
    this.walletPromise = this.loadWallet();
  }

  private async loadWallet(): Promise<Keypair> {
    const configuredPath = this.options?.wallet
      ? resolvePath(this.options.wallet)
      : resolvePath(loadGlobalConfig().wallet || DEFAULT_WALLET_PATH);

    try {
      const data = JSON.parse(readFileSync(configuredPath, "utf-8")) as number[] | { secretKey?: number[] };
      if (Array.isArray(data)) {
        return Keypair.fromSecretKey(new Uint8Array(data));
      }
      if (Array.isArray(data.secretKey)) {
        return Keypair.fromSecretKey(new Uint8Array(data.secretKey));
      }
      throw new Error("Invalid wallet file format");
    } catch (error: any) {
      const prefix = this.options?.wallet ? `Failed to load wallet from ${configuredPath}` : "No wallet found";
      throw new Error(`${prefix}: ${error.message}`);
    }
  }

  private async getCachedQuestConfig(): Promise<NativeQuestConfig> {
    const cacheKey = this.connection.rpcEndpoint;
    const now = Date.now();
    const cached = Quest.questConfigCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < QUEST_CONFIG_TTL_MS) {
      return cached.data;
    }

    const inflight = Quest.questConfigInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const request = getQuestConfig(this.connection)
      .then((questConfig) => {
        Quest.questConfigCache.set(cacheKey, {
          data: questConfig,
          fetchedAt: Date.now(),
        });
        return questConfig;
      })
      .finally(() => {
        Quest.questConfigInflight.delete(cacheKey);
      });

    Quest.questConfigInflight.set(cacheKey, request);
    return request;
  }

  async getSnapshot(): Promise<QuestSnapshot> {
    const wallet = await this.walletPromise;
    const [quest, questConfig] = await Promise.all([
      getQuestInfo(this.connection, wallet),
      this.getCachedQuestConfig(),
    ]);

    const data = buildQuestData(quest, questConfig);

    return {
      quest,
      questConfig,
      stakeRequired: data.stakeRequired,
      data,
    };
  }

  async get(): Promise<QuestData> {
    const snapshot = await this.getSnapshot();
    return snapshot.data;
  }

  async getKeypair(): Promise<Keypair> {
    return this.walletPromise;
  }

  async parseReward(txHash: string) {
    return parseQuestReward(this.connection, txHash);
  }

  async answer(
    answer: string,
    options?: {
      relay?: boolean;
      agent?: string;
      model?: string;
      snapshot?: QuestSnapshot;
      verifyReward?: boolean;
    },
  ): Promise<AnswerResult> {
    const proveResult = await this.prove(answer, { snapshot: options?.snapshot });
    if (proveResult.success === false) {
      return proveResult;
    }

    return this.submitProof(proveResult.proof, {
      relay: options?.relay,
      agent: options?.agent,
      model: options?.model,
      snapshot: proveResult.snapshot,
      verifyReward: options?.verifyReward,
    });
  }

  async prove(
    answer: string,
    options?: { snapshot?: QuestSnapshot },
  ): Promise<ProveResult> {
    const wallet = await this.walletPromise;
    const snapshot = options?.snapshot ?? await this.getSnapshot();
    const { quest, questConfig } = snapshot;

    if (!quest.active) {
      return { success: false, message: "No active quest at the moment", raw: "No active quest at the moment" };
    }

    if (quest.expired) {
      return { success: false, message: "Quest has expired", raw: "Quest has expired" };
    }

    if (quest.remainingSlots <= 0) {
      return {
        success: false,
        message: "Correct answer, but no reward — all reward slots have been claimed",
        raw: "Correct answer, but no reward — all reward slots have been claimed",
      };
    }

    const stakeRequired =
      quest.effectiveStakeRequirement > 0 &&
      quest.rewardCount >= questConfig.maxRewardCount;

    if (stakeRequired) {
      return {
        success: false,
        message: `Quest requires stake (${formatStakeAmount(quest.effectiveStakeRequirement)} NARA)`,
        raw: `Quest requires stake (${formatStakeAmount(quest.effectiveStakeRequirement)} NARA)`,
      };
    }

    try {
      const proof = await generateProof(answer, quest.answerHash, wallet.publicKey, quest.round);
      return {
        success: true,
        proof,
        snapshot,
      };
    } catch (err: any) {
      const message = err?.message?.includes("Assert Failed") ? "Wrong answer" : `ZK proof generation failed: ${err?.message ?? String(err)}`;
      return { success: false, message, raw: message };
    }
  }

  async submitProof(
    proof: QuestProofData,
    options?: {
      relay?: boolean;
      agent?: string;
      model?: string;
      snapshot?: QuestSnapshot;
      verifyReward?: boolean;
    },
  ): Promise<AnswerResult> {
    const wallet = await this.walletPromise;
    const relay = options?.relay ?? true;
    const agent = options?.agent ?? "";
    const model = options?.model ?? "";
    const verifyReward = options?.verifyReward ?? false;
    const snapshot = options?.snapshot ?? await this.getSnapshot();
    const { quest } = snapshot;

    if (Math.floor(Date.now() / 1000) >= quest.deadline) {
      return { success: false, message: "Quest expired during proof generation", raw: "Quest expired during proof generation" };
    }

    try {
      const txSignature = relay
        ? (await submitAnswerViaRelay(DEFAULT_QUEST_RELAY_URL, wallet.publicKey, proof.hex, agent, model)).txHash
        : (await submitAnswer(this.connection, wallet, proof.solana, agent, model)).signature;

      if (!verifyReward) {
        const message = `Answer submitted`;
        return { success: true, message, raw: `${message}\nTransaction: ${txSignature}`, txHash: txSignature };
      }

      const reward = await parseQuestReward(this.connection, txSignature);
      if (reward.rewarded) {
        const message = `Congratulations! Reward received: ${reward.rewardNso} NARA (winner ${reward.winner})`;
        return { success: true, message, raw: `${message}\nTransaction: ${txSignature}`, txHash: txSignature };
      }

      const message = "Correct answer, but no reward — all reward slots have been claimed";
      return { success: true, message, raw: `${message}\nTransaction: ${txSignature}`, txHash: txSignature };
    } catch (err: any) {
      const message = getMessageFromSubmitError(err);
      return {
        success: false,
        message,
        raw: `${message}\n${err?.message ?? String(err)}`.trim(),
      };
    }
  }
}

export async function warmupZk(): Promise<void> {
  await warmupSnarkjs();
}
