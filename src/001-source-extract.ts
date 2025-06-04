import { readdir, readFile, stat, writeFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { formatAnthropicPrompt } from "./common";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function findProcessFiles(dir: string): Promise<string[]> {
  const processRegex = /process [A-Z]+_\w+ {/;
  const files: string[] = [];

  async function scan(currentDir: string): Promise<void> {
    try {
      for (const entry of await readdir(currentDir)) {
        const fullPath = join(currentDir, entry);
        const stats = await stat(fullPath);

        if (stats.isDirectory()) {
          await scan(fullPath);
        } else if (stats.isFile()) {
          try {
            const content = await readFile(fullPath, "utf-8");
            if (processRegex.test(content)) {
              files.push(fullPath);
            }
          } catch {} // Skip unreadable files
        }
      }
    } catch {} // Skip unreadable directories
  }

  await scan(dir);
  return files;
}

export interface ExtractResult {
  id: number;
  timestamp: string;
  source: {
    file: string;
    start_line: number;
    end_line: number;
    content: string;
  };
  response: string;
}

async function main() {
  const promptContent = {
    extract: await readFile(
      join(process.cwd(), "./src/001-source-extract.txt"),
      "utf-8"
    ),
  };

  const files = await findProcessFiles(join(process.cwd(), "../modules"));
  console.log(`Found ${files.length} files with process definitions`);

  if (files.length === 0) return;

  const allResults: any[] = [];
  let resultCounter = 0;

  // Ensure results directory exists
  const resultsDir = join(process.cwd(), "results/001-source-extract");
  try {
    await mkdir(resultsDir, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore the error
  }

  for await (const file of files) {
    const content = await readFile(file, "utf-8");

    const process = content.match(/process (\w+)/)?.[1];

    const scriptLineStartIndex = content
      .split("\n")
      .findIndex((line) => /script:\s*($|\/\/)/.test(line));

    const scriptLineEndIndex =
      scriptLineStartIndex +
      1 +
      content
        .split("\n")
        .slice(scriptLineStartIndex + 1)
        .findIndex((line) => /^\s*\w+:\s*$/.test(line));

    const interestingSegments: { startLine: number; endLine: number }[] = [];

    if (scriptLineStartIndex === -1 || scriptLineEndIndex === -1) return;
    const scriptContent = content
      .split("\n")
      .slice(scriptLineStartIndex, scriptLineEndIndex)
      .join("\n");

    const tripleQuotedRegex = /"""(.*?)"""/gs;
    let match;
    let hasTripleQuoted = false;

    while ((match = tripleQuotedRegex.exec(scriptContent)) !== null) {
      hasTripleQuoted = true;
      const startLine =
        scriptLineStartIndex +
        scriptContent.slice(0, match.index).split("\n").length -
        1;
      const endLine = startLine + match[0].split("\n").length;
      interestingSegments.push({ startLine, endLine });
    }

    if (!interestingSegments.length) continue;

    if (!hasTripleQuoted) {
      interestingSegments.push({
        startLine: scriptLineStartIndex,
        endLine: scriptLineEndIndex,
      });
    }

    for (const segment of interestingSegments) {
      const source = content
        .split("\n")
        .map((line, i) => `${i}: ${line}`)
        .join("\n");

      const parameters = {
        n_examples: 3,
        start_line: segment.startLine,
        end_line: segment.endLine,
        source: source,
      };

      const prompt = formatAnthropicPrompt(promptContent.extract, parameters);

      const response = await anthropic.messages.create(prompt);

      // Create result object with all metadata
      const result: ExtractResult = {
        id: ++resultCounter,
        timestamp: new Date().toISOString(),
        source: {
          file,
          start_line: segment.startLine,
          end_line: segment.endLine,
          content: parameters.source,
        },
        response: (response.content[0] as any)?.text || "",
      };

      allResults.push(result);

      // Save individual result file
      const resultFilename = `${process}_${resultCounter}_${basename(
        file,
        ".nf"
      )}.json`;

      await writeFile(
        join(resultsDir, resultFilename),
        JSON.stringify(result, null, 2)
      );

      console.log(`✅ Saved result ${resultCounter} to ${resultFilename}`);
      console.log(`📄 Source: ${result.source.file}`);
      console.log(`📝 Lines: ${segment.startLine}-${segment.endLine}`);
      console.log(`📊 Response length: ${result.response.length} chars`);
      console.log("---");
    }
  }

  console.log(`\n🎉 Processing complete!`);
  console.log(`📁 Total results: ${allResults.length}`);
  console.log(`📋 Saved to: results/001-source-extract/`);
}

main().catch(console.error);
