import { readdir, readFile, exists } from "fs/promises";
import { join } from "path";
import { extractXml, formatAnthropicPrompt } from "./common";
import Anthropic from "@anthropic-ai/sdk";
import { writeFile } from "fs/promises";
import { mkdir } from "fs/promises";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function main() {
  const inputDir = join(process.cwd(), "results/002-pattern-generate");
  const inputFiles = await readdir(inputDir);
  const promptTemplate = await readFile(
    join(process.cwd(), "./src/003-add-descriptions.txt"),
    "utf-8"
  );

  // Ensure results directory exists
  const resultsDir = join(process.cwd(), "results/003-add-descriptions");
  try {
    await mkdir(resultsDir, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore the error
  }

  for (const inputFile of inputFiles) {
    if (!inputFile.endsWith(".txt")) continue;
    const resultFilename = inputFile;
    if (await exists(join(resultsDir, resultFilename))) {
      console.log(`⏭️ Skipping ${resultFilename} - already exists`);
      continue;
    }

    const inputContent = await readFile(join(inputDir, inputFile), "utf8");
    const tags = extractXml(inputContent);

    const processName = tags.find((t) => t.name === "process")!.content;
    const source = tags.find((t) => t.name === "source")!.content;
    const task = `<process>${processName}</process>\n<source>${source}</source>`;
    const prompt = formatAnthropicPrompt(promptTemplate, { task });

    const response = await anthropic.messages.create(prompt);
    const responseContent = (response.content[0] as any)?.text || "";
    const result = `<process_description>${responseContent}</process_description>\n${inputContent}`;

    await writeFile(join(resultsDir, resultFilename), result);

    console.log(`✅ Saved ${resultFilename}`);
    console.log(`📊 Response length: ${responseContent.length} chars`);
  }
}

main().catch(console.error);
