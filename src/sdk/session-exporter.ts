// src/sdk/session-exporter.ts

/**
 * Export an OpenCode session to a readable markdown format.
 * 
 * Retrieves all messages and their parts from the session,
 * then formats them as a markdown document with tool calls,
 * outputs, and errors clearly marked.
 */
export async function exportSessionToMarkdown(
  client: any,
  sessionId: string,
): Promise<string> {
  const messagesResponse = await client.session.messages({
    path: { id: sessionId },
  })

  const messages = messagesResponse.data ?? messagesResponse ?? []

  let md = `# Session Export\n\n`
  md += `**Session ID:** \`${sessionId}\`\n`
  md += `**Exported:** ${new Date().toISOString()}\n\n`
  md += `---\n\n`

  if (!Array.isArray(messages) || messages.length === 0) {
    md += `_No messages in this session._\n`
    return md
  }

  for (const msg of messages) {
    const info = msg.info ?? msg
    const parts = msg.parts ?? []
    const role = info.role === "user" ? "👤 User" : "🤖 Assistant"

    md += `## ${role}\n\n`

    // Add metadata for assistant messages
    if (info.role === "assistant") {
      if (info.agent) md += `**Agent:** ${info.agent}\n`
      if (info.modelID) md += `**Model:** ${info.providerID}/${info.modelID}\n`
      if (info.tokens) {
        md += `**Tokens:** input=${info.tokens.input}, output=${info.tokens.output}`
        if (info.tokens.reasoning) md += `, reasoning=${info.tokens.reasoning}`
        md += `\n`
      }
      if (info.cost) md += `**Cost:** $${info.cost.toFixed(4)}\n`
      md += `\n`
    }

    for (const part of parts) {
      const partData = part.data ?? part

      if (partData.type === "text") {
        md += `${partData.text ?? partData.state?.text ?? ""}\n\n`
      } else if (partData.type === "tool") {
        const state = partData.state ?? partData
        const toolName = partData.tool ?? state.tool ?? "unknown"

        if (state.status === "completed") {
          md += `### 🔧 Tool: ${toolName}\n`
          if (state.title) md += `**${state.title}**\n\n`
          if (state.input) {
            const inputStr =
              typeof state.input === "string"
                ? state.input
                : JSON.stringify(state.input, null, 2)
            if (inputStr.length < 500) {
              md += `**Input:**\n\`\`\`json\n${inputStr}\n\`\`\`\n\n`
            }
          }
          if (state.output) {
            const outputStr = String(state.output)
            if (outputStr.length > 2000) {
              md += `**Output:** _(${outputStr.length} chars, truncated)_\n\`\`\`\n${outputStr.slice(0, 2000)}\n...\n\`\`\`\n\n`
            } else {
              md += `**Output:**\n\`\`\`\n${outputStr}\n\`\`\`\n\n`
            }
          }
        } else if (state.status === "error") {
          md += `### ❌ Tool Error: ${toolName}\n`
          md += `**Error:** ${state.error ?? "Unknown error"}\n\n`
        }
        // Skip pending/running states in export
      }
    }

    md += `---\n\n`
  }

  return md
}

/**
 * Extract a brief summary from a session markdown export.
 * Returns the last assistant message's text content (truncated).
 */
export function extractSessionSummary(
  sessionMarkdown: string,
  maxLength: number = 500,
): string {
  const parts = sessionMarkdown.split("## 🤖 Assistant")
  if (parts.length < 2) return "No summary available"

  const lastPart = parts[parts.length - 1]
  // Extract text before the first tool call or separator
  const textMatch = lastPart.match(/\n\n([\s\S]*?)(?=\n###|\n---|\n##|$)/)
  const text = textMatch ? textMatch[1].trim() : lastPart.trim()

  return text.length > maxLength
    ? text.slice(0, maxLength) + "..."
    : text
}
