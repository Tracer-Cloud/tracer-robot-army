import * as fs from "fs";
import { basename, join } from "path";
import { RuleMatcher, scandir, type StructuredRule } from "./common";
import {
  findFilesContainingProcess,
  extractRuleTargetsFromFile,
  type NextflowRuleTargetList,
} from "./001-source-extract";
import readline from "readline";
import { readFile } from "fs/promises";

interface QualityResult {
  loggedAs: string;
  processName?: string | null;
  ruleTargets?: NextflowRuleTargetList;
  rules?: StructuredRule[];
  ruleResultsSynthetic?: {
    falsePositives: string[];
    falseNegatives: number[];
    truePositives: number[];
  };
  ruleResultsReal?: { command: string; rule: StructuredRule }[];
}

// 1. Can we see it in the logs
// 2. Can we find it in the source
// 3. Can we extract pattern rules from the source. If not, why?
//   a) R/Perl/Python
//   b) Other
// 4. If we have a pattern, can it match the logs. If not, why?
//   a) confused with other NextFlow processes (false positive)
//   b) nothing in signature

async function main() {
  const inputFile = join(process.cwd(), "inputs/rnaseq-log-nextflow.txt");
  const content = await fs.promises.readFile(inputFile, "utf-8");

  // ====== Logged Processes ======

  console.log("Processing Logged Processes");

  let loggedProcesses = content
    .split("\n")
    .filter((line) => line.includes("status: COMPLETED"))
    .map((line) => {
      const [process] = line.match(/\bNF[A-Z_]+:[A-Z_:]+/) ?? [""];
      return process.split(":").slice(-1)[0]!;
    })
    .filter((p) => p);
  const loggedProcessesUniq = Array.from(new Set(loggedProcesses)).sort();

  const results: QualityResult[] = loggedProcessesUniq.map((loggedAs) => ({
    loggedAs,
  }));

  // ====== Source Hits (workflow) ======

  console.log("Processing Source Hits (workflow)");

  const includeProcessRegex = new RegExp(/include\s*{\s*[A-Z].+?}/g);
  const workflowIncludes = await scandir(
    join(process.cwd(), "../nf-core/rnaseq/workflows"),
    includeProcessRegex
  );
  const subworkflowIncludes = await scandir(
    join(process.cwd(), "../nf-core/rnaseq/subworkflows"),
    includeProcessRegex
  );
  const allIncludes = [...workflowIncludes, ...subworkflowIncludes].map((i) => {
    const [, original, alias] = i.match[0]!.match(
      /include\s*{\s*(\w+)(?:\s*as\s*(\w+))?/
    )!;
    return { original, alias: alias || original };
  });
  const allIncludesAliasMap = Object.fromEntries(
    allIncludes.map((i) => [i.alias, i])
  );

  for (let r of results) {
    r.processName = allIncludesAliasMap[r.loggedAs]?.original;
  }

  // ====== Source Hits (modules) ======

  console.log("Processing Source Hits (modules)");

  const processModuleFiles = await findFilesContainingProcess();
  const processModuleTargets = await Promise.all(
    processModuleFiles.map((f) => extractRuleTargetsFromFile(f))
  );
  const processModuleTargetMap = Object.fromEntries(
    processModuleTargets.map((t) => [t.process, t])
  );

  for (let r of results) {
    if (!r.processName) continue;
    r.ruleTargets = processModuleTargetMap[r.processName];
  }

  // ====== Rule Evaluation ======

  console.log("Processing Rule Evaluation");

  const ruleFilePath = join(
    process.cwd(),
    "results/004-extract-structured-rules/nextflow-process.json"
  );

  const matcher = RuleMatcher.fromFile(ruleFilePath);
  const rules = matcher.rules;

  const rulesByProcess = Object.groupBy(
    matcher.rules,
    (r) => r.id.split("/").slice(-1)[0]!
  );
  const falsePositivesByProcess: Record<string, Set<string>> = {};
  const falseNegativesByProcess: Record<string, number[]> = {};
  const truePositivesByProcess: Record<string, number[]> = {};

  for (const ruleA of rules) {
    console.log(ruleA.id);
    const commandSets = ruleA.test_fixtures;
    const process = ruleA.id.split("/").slice(-1)[0]!;
    if (!falsePositivesByProcess[process]) {
      falsePositivesByProcess[process] = new Set();
    }
    if (!falseNegativesByProcess[process]) {
      falseNegativesByProcess[process] = [];
    }
    if (!truePositivesByProcess[process]) {
      truePositivesByProcess[process] = [];
    }
    for (let i = 0; i < commandSets.length; i++) {
      const commandSet = commandSets[i]!;
      let commandSetTrueMatches = 0;
      for (let j = 0; j < commandSet.commands.length; j++) {
        const command = commandSet.commands[j]!;
        const matches = matcher.matchCommand(command);
        for (const ruleB of matches) {
          if (ruleB.id === ruleA.id) {
            commandSetTrueMatches++;
          } else {
            falsePositivesByProcess[process]!.add(ruleB.id);
          }
        }
      }
      if (commandSetTrueMatches === 0) {
        falseNegativesByProcess[process]!.push(i);
      } else {
        truePositivesByProcess[process]!.push(i);
      }
    }
  }

  for (let r of results) {
    if (!r.processName) continue;
    r.rules = rulesByProcess[r.processName];
    r.ruleResultsSynthetic = {
      falsePositives: Array.from(falsePositivesByProcess[r.processName] ?? []),
      falseNegatives: falseNegativesByProcess[r.processName] ?? [],
      truePositives: truePositivesByProcess[r.processName] ?? [],
    };
  }

  // ====== eBPF Logs ======

  console.log("Processing eBPF Logs");

  const ebpfCommands = (
    await readFile(
      join(process.cwd(), "inputs/rnaseq-log-ebpf-extracted-commands.txt"),
      "utf8"
    )
  )
    .split("\n")
    .map((c) => c.slice(1, -1));

  const matchingEbpfCommandsByProcess: Record<
    string,
    { command: string; rule: StructuredRule }[]
  > = {};
  for (const command of ebpfCommands) {
    const rules = matcher.matchCommand(command);
    for (const rule of rules) {
      const process = rule.id.split("/").slice(-1)[0]!;
      if (!matchingEbpfCommandsByProcess[process]) {
        matchingEbpfCommandsByProcess[process] = [];
      }
      matchingEbpfCommandsByProcess[process].push({ command, rule });
    }
  }

  for (let r of results) {
    if (!r.processName) continue;
    r.ruleResultsReal = matchingEbpfCommandsByProcess[r.processName] ?? [];
  }

  // ====== Print Results ======

  for (const r of results) {
    let failReason = "";
    if (!r.processName || !r.ruleTargets) {
      const missingFrom: string[] = [];
      if (!r.processName) missingFrom.push("workflows");
      if (!r.ruleTargets) missingFrom.push("modules");
      const missingFromStr = missingFrom.join(" & ");
      failReason = `Cannot find process in source code: ${missingFromStr}`;
    }
    if (!r.rules?.length && r.ruleTargets) {
      let detail = "";
      if (r.ruleTargets?.error) detail = r.ruleTargets?.error;
      else if (r.ruleTargets.result?.templateFile) {
        const template = basename(r.ruleTargets.result?.templateFile);
        detail = `Cannot recognise dynamic script, ${template}`;
      } else {
        detail = "In progress, not yet extracted";
      }

      failReason = `Cannot extract rule from source code: ${detail}`;
    }
    if (r.rules && r.ruleResultsSynthetic) {
      const { falseNegatives, falsePositives, truePositives } =
        r.ruleResultsSynthetic;
      const totalExamples = truePositives.length + falseNegatives.length;
      if (falseNegatives.length) {
        failReason = `False negative: Did not match for ${falseNegatives.length}/${totalExamples} tests`;
      } else if (falsePositives.length) {
        const falsePositiveList = falsePositives.join(", ");
        failReason = `False positive: Matched, but possibly confused with: ${falsePositiveList}`;
      }
    }
    if (r.rules && r.ruleResultsReal && !failReason) {
      if (r.ruleResultsReal.length === 0) {
        failReason = `Matched on synthetic fixtures, but not on real data`;
      }
    }

    let printed = "";
    printed += failReason ? "✗ " : "✓ ";
    printed += r.loggedAs;
    if (r.processName && r.processName !== r.loggedAs) {
      printed += " / " + r.processName;
    }
    if (failReason) {
      printed += ` (${failReason})`;
    }
    console.log(printed);
  }
}

void main();
