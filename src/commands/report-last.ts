import { reportCommandTemplate } from "./_report-template"

export const reportLastCommandTemplate = `
Report **ONLY** on your last assignment (last user requested task). Include only last user prompt, recent actions since last user prompt and recent tool outputs into consideration when you compile the report.

${reportCommandTemplate}
`
