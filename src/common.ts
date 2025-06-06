import Anthropic from "@anthropic-ai/sdk";
import { readdir, stat, readFile } from "fs/promises";
import fs from "fs";
import { join } from "path";

interface ScandirMatch {
  file: string;
  match: string[]; // str.match(regex)
  matchIndex: number;
}

export interface StructuredRule {
  id: string;
  label: string;
  pattern: string;
  quality: {
    ai_self_eval_pattern_score: {
      value: string;
      reasoning: string;
    };
  };
  test_fixtures: {
    label: string;
    script: string;
    commands: string[];
  }[];
}

export async function scandir(
  currentDir: string,
  regex: RegExp
): Promise<ScandirMatch[]> {
  if (!regex.global) {
    throw new Error("Regex must be global (have 'g' flag)");
  }
  let results: ScandirMatch[] = [];
  try {
    for (const entry of await readdir(currentDir)) {
      const fullPath = join(currentDir, entry);
      const stats = await stat(fullPath);
      if (stats.isDirectory()) {
        results = results.concat(await scandir(fullPath, regex));
      } else if (stats.isFile()) {
        try {
          const content = await readFile(fullPath, "utf-8");
          const matches = content.matchAll(regex);
          for (const match of matches) {
            results.push({
              file: fullPath,
              match: Array.from(match),
              matchIndex: match.index ?? 0,
            });
          }
        } catch (e) {
          console.error(e);
        } // Skip unreadable files
      }
    }
  } catch (e) {
    console.error(e);
  } // Skip unreadable directories
  return results;
}

export class RuleMatcher {
  public rules: StructuredRule[];
  public ruleRegexes: Map<string, RegExp>;
  public combinedPattern: RegExp;

  constructor(jsonContent: string) {
    this.rules = JSON.parse(jsonContent);
    this.rules = this.rules.filter((rule) => {
      if (["nextflow/core/IGV_JS"].includes(rule.id)) {
        return false;
      }
      return true;
    });
    this.ruleRegexes = new Map();

    // Build combined pattern for early exit
    const patterns: string[] = [];
    for (let idx = 0; idx < this.rules.length; idx++) {
      const rule = this.rules[idx];
      if (!rule) continue;
      try {
        const regex = new RegExp(rule.pattern);
        this.ruleRegexes.set(rule.id, regex);
        patterns.push(`(${rule.pattern})`);
      } catch (e) {
        console.warn(`Failed to compile regex for ${rule.id}: ${e}`);
        continue;
      }
    }
    this.combinedPattern = new RegExp(patterns.join("|"));
  }

  static fromFile(filePath: string): RuleMatcher {
    const content = fs.readFileSync(filePath, "utf-8");
    return new RuleMatcher(content);
  }

  matchCommand(command: string): StructuredRule[] {
    // Early exit if no pattern matches
    if (!this.combinedPattern.test(command)) {
      return [];
    }

    // Find matching rules
    const matches: StructuredRule[] = [];
    for (const rule of this.rules) {
      const regex = this.ruleRegexes.get(rule.id)!;
      if (regex.test(command)) {
        matches.push(rule);
        break;
      }
    }
    return matches;
  }
}

export function formatAnthropicPrompt(
  promptContent: string,
  parameters: Record<string, string | number>
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  // Split content by message delimiters first to analyze structure
  const sections = promptContent.split(/\$\$(SYSTEM|USER|ASSISTANT)\$\$/);

  // Find the first section that contains unresolved parameters
  let firstParameterizedSectionIndex = -1;
  for (let i = 1; i < sections.length; i += 2) {
    const content = sections[i + 1]?.trim() || "";
    // Check if this section contains any $parameter$ patterns
    if (/\$\w+\$/.test(content)) {
      firstParameterizedSectionIndex = i;
      break;
    }
  }

  // Replace parameter placeholders with actual values
  let processedContent = promptContent;
  for (const [key, value] of Object.entries(parameters)) {
    const placeholder = `$${key}$`;
    processedContent = processedContent.replace(
      new RegExp(placeholder.replace(/\$/g, "\\$"), "g"),
      value + ""
    );
  }

  // Split processed content by message delimiters
  const processedSections = processedContent.split(
    /\$\$(SYSTEM|USER|ASSISTANT)\$\$/
  );

  let system = "";
  const messages: Anthropic.Messages.MessageParam[] = [];

  // Process sections (odd indices are types, even indices are content)
  for (let i = 1; i < processedSections.length; i += 2) {
    const messageType = processedSections[i];
    const content = processedSections[i + 1]?.trim() || "";

    if (messageType === "SYSTEM") {
      system = content;
    } else if (messageType === "USER") {
      messages.push({
        role: "user",
        content: [
          {
            text: content,
            type: "text",
            cache_control: null,
          },
        ],
      });
    } else if (messageType === "ASSISTANT") {
      // Check if this is the message immediately before the first parameterized section
      const isPrecedingParameterizedSection =
        firstParameterizedSectionIndex !== -1 &&
        i === firstParameterizedSectionIndex - 2;

      messages.push({
        role: "assistant",
        content: [
          {
            text: content,
            type: "text",
            cache_control: isPrecedingParameterizedSection
              ? { type: "ephemeral" }
              : null,
          },
        ],
      });
    }
  }

  return {
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    system: system,
    messages: messages,
  };
}

interface XmlTag {
  name: string;
  content: string;
  children: XmlTag[];
}

export function extractXml(content: string): XmlTag[] {
  const tags: XmlTag[] = [];

  // Extract all XML tags and their content
  const tagRegex = /<(\w+)>(.*?)<\/\1>/gs;
  let match;

  while ((match = tagRegex.exec(content)) !== null) {
    const tagName = match[1]!;
    const tagContent = match[2]!.trim();

    // Recursively extract nested tags
    const children = extractXml(tagContent);

    tags.push(
      {
        name: tagName,
        content: tagContent,
        children: children,
      },
      ...children
    );
  }

  return tags;
}
