import { tool } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type {
	PendingAgentHandoffLifecycleFailure,
	PendingAgentRestartCoordinator,
} from "@/hooks/agent_restart_coordinator";
import { restartAutocodeAgentInSession } from "@/hooks/agent_restart";
import {
	createAutocodeSession,
	formatAutocodeSessionTitleForAgent,
	resolveAutocodeAgentSessionSettings,
	validateAutocodeSessionCreateInput,
} from "@/utils/agent_swap";
import { isJobStatus } from "@/utils/jobs";
import { cleanSessionTitleSuffix } from "@/utils/session_title";
import {
	createAbortResponse,
	createRetryResponse,
	flattenError,
} from "@/utils/tools";

type ClientBaseUrlCapability = {
	_client?: {
		getConfig?: () => {
			baseUrl?: unknown;
		};
	};
};

function getUsableSourceTitle(title: unknown, fallbackTitle: string): string {
	if (typeof title !== "string") {
		return fallbackTitle;
	}

	const cleanedTitle = cleanSessionTitleSuffix(title, isJobStatus);
	return cleanedTitle.trim().length > 0 &&
		cleanedTitle.trim().toLowerCase() !== "new session"
		? cleanedTitle
		: fallbackTitle;
}

async function resolveSourceTitle(
	client: OpencodeClient,
	directory: string,
	sessionID: string,
	fallbackTitle: string,
): Promise<string> {
	try {
		const sourceSessionResponse = await client.session.get({
			path: { id: sessionID },
			query: { directory },
		});
		if (sourceSessionResponse.error || !sourceSessionResponse.data) {
			return fallbackTitle;
		}

		return getUsableSourceTitle(
			sourceSessionResponse.data.title,
			fallbackTitle,
		);
	} catch {
		return fallbackTitle;
	}
}

function parseServerUrl(value: unknown): URL | undefined {
	if (value instanceof URL) {
		return value;
	}

	if (typeof value !== "string" || value.trim().length === 0) {
		return undefined;
	}

	try {
		return new URL(value);
	} catch {
		return undefined;
	}
}

function resolveRuntimeUrl(
	getUrl?: () => string | URL | undefined,
): URL | undefined {
	try {
		return parseServerUrl(getUrl?.());
	} catch {
		return undefined;
	}
}

function resolveServerUrl(
	client: OpencodeClient,
	runtimeServerUrl?: string | URL,
	getServerUrl?: () => string | URL | undefined,
): URL | undefined {
	const runtimeUrl =
		resolveRuntimeUrl(getServerUrl) ?? parseServerUrl(runtimeServerUrl);
	if (runtimeUrl !== undefined) {
		return runtimeUrl;
	}

	const overrideUrl = parseServerUrl(process.env.AUTOCODE_WEB_URL);
	if (overrideUrl !== undefined) {
		return overrideUrl;
	}

	try {
		const clientBaseUrl = (
			client as OpencodeClient & ClientBaseUrlCapability
		)._client?.getConfig?.().baseUrl;
		return parseServerUrl(clientBaseUrl);
	} catch {
		return undefined;
	}
}

function resolveWebUrl(
	getBrowserOrigin?: () => string | URL | undefined,
): URL | undefined {
	const browserUrl =
		parseServerUrl(process.env.AUTOCODE_WEB_URL) ??
		resolveRuntimeUrl(getBrowserOrigin);
	return browserUrl?.origin === "null" ? undefined : browserUrl;
}

function createSessionMessage(
	title: string,
	sessionID: string,
	agent: string,
	serverUrl: URL | undefined,
	webUrl: URL | undefined,
): string {
	if (serverUrl === undefined) {
		return `Created new session for ${agent}: ${title} (${sessionID}). Handoff registered.`;
	}

	const encodedServerUrl = Buffer.from(
		serverUrl.toString().replace(/\/+$/, ""),
		"utf8",
	).toString("base64url");
	const sessionUrl = `${webUrl?.origin ?? serverUrl.origin}/server/${encodedServerUrl}/session/${encodeURIComponent(
		sessionID,
	)}`;
	return `Created new session for ${agent}: [${title}](${sessionUrl}) (${sessionID}). Handoff registered.`;
}

function getResponseError(
	response: unknown,
	missingDataError: string,
): unknown | undefined {
	if (
		response &&
		typeof response === "object" &&
		"error" in response &&
		response.error !== undefined
	) {
		return response.error;
	}

	if (
		!response ||
		typeof response !== "object" ||
		!("data" in response) ||
		response.data === undefined
	) {
		return missingDataError;
	}

	return undefined;
}

async function rollbackDestination(
	client: OpencodeClient,
	directory: string,
	destinationSessionID: string,
): Promise<string | undefined> {
	try {
		const response = await client.session.delete({
			path: { id: destinationSessionID },
			query: { directory },
		});
		const error = getResponseError(
			response,
			"Destination session delete returned no data.",
		);
		if (error !== undefined) {
			return `destination cleanup failed: ${flattenError(error)}`;
		}
		if (response.data !== true) {
			return "destination cleanup failed: Destination session delete returned false.";
		}
	} catch (error) {
		return `destination cleanup failed: ${flattenError(error)}`;
	}

	return undefined;
}

