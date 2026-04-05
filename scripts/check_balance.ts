import { DEFAULT_RPC_URL } from "nara-sdk";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { parseArgs } from "util";
import { glob } from "glob";

const { values } = parseArgs({
    args: Bun.argv,
    options: {
        wallets: {
            type: "string",
        },
        session: {
            type: "string",
        },
        // Legacy single-wallet support
        wallet: {
            type: "string",
        },
    },
    strict: false,
    allowPositionals: true,
});

// --wallets accepts glob pattern, e.g. --wallets "wallets/*.json"
const walletsGlob = values.wallets as string | undefined;
const walletSingle = values.wallet as string | undefined;

let walletPaths: string[] = [];

async function getBalance(key: Keypair): Promise<{ lamports: number; sol: number }> {
    try {
        const balance = await connection.getBalance(key.publicKey);
        return { lamports: balance, sol: balance / LAMPORTS_PER_SOL };
    } catch (error: any) {
        return { lamports: 0, sol: 0 };
    }
}

function loadWallet(configuredPath: string): Keypair {
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
        throw new Error(`${configuredPath}: ${error.message}`);
    }
}

if (walletsGlob) {
    walletPaths = await glob(walletsGlob, { cwd: process.cwd() });
    if (walletPaths.length === 0) {
        console.error(`No wallet files found matching: ${walletsGlob}`);
        process.exit(1);
    }
    walletPaths.sort(); // deterministic order
} else if (walletSingle) {
    walletPaths = [walletSingle];
} else {
    console.error("No wallet files found matching: " + walletsGlob);
    process.exit(1);
}

const connection = new Connection(DEFAULT_RPC_URL, "confirmed");
Promise.all(walletPaths.map(async (walletPath) => {
    const wallet = loadWallet(walletPath);
    const balance = await getBalance(wallet);
    console.log(`${wallet.publicKey.toBase58()}: `, balance.sol);
}));