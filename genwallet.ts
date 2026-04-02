import { $ } from "bun";
import fs from "fs";

const max_create = 5;
const prefix = "nyanpasu";
const currentPath = __dirname;

if (!fs.existsSync(`${currentPath}/wallets`)) {
    fs.mkdirSync(`${currentPath}/wallets`)
}

if (!fs.existsSync(`${currentPath}/phrases`)) {
    fs.mkdirSync(`${currentPath}/phrases`)
}

for (let i = 0; i < max_create; i++) {
    const output = await $`bunx naracli wallet create -o ${currentPath}/wallets/${prefix}-${i}.json`
    fs.writeFileSync(`${currentPath}/phrases/${prefix}-${i}.txt`, output.stdout)
}