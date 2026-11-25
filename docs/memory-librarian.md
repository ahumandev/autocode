# Memory Librarian

This guide describes the memory librarian's instructions for organizing a memory repository. These are prompt instructions for the librarian, not runtime-enforced guarantees.

## Repository layout

The memory index uses Markdown headings for categories and relative links to memory files. The repository includes subdirectories below the index and files linked directly from the index or from other memory files.

Keep all machine-specific and local-environment information in `local-env.md` at the memory repository root. Never link this file from the index. It can be excluded from source control.

## Maintenance workflow

1. Update relevant existing memory first. Otherwise, create a categorized memory file and link it.
2. Keep paths and links synchronized when files move or change. Remove obsolete files and dead links.
3. Avoid duplicate content. Split long, complex subjects and non-Markdown examples over 20 lines.

Prefer at most 10 child categories and 40 entries per child category.
