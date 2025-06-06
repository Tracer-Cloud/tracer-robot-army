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

  const allResults: any[] = [];

  // Ensure results directory exists
  const resultsDir = join(process.cwd(), "results/001-source-extract");
  try {
    await mkdir(resultsDir, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore the error
  }

  for await (const target of targets) {
    if (!target.result) continue;
    for (const segment of target.result.tripleQuotedSegments) {
      const resultFilename = `${target.process}_${segment.startLine}_${segment.endLine}.json`;

      if (await exists(join(resultsDir, resultFilename))) {
        console.log(`⏭️ Skipping ${resultFilename} - already exists`);
        continue;
      } else {
        console.log(`🔎 Processing ${resultFilename}`);
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

      const response = await anthropic.messages.create(prompt);

      // Create result object with all metadata
      const result: ExtractResult = {
        timestamp: new Date().toISOString(),
        source: {
          file: target.file,
          start_line: segment.startLine,
          end_line: segment.endLine,
          content: parameters.source,
        },
        response: (response.content[0] as any)?.text || "",
      };

      allResults.push(result);

      await writeFile(
        join(resultsDir, resultFilename),
        JSON.stringify(result, null, 2)
      );

      console.log(`✅ Saved result to ${resultFilename}`);
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

if (require.main === module) {
  main();
}
