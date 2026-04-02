import { parseArgs } from "util";
import { glob } from "glob";
import { startAgent } from "./src/agent/runner.ts";

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

if (walletsGlob) {
  walletPaths = await glob(walletsGlob, { cwd: process.cwd() });
  if (walletPaths.length === 0) {
    console.error(`No wallet files found matching: ${walletsGlob}`);
    process.exit(1);
  }
  walletPaths.sort(); // deterministic order
} else if (walletSingle) {
  walletPaths = [walletSingle];
}

if (walletPaths.length > 1) {
  const wallets = walletPaths.map((w) => ({ wallet: w }));
  startAgent({ wallets });
} else {
  startAgent({
    wallet: walletPaths[0],
    session: values.session as string | undefined,
  });
}