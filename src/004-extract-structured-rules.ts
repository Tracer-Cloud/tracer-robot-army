import { readdir, readFile } from "fs/promises";
import { join } from "path";
import {
  extractXml,
  formatAnthropicPrompt,
  type StructuredRule,
} from "./common";
import { writeFile } from "fs/promises";
import { mkdir } from "fs/promises";

export async function main() {
  const inputDir = join(process.cwd(), "results/003-add-descriptions");
  const inputFiles = await readdir(inputDir);

  // Ensure results directory exists
  const resultsDir = join(
    process.cwd(),
    "results/004-extract-structured-rules"
  );
  try {
    await mkdir(resultsDir, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore the error
  }

  const results: StructuredRule[] = [];

  for (const inputFile of inputFiles) {
    if (!inputFile.endsWith(".txt")) continue;
    const inputContent = await readFile(join(inputDir, inputFile), "utf8");
    const tags = extractXml(inputContent);

    const processId = tags.find((t) => t.name === "process")!.content;
    const processDescription = tags.find(
      (t) => t.name === "process_description"
    )!.content;

    let pattern = tags.find((t) => t.name === "pattern")!.content;
    pattern = pattern.replace(/^\^/, "").replace(/\$$/, "");
    const testFixtures = tags
      .filter((t) => t.name === "example")
      .map(({ children }) => {
        const label = children.find((t) => t.name === "label")!.content;
        const script = children.find((t) => t.name === "script")!.content;
        const commandContent = children.find(
          (t) => t.name === "sched_process_exec_events"
        )!.content;
        const commands = commandContent
          .split("\n")
          .map((line: string) => {
            const args = line.match(/ARGV: \[(.*?)\]/)?.[1];
            return args
              ? args
                  .split(",")
                  .map((arg) => arg.trim().replace(/"/g, ""))
                  .join(" ")
              : "";
          })
          .filter((f) => f);
        return { label, script, commands };
      });

    const rule = {
      id: `nextflow/core/${processId}`,
      source: {
        file: tags.find((t) => t.name === "file")!.content,
      },
      label: processDescription,
      pattern,
      quality: {
        ai_self_eval_pattern_score: {
          value: tags.find((t) => t.name === "quality_score")!.content,
          reasoning: tags.find((t) => t.name === "reasoning")!.content,
        },
      },
      test_fixtures: testFixtures,
    };

    results.push(rule);
  }

  writeFile(
    join(resultsDir, "nextflow-process.json"),
    JSON.stringify(results, null, 2)
  );
}

main().catch(console.error);
