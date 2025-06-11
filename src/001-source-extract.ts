import { readdir, readFile, stat, writeFile, mkdir, exists } from "fs/promises";
import { dirname, join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { formatAnthropicPrompt, scandir } from "./common";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function findFilesContainingProcess() {
  let filesContainingProcess: string[] = [];

  const repositories = (
    await readFile(join(process.cwd(), "./inputs/repositories.txt"), "utf-8")
  )
    .split("\n")
    .filter((l) => l)
    .map((line) => {
      const [repo, stars] = line.split(", ");
      const repoName = repo!.split(":")[1]!;
      const starCount = parseInt(stars!.split(":")[1]!);
      return { repoName, starCount };
    });

  const interestingDirs = [
    join(process.cwd(), "../nf-core/modules/modules/nf-core"),
  ];
  for (const { repoName, starCount } of repositories) {
    if (starCount < 100) continue;
    const dir = join(process.cwd(), `../${repoName}/modules/local`);
    if (await exists(dir)) {
      interestingDirs.push(dir);
    }
  }

  for (const dir of interestingDirs) {
    const matches = await scandir(dir, /\bprocess [A-Z_]+ {/g);
    filesContainingProcess = filesContainingProcess.concat(
      matches.map((m) => m.file)
    );
  }

  return filesContainingProcess;
}

export interface SourceCodeSlice {
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
}

export interface NextflowRuleTargetList {
  process: string;
  file: string;
  error?: string | null;
  result?: {
    tripleQuotedSegments: SourceCodeSlice[];
    templateFile?: string | null;
  } | null;
}

export async function extractRuleTargetsFromFile(
  file: string
): Promise<NextflowRuleTargetList> {
  const content = await readFile(file, "utf-8");

  const process = content.match(/process (\w+)/)?.[1]!;

  const scriptBlockStartMatch = content.match(/\n\s*script:\s/);
  const scriptBlockStartIndex = scriptBlockStartMatch?.index ?? -1;

  if (scriptBlockStartIndex === -1) {
    return {
      process,
      file,
      error: "Couldn't find script block",
    };
  }

  // Tiny tokenizer to find script block end
  let i = scriptBlockStartIndex + scriptBlockStartMatch![0].length;
  let inTripleQuote = false;
  let scriptBlockEndIndex = content.length;
  while (i < content.length - 2) {
    if (content.slice(i, i + 3) === '"""') {
      inTripleQuote = !inTripleQuote;
      i += 3;
    } else if (!inTripleQuote && /^\n\s*\w+:\s/.test(content.slice(i))) {
      scriptBlockEndIndex = i;
      break;
    } else {
      i++;
    }
  }

  let contentSlice = content.slice(0, scriptBlockEndIndex);

  const tripleQuotedSegments: SourceCodeSlice[] = [];

  const tripleQuotedRegex = /"""(.*?)"""/gs;
  tripleQuotedRegex.lastIndex = scriptBlockStartIndex;
  let match;
  while ((match = tripleQuotedRegex.exec(contentSlice)) !== null) {
    tripleQuotedSegments.push({
      startIndex: match.index,
      endIndex: match.index + match[0].length,
      startLine: content.slice(0, match.index).split("\n").length - 1,
      endLine: content.slice(0, match.index + match[0].length).split("\n")
        .length,
    });
  }

  const templateNameRegex = /template.*?(['"])(.+?)\1/g;
  templateNameRegex.lastIndex = scriptBlockStartIndex;
  let templateName = templateNameRegex.exec(contentSlice)?.[2] ?? null;
  let templateFile: string | undefined;

  template: if (templateName) {
    templateFile = join(dirname(file), "templates", templateName);
    if (!(await exists(templateFile))) {
      templateName = null;
      break template;
    }
  }

  if (!templateName && !tripleQuotedSegments.length) {
    return {
      process,
      file,
      error: "Couldn't find executable content in script block",
    };
  }

  return {
    process,
    file,
    result: { tripleQuotedSegments, templateFile },
  };
}

export interface ExtractResult {
  timestamp: string;
  source: {
    file: string;
    start_line: number;
    end_line: number;
    content: string;
  };
  response: string;
}

interface BatchRequest {
  custom_id: string;
  params: any;
  metadata: {
    target: NextflowRuleTargetList;
    segment: SourceCodeSlice;
    resultFilename: string;
  };
}

async function main() {
  const promptContent = {
    extract: await readFile(
      join(process.cwd(), "./src/001-source-extract.txt"),
      "utf-8"
    ),
  };

  const files = await findFilesContainingProcess();

  console.log(`Found ${files.length} files with process definitions`);

  const targets = await Promise.all(
    files.map((f) => extractRuleTargetsFromFile(f))
  );

  const errorCount = targets.filter((t) => t.error).length;
  const successCount = targets.filter((t) => t.result).length;
  const templateCount = targets.filter((t) => t.result?.templateFile).length;
  const tripleQuotedCount = targets.reduce(
    (pv, t) => pv + (t.result?.tripleQuotedSegments.length ?? 0),
    0
  );

  console.log("\n📊 Target Statistics:");
  console.log(`Total targets: ${targets.length}`);
  console.log(`✅ Successful extractions: ${successCount}`);
  console.log(`❌ Failed extractions: ${errorCount}`);
  console.log(`📄 Template files found: ${templateCount}`);
  console.log(`📝 Triple-quoted segments found: ${tripleQuotedCount}`);
  console.log("---\n");

  // Ensure results directory exists
  const resultsDir = join(process.cwd(), "results/001-source-extract");
  try {
    await mkdir(resultsDir, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore the error
  }

  // Collect all batch requests
  const batchRequests: BatchRequest[] = [];

  for (const target of targets) {
    if (!target.result) continue;
    for (const segment of target.result.tripleQuotedSegments) {
      const resultFilename = `${target.process}_${segment.startLine}_${segment.endLine}.json`;

      if (await exists(join(resultsDir, resultFilename))) {
        console.log(`⏭️ Skipping ${resultFilename} - already exists`);
        continue;
      }

      const content = await readFile(target.file, "utf-8");
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

      batchRequests.push({
        custom_id: `${target.process}_${segment.startLine}_${segment.endLine}`,
        params: prompt,
        metadata: {
          target,
          segment,
          resultFilename,
        },
      });
    }
  }

  if (batchRequests.length === 0) {
    console.log("No new requests to process.");
    return;
  }

  console.log(`🚀 Submitting batch with ${batchRequests.length} requests...`);

  // Create batch request
  const messageBatch = await anthropic.messages.batches.create({
    requests: batchRequests.map((req) => ({
      custom_id: req.custom_id,
      params: req.params,
    })),
  });

  console.log(`📋 Batch created with ID: ${messageBatch.id}`);
  console.log(`⏳ Waiting for batch to complete...`);

  // Poll for batch completion
  let batchStatus = messageBatch;
  while (batchStatus.processing_status !== "ended") {
    await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
    batchStatus = await anthropic.messages.batches.retrieve(messageBatch.id);
    console.log(
      `📊 Batch status: ${batchStatus.processing_status} (${batchStatus.request_counts.processing} processing, ${batchStatus.request_counts.succeeded} succeeded, ${batchStatus.request_counts.errored} errored)`
    );
  }

  console.log(`✅ Batch completed! Processing results...`);

  // Get results using the SDK method
  const allResults: ExtractResult[] = [];

  try {
    // Stream results file in memory-efficient chunks, processing one at a time
    for await (const result of await anthropic.messages.batches.results(
      messageBatch.id
    )) {
      const req = batchRequests.find((r) => r.custom_id === result.custom_id);

      if (!req) {
        console.log(`❌ No matching request found for ${result.custom_id}`);
        continue;
      }

      switch (result.result.type) {
        case "succeeded":
          const content = await readFile(req.metadata.target.file, "utf-8");
          const source = content
            .split("\n")
            .map((line, i) => `${i}: ${line}`)
            .join("\n");

          const extractResult: ExtractResult = {
            timestamp: new Date().toISOString(),
            source: {
              file: req.metadata.target.file,
              start_line: req.metadata.segment.startLine,
              end_line: req.metadata.segment.endLine,
              content: source,
            },
            response:
              result.result.message?.content?.[0]?.type === "text"
                ? result.result.message.content[0].text
                : "",
          };

          allResults.push(extractResult);

          await writeFile(
            join(resultsDir, req.metadata.resultFilename),
            JSON.stringify(extractResult, null, 2)
          );

          console.log(`✅ Saved result to ${req.metadata.resultFilename}`);
          console.log(`📄 Source: ${extractResult.source.file}`);
          console.log(
            `📝 Lines: ${req.metadata.segment.startLine}-${req.metadata.segment.endLine}`
          );
          console.log(
            `📊 Response length: ${extractResult.response.length} chars`
          );
          console.log("---");
          break;

        case "errored":
          const errorType =
            (result.result.error as any)?.type === "invalid_request"
              ? "Validation"
              : "Server";
          console.log(
            `❌ ${errorType} error: ${result.custom_id}`,
            result.result.error
          );
          break;
        default:
          console.log(
            `Request ${result.result.type ?? "not handled"}: ${
              result.custom_id
            }`,
            result.result
          );
          break;
      }
    }
  } catch (error) {
    console.error("Error processing batch results:", error);
  }

  console.log(`\n🎉 Processing complete!`);
  console.log(`📁 Total results: ${allResults.length}`);
  console.log(`📋 Saved to: results/001-source-extract/`);
}

if (require.main === module) {
  main();
}
