import type { ExtractResult } from "./001-source-extract";

import { readdir, readFile, exists } from "fs/promises";
import { basename, join } from "path";
import { formatAnthropicPrompt } from "./common";
import Anthropic from "@anthropic-ai/sdk";
import { writeFile } from "fs/promises";
import { mkdir } from "fs/promises";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function main() {
  const extractsDir = join(process.cwd(), "results/001-source-extract");
  const files = await readdir(extractsDir);
  const regexPrompt = await readFile(
    join(process.cwd(), "./src/002-pattern-generate.txt"),
    "utf-8"
  );

  // Ensure results directory exists
  const resultsDir = join(process.cwd(), "results/002-pattern-generate");
  try {
    await mkdir(resultsDir, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore the error
  }

  const extracts: ExtractResult[] = [];

  let resultCounter = 0;

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    // Save individual result file
    const resultFilename = `${basename(file)}.txt`;
    if (await exists(join(resultsDir, resultFilename))) {
      console.log(`⏭️ Skipping ${resultFilename} - already exists`);
      continue;
    }

    const content = await readFile(join(extractsDir, file), "utf-8");
    const extract = JSON.parse(content) as ExtractResult;

    const process = extract.source.content.match(/process (\w+)/)?.[1];

    const task = `
<file>${extract.source.file}</file>
<process>${process}</process>
<source>
${extract.source.content}
</source>
<range>Lines ${extract.source.start_line}:${extract.source.end_line}</range>
${extract.response}
`;

    const prompt = formatAnthropicPrompt(regexPrompt, { task });

    const response = await anthropic.messages.create(prompt);

    // Create result object with all metadata
    const result = `${task} ${(response.content[0] as any)?.text || ""}`;

    await writeFile(join(resultsDir, resultFilename), result);

    console.log(`✅ Saved result ${resultCounter} to ${resultFilename}`);
    console.log(
      `📊 Response length: ${
        ((response.content[0] as any)?.text || "").length
      } chars`
    );
    console.log("---");
    resultCounter++;
  }
  return extracts;
}

main().catch(console.error);
