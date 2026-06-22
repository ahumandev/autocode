import { newSessionCommandTemplate } from "./new-session"

export const newTroubleshootCommandTemplate = newSessionCommandTemplate("assist_troubleshoot", `with instructions that include:
    - SYMPTOMS = recently observed unexpected/wrong behavior 
    - ENVIRONMENT = environment context where SYMPTOM occurs (like OS, runtime version, profile, config)
    - BACKGROUND = why assignment is needed (if known)
    - CHANGES = what you recently changed that might be relevant to obstacle
    - EXPECTATION = what is expected to happen (like "respond 200 OK")
    - CAUSE = what possibly caused SYMPTOM (like "new auth library is incorrectly implemented")
    - EVIDENCE = facts that support theory of CAUSE (include blockcode of actual data, snippets of code, filenames, line numbers, urls, etc)
    - ERROR = EVIDENCE observed facts about SYMPTOM (like specific error message, stack trace, or exception)
    - TRACE = where ERROR was observed (like trace_id, log file, line number, timestamp, surrounding log messages, etc)
    - REPRODUCTION = steps to reproduce SYMPTOM in ENVIRONMENT include sample input data in blockcode (if possible)`, "Follow troubleshoot session")