function appendRollbackFailures(
	primaryError: unknown,
	rollbackFailures: Array<string | undefined>,
): string {
	const failures = rollbackFailures.filter(
		(failure): failure is string => failure !== undefined,
	);
	return failures.length === 0
		? flattenError(primaryError)
		: `${flattenError(primaryError)}; rollback: ${failures.join("; ")}`;
}

export function createAutocodeSessionCreateTool(
	client?: OpencodeClient,
	coordinator?: PendingAgentRestartCoordinator,
	serverUrl?: string | URL,
	getServerUrl?: () => string | URL | undefined,
	getWebUrl?: () => string | URL | undefined,
): ReturnType<typeof tool> {
	return tool({
		description:
			"Create a fresh same-title session and queue its agent prompt, or restart current session when prompt is omitted.",
		args: {
			prompt: tool.schema
				.string()
				.optional()
				.describe("Instructions for agent after handoff."),
			agent: tool.schema.string().describe("Agent to run after handoff."),
		},
		async execute(args, context): Promise<string> {
			if (args.prompt === undefined || args.prompt === null) {
				if (!client) {
					return createAbortResponse(
						"autocode_session_create",
						"Unable to create session: client is unavailable",
					);
				}
				if (!coordinator) {
					return createAbortResponse(
						"autocode_session_create",
						"Unable to create session: handoff lifecycle is unavailable",
					);
				}

				return restartAutocodeAgentInSession({
					client,
					context: {
						sessionID: context.sessionID,
						directory: context.directory,
						worktree: context.worktree,
					},
					targetAgent: args.agent,
					abort: context.abort,
					coordinator,
				});
			}

			const validation = validateAutocodeSessionCreateInput(
				args.prompt,
				args.agent,
			);
			if ("error" in validation) {
				return createRetryResponse(
					"autocode_session_create",
					validation.error,
					validation.instruction ||
						"Provide a nonblank prompt and supported agent.",
				);
			}

			if (!client) {
				return createAbortResponse(
					"autocode_session_create",
					"Unable to create session: client is unavailable",
				);
			}
			if (!coordinator) {
				return createAbortResponse(
					"autocode_session_create",
					"Unable to create session: handoff lifecycle is unavailable",
				);
			}
			try {
				const cleanSourceTitle = await resolveSourceTitle(
					client,
					context.directory,
					context.sessionID,
					validation.title,
				);
				const destinationTitle =
					validation.agent === "auto"
						? formatAutocodeSessionTitleForAgent(cleanSourceTitle, "executing")
						: cleanSourceTitle;
				const sessionSettings = await resolveAutocodeAgentSessionSettings(
					validation.agent,
					context.worktree,
					context.directory,
				);
				if ("error" in sessionSettings) {
					return createAbortResponse(
						"autocode_session_create",
						sessionSettings.error,
					);
				}

				const createdSession = await createAutocodeSession(
					client,
					context.directory,
					destinationTitle,
					validation.agent,
				);
				if ("error" in createdSession) {
					return createAbortResponse(
						"autocode_session_create",
						createdSession.error,
					);
				}

				const rollbackCreatedDestination = async (): Promise<
					string | undefined
				> =>
					createdSession.sessionID === context.sessionID
						? undefined
						: rollbackDestination(
								client,
								context.directory,
								createdSession.sessionID,
							);
				const reportLifecycleFailure = async (
					failure: PendingAgentHandoffLifecycleFailure,
				): Promise<void> => {
					if (failure.stage === "rename") {
						await rollbackCreatedDestination();
					}
				};
				let registration: ReturnType<
					PendingAgentRestartCoordinator["registerHandoff"]
				>;
				try {
					registration = coordinator.registerHandoff({
						client,
						directory: context.directory,
						source: {
							sessionID: context.sessionID,
							title: cleanSourceTitle,
							messageID: context.messageID,
						},
						destination: {
							sessionID: createdSession.sessionID,
							title: destinationTitle,
							agent: validation.agent,
							prompt: validation.prompt,
							resolvedModel: sessionSettings.resolvedModel,
						},
						abort: context.abort,
						reportLifecycleFailure,
					});
				} catch (error) {
					const cleanupFailure = await rollbackCreatedDestination();
					return createAbortResponse(
						"autocode_session_create",
						appendRollbackFailures(error, [cleanupFailure]),
					);
				}
				if (registration.status !== "registered") {
					const cleanupFailure = await rollbackCreatedDestination();
					return createAbortResponse(
						"autocode_session_create",
						appendRollbackFailures(registration.error, [cleanupFailure]),
						registration.instruction,
					);
				}

				return JSON.stringify({
					session_id: createdSession.sessionID,
					session_title: destinationTitle,
					agent: validation.agent,
					handoff_state: "registered",
					session_action: "created",
					message: createSessionMessage(
						destinationTitle,
						createdSession.sessionID,
						validation.agent,
						resolveServerUrl(client, serverUrl, getServerUrl),
						resolveWebUrl(getWebUrl),
					),
				});
			} catch (error) {
				return createAbortResponse("autocode_session_create", error);
			}
		},
	});
}
