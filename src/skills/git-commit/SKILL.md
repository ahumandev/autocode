---
name: git-commit
description: Create Git commit message to commit recent changes to Git repository.
---

# Create Git Commit

Create Git commit message in format:

\`\`\`
[ticket id] [type]([scope]) - [description]

[motivation]

[difference]

[breaking changes]
\`\`\`

Replace [placeholders] with:

- [ticket id] to be replaced by ticket id if known:
   - Is optional
   - Format: [PROJECT]-[NUMBER]:
   - Examples: CARDATA-1234, MYPROJECT-10000
- [type] to be replaced by:
   - \`feat\` Commits that add, adjust or remove a new feature to the API or UI
   - \`fix\` Commits that fix an API or UI bug of a preceded \`feat\` commit
   - \`refactor\` Commits that rewrite or restructure code without altering API or UI behavior
   - \`perf\` Commits are special type of \`refactor\` commits that specifically improve performance
   - \`style\` Commits that address code style (e.g., white-space, formatting, missing semi-colons) and do not affect application behavior
   - \`test\` Commits that add missing tests or correct existing ones
   - \`docs\` Commits that exclusively affect documentation
   - \`build\` Commits that affect build-related components such as build tools, dependencies, project version, ...
   - \`ops\` Commits that affect operational aspects like infrastructure (IaC), deployment scripts, CI/CD pipelines, backups, monitoring, or recovery procedures, ...
   - \`chore\` Commits that represent tasks like initial commit, modifying \`.gitignore\`, ...
- [scope] to provides additional contextual information:
   - Is optional, omit if scope is unknown
   - Allowed scopes vary and are typically defined by the specific project
   - NEVER use issue identifiers as scopes
   - Commit with breaking changes MUST be indicated by an \`!\` before the \`: \` in [description] e.g. \`feat(api)! - remove status endpoint\`
- [description] to be replaced by concise description of the change. 
   - Is a **mandatory** part
   - **NEVER** capitalize the first letter
   - **NEVER** end the description with a period (\`.\`)
- [motivation] to be replaced by motivation (why) the change.
   - Instead of git diff info (*what* changed), only include *why* change was necessary if known
   - Is an optional part, omit if reason for commit is unknown
   - NEVER wrap long sentences
- [difference] to list **Behavioral Changes** which is observable behavior in contrast to old behavior before commit
   - DO include user observable changes like "Improved startup performance", "Implemented feature x", "Removed legacy api"
   - NEVER include technical changes available from git diff like "a.ts renamed to b.ts", "function x added to c.js"
   - Omit this section if there are no behavioral changes
   - Title before list is "Behavioral Changes:"
   - 1 behavioral change description per line (no wrapping)
   - Start each line with emojis to indicate type of change
   - Keep emojis consistent (same action = same emoji)
- [breaking changes] to be replaced by list of **Breaking Changes**:
   - NEVER include non-destructive changes like "Update documentation", "Renamed internal variable", "Created new test", "Formatted code"
   - Omit this section if there are no breaking changes
   - Title before list is "Breaking Changes:"
   - 1 change description per line (no wrapping)
   - Start each line with emojis to indicate type of change
   - Keep emojis consistent (same action = same emoji)
   - Be specific: Usual actual identifiers/commands/urls to describe objects

#### Examples

\`\`\`
PROJ-123: feat(auth) - add oauth2 support

Implement OAuth2 flow for third-party authentication providers to replace legacy session-based login.
\`\`\`

\`\`\`
fix(api) - validate user input on registration

Ensure all registration fields are sanitized before processing to prevent SQL injection vulnerabilities. Previous implementation lacked proper validation.
\`\`\`

\`\`\`
feat(database)! - drop deprecated users table

Remove the legacy users tables as part of the migration to the new schema.

Breaking Changes:
🗑️ dropped t_users table from the prod_db database
🗑️ dropped t_users_links table from the prod_db database
\`\`\`

\`\`\`
docs - update installation instructions

Update the INSTALL.md file with the new system requirements and dependency setup steps.
\`\`\`

---

## Rules

- ALWAYS put each point/sentence on own line
- ALWAYS use the imperative, present tense: "change" not "changed" nor "changes"
- ALWAYS review the diff before committing
- ALWAYS report commit failures or success to user
- ALWAYS keep all sentences < 50 characters
- NEVER use generic messages like "update" or "fix"
- NEVER wrap lines in middle of sentences
`
