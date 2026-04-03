import { $ } from "bun";
import fs from "fs";

const max_create = 5;
const prefix = "nyanpasu";
const currentPath = __dirname;

const walllet_path = "./wallet2";
const phrase_path = "./phrase2";

if (!fs.existsSync(walllet_path)) {
    fs.mkdirSync(walllet_path)
}

if (!fs.existsSync(phrase_path)) {
    fs.mkdirSync(phrase_path)
}



for (let i = 0; i < max_create; i++) {
    const output = await $`bunx naracli wallet create -o ${currentPath}/${walllet_path}/${prefix}-${i}.json`
    fs.writeFileSync(`${currentPath}/${phrase_path}/${prefix}-${i}.txt`, output.stdout)
}