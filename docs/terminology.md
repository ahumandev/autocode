# Terminology

| Term | Definition |
| ---- | ---------- |
| Concept | Early Markdown description of desired change, saved in `.agents/concepts/`; `/job-concepts` creates concepts. |
| Design | Selected solution specification saved as `design.md`. |
| Job workspace | Durable directory `.agents/jobs/YYYY-MM-DD_hh-mm-ss_{title_dir}/` containing `design.md`; timestamp is UTC and directory remains at its original path. |
| Assist selector | `/job-facilitate` selects `assist` execution for design workspace. It does not name workspace state. |
| Auto selector | `/job-execute` selects `auto` execution for design workspace. |
| Root session heading | `# {emoji} {title}` first eligible text line from `advise`, `assist`, or `auto`; updates root title as advisory postfix. |
