import Anthropic from "@anthropic-ai/sdk";

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
