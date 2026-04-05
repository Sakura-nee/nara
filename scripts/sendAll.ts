import { DEFAULT_RPC_URL } from "nara-sdk";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { glob } from "glob";
import { parseArgs } from "util";
import { readFileSync } from "node:fs";

const { values } = parseArgs({
    args: Bun.argv,
    options: {
        wallets: {
            type: "string",
        },
        to: {
            type: "string",
        },
    },
    strict: false,
    allowPositionals: true,
});

const walletsGlob = values.wallets as string | undefined;
const to = values.to as string | undefined;

if (!walletsGlob) {
    console.error("Please provide a wallet glob pattern");
    process.exit(1);
}

if (!to) {
    console.error("Please provide a recipient address");
    process.exit(1);
}

const walletPaths = await glob(walletsGlob, { cwd: process.cwd() });
if (walletPaths.length === 0) {
    console.error(`No wallet files found matching: ${walletsGlob}`);
    process.exit(1);
}

function isValidSolAddress(address: string): boolean {
    try {
        new PublicKey(address);
        return true;
    } catch {
        return false;
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

// fn
async function pollConfirmation(
    connection: Connection,
    signature: string,
    timeoutMs = 15000,
    intervalMs = 1000
): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const { value } = await connection.getSignatureStatuses([signature]);
        const status = value?.[0];
        if (status) {
            if (status.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
            }
            if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
                return;
            }
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error("Transaction confirmation timeout");
}

async function getFee(amount: number, wallet: Keypair, connection: Connection): Promise<number | null> {
    const dummy = Keypair.generate();
    const tx = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: dummy.publicKey,
            lamports: amount,
        })
    );

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    const fee = await connection.getFeeForMessage(tx.compileMessage());
    return fee.value;
}

async function sendTx(wallet: Keypair, to: PublicKey, connection: Connection) {
    const balance = await connection.getBalance(wallet.publicKey);
    const fee = await getFee(balance, wallet, connection);
    if (!fee) {
        console.error("Failed to get fee");
        return;
    }
    const tx = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: to,
            lamports: balance - fee,
        })
    );
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    if (tx instanceof VersionedTransaction) {
        tx.sign(wallet);

        const send = await connection.sendTransaction(tx, {
            maxRetries: 3,
        });

        console.log("From:", wallet.publicKey.toBase58());
        console.log("To:", to.toBase58());
        console.log("Amount:", balance - fee, " | ", (balance - fee) / LAMPORTS_PER_SOL, "NARA");

        console.log("Transaction sent:", send);
        await pollConfirmation(connection, send);
        return;
    } else {
        tx.sign(...[wallet]);
        const send = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
        });

        console.log("From:", wallet.publicKey.toBase58());
        console.log("To:", to.toBase58());
        console.log("Amount: ", (balance - fee) / LAMPORTS_PER_SOL, "NARA |", balance - fee, "lamports");

        console.log("Transaction sent:", send);
        await pollConfirmation(connection, send);
        return;
    }

    return;
}

if (isValidSolAddress(to)) {
    const connection = new Connection(DEFAULT_RPC_URL, "confirmed");
    for (const walletPath of walletPaths) {
        const wallet = loadWallet(walletPath);
        const balance = await connection.getBalance(wallet.publicKey);
        if (balance < 5000) {
            console.log("Wallet has less than 5000 lamports, skipping");
            continue;
        }

        const fee = await getFee(balance, wallet, connection) || 5000;
        await sendTx(wallet, new PublicKey(to), connection);
    };
} else {
    console.error("Please provide a valid recipient address");
    process.exit(1);
}