/**
 * Command definitions for the Autocode plugin.
 *
 * Commands are registered programmatically via the `config` hook so they are
 * self-contained in the npm package — no Markdown files need to be copied or
 * referenced from the filesystem by the end user.
 *
 * Each entry matches the Config.Command schema:
 *   { template, description?, agent?, model?, subtask? }
 *
 * The `.opencode/command/` files in this repo are the LOCAL DEV equivalent —
 * opencode loads them from disk when running from the project root.
 * When deployed as a npm package, only this file is used.
 */

type CommandMap = Record<string, {
    template: string
    description?: string
    agent?: string
    model?: string
    subtask?: boolean
}>

export const commands: CommandMap = {

    "autocode-analyze": {
        description: "Find ideas in .autocode/analyze/ and start planning one with the plan agent",
        agent: "plan",
        template: `
Follow this workflow:

Use the \`autocode_analyze_list\` tool to list the available ideas. DO NOT yet, read file contents until the user made his selection.
    - If no ideas are found:
        1. inform the user that the \`.autocode/analyze/\` directory is empty
        2. Ask the user how you can help. 
        3. Wait for the user's response before you continue with STEP 1.
    - If only 1 idea was found:
        1. Read the full content of the selected idea using the \`autocode_analyze_read\` tool.
        2. Continue with STEP 1.
    - If multiple ideas are found:
        1. present them to the user using the \`question\` tool:
            - Header: "Select an Idea"
            - Question: "Which idea would you like to develop into a plan?"
            - Options: One option per idea file, using the idea name as the label and the first ~100 characters of content as the description
        2. Only when the user selects an idea file:
           - Read the full content of the selected idea using the \`autocode_analyze_read\` tool.
        3. Continue with STEP 1.
`.trim(),
    },
}
