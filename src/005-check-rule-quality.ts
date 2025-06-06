// TODO

// error types: alias, confusion, rScript, pipeline didn't run to completion

// relevance: cwltool --version (not interesting)
// relevance: cwltool --version (not interesting)
// failure chance
// how useful is its eBPF telemetry for helping debug issues (potentially originating in other command)
// number of GitHub stars

// inter false positive
// inter false negative
// intra false positive
// intra false negative

import { RuleMatcher } from "./common";
import { join } from "path";

function main() {
  const jsonFilePath = join(
    process.cwd(),
    "results/004-extract-structured-rules/nextflow-process.json"
  );
  console.log(`Loading and testing patterns from: ${jsonFilePath}`);

  const matcher = RuleMatcher.fromFile(jsonFilePath);
  const rules = matcher.rules;

  const falsePositivesScript: Record<string, Set<string>> = {};
  const falseNegativesScript: Record<string, number[]> = {};
  // const falsePositivesCommand: Record<string, Set<string>> = {};
  // const falseNegativesCommand: Record<string, number> = {};

  for (const ruleA of rules) {
    const commandSets = ruleA.test_fixtures;
    falsePositivesScript[ruleA.id] = new Set();
    falseNegativesScript[ruleA.id] = [];
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
            falsePositivesScript[ruleA.id]!.add(ruleB.id);
          }
        }
      }
      if (commandSetTrueMatches === 0) {
        falseNegativesScript[ruleA.id]!.push(i);
      }
    }
  }

  for (const rule of rules) {
    const falsePositives = falsePositivesScript[rule.id]!;
    const falseNegatives = falseNegativesScript[rule.id]!;
    if (falsePositives.size > 0) {
      console.log(
        `Rule ${rule.id} FALSE_POSITIVES:`,
        Array.from(falsePositives)
      );
    }
    if (falseNegatives.length > 0) {
      console.log(`Rule ${rule.id} FALSE_NEGATIVES:`, falseNegatives);
    }
  }
}

void main();
