# Terminology

| Term | Definition |
| ---- | ---------- |
| Concept | Early Markdown description of desired change, saved in `.agents/concepts/`; `/job-concepts` creates concepts. |
| Session | OpenCode session owns workflow and state. |
| Temporary workspace | `.agents/jobs/<timestamp>_<session-title-slug>/` stores temp artifacts; make or reuse on demand. |
| Root session heading | `# {emoji} {title}` first eligible text line from `advise`, `assist`, or `auto`; updates root title as advisory postfix. |
