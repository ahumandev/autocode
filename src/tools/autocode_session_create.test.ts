import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@opencode-ai/plugin";
import type { Event, OpencodeClient } from "@opencode-ai/sdk";
import {
	createPendingAgentRestartCoordinator,
	type PendingAgentRestartCoordinator,
} from "../hooks/agent_restart_coordinator";
import { resetRetryCounts } from "../utils/tools";
import { createAutocodeSessionCreateTool } from "./autocode_session_create";
import { createNoopAsk } from "./test_context";

type ParsedToolResult = Record<string, unknown>;
type StringSchema = { safeParse(input: unknown): { success: boolean } };
type CreateTestClient = OpencodeClient & {
	session: {
		get: ReturnType<typeof mock>;
		create: ReturnType<typeof mock>;
		update: ReturnType<typeof mock>;
		delete: ReturnType<typeof mock>;
		promptAsync: ReturnType<typeof mock>;
	};
	_client?: { getConfig(): { baseUrl?: unknown } };
};

const primaryAgents: Array<"assist" | "advise" | "auto" | "design"> = [
	"assist",
	"advise",
	"auto",
	"design",
];

describe("autocode_session_create tool", () => {
	let worktree: string;

	beforeEach(() => {
		resetRetryCounts();
		worktree = mkdtempSync(join(tmpdir(), "autocode-session-create-"));
		mkdirSync(join(worktree, ".opencode"), { recursive: true });
		writeFileSync(
			join(worktree, ".opencode", "autocode.jsonc"),
			JSON.stringify({
				autocode: {
					tiers: {
						balanced: { model: "anthropic/claude-sonnet-4-5", variant: "high" },
						smart: { model: "openai/gpt-5.5", variant: "thinking" },
					},
				},
			}),
		);
	});

	afterEach(() => {
		resetRetryCounts();
		rmSync(worktree, { recursive: true, force: true });
	});

	function createToolContext(
		overrides: Partial<ToolContext> = {},
	): ToolContext {
		return {
			sessionID: "source-session",
			messageID: "message-1",
			agent: "assist",
			directory: worktree,
			worktree,
			abort: new AbortController().signal,
			metadata() {},
			ask: createNoopAsk(),
			...overrides,
		};
	}

	function sourceTurnEndedEvent(): Event {
		return {
			type: "session.next.step.ended",
			directory: worktree,
			data: {
				sessionID: "source-session",
				assistantMessageID: "message-1",
				finish: "stop",
			},
		} as unknown as Event;
	}

	function createMockClient(
		options: {
			sourceTitle?: unknown;
			baseUrl?: unknown;
			createResponse?: unknown;
			deleteResponse?: unknown;
		} = {},
	): CreateTestClient {
		const sourceTitle =
			"sourceTitle" in options ? options.sourceTitle : "Source session";
		return {
			session: {
				get: mock(async () => ({ data: { title: sourceTitle } })),
				create: mock(
					async () =>
						options.createResponse ?? { data: { id: "destination/session" } },
				),
				update: mock(async () => ({ data: true })),
				delete: mock(async () => options.deleteResponse ?? { data: true }),
				promptAsync: mock(async () => ({})),
			},
			...(options.baseUrl === undefined
				? {}
				: { _client: { getConfig: () => ({ baseUrl: options.baseUrl }) } }),
		} as unknown as CreateTestClient;
	}

	function parseToolResult(
		result: string | { output: string },
	): ParsedToolResult {
		return JSON.parse(typeof result === "string" ? result : result.output);
	}

	function writeJobDesign(directoryName: string, content: string): void {
		const jobDirectory = join(worktree, ".agents", "jobs", directoryName);
		mkdirSync(jobDirectory, { recursive: true });
		writeFileSync(join(jobDirectory, "design.md"), content);
	}

	test("schema accepts optional prompt and requires string agent", () => {
		const tool = createAutocodeSessionCreateTool();
		const promptSchema = tool.args.prompt as unknown as StringSchema;
		const agentSchema = tool.args.agent as unknown as StringSchema;

		expect(Object.keys(tool.args)).toEqual(["prompt", "agent"]);
		expect(promptSchema.safeParse(undefined).success).toBe(true);
		expect(promptSchema.safeParse("Continue work").success).toBe(true);
		expect(promptSchema.safeParse(1).success).toBe(false);
		for (const agent of primaryAgents) {
			expect(agentSchema.safeParse(agent).success).toBe(true);
		}
		expect(agentSchema.safeParse(1).success).toBe(false);
	});

	test.each(primaryAgents)(
		"registers supported %s agent without dispatching during tool execution",
		async (agent) => {
			const client = createMockClient();
			const coordinator = createPendingAgentRestartCoordinator();

			const result = parseToolResult(
				await createAutocodeSessionCreateTool(client, coordinator).execute(
					{ prompt: "Continue", agent },
					createToolContext(),
				),
			);

			expect(result).toMatchObject({
				session_id: "destination/session",
				session_title: `Source session (${agent})`,
				message: expect.any(String),
			});
			expect(client.session.update).not.toHaveBeenCalled();
			expect(client.session.promptAsync).not.toHaveBeenCalled();
			expect(coordinator.pendingCount()).toBe(1);
			coordinator.dispose();
		},
	);

	test("archives source then dispatches exact destination prompt once after matching source turn", async () => {
		const calls: string[] = [];
		const client = createMockClient({
			sourceTitle: "Research topic (old status) stale text",
		});
		const coordinator = createPendingAgentRestartCoordinator();
		client.session.create.mockImplementation(async () => {
			calls.push("create");
			return { data: { id: "destination/session" } };
		});
		client.session.update.mockImplementation(async () => {
			calls.push("update");
			return { data: true };
		});
		client.session.promptAsync.mockImplementation(async () => {
			calls.push("promptAsync");
			return {};
		});

		const result = parseToolResult(
			await createAutocodeSessionCreateTool(client, coordinator).execute(
				{ prompt: "Implement exact handoff", agent: "auto" },
				createToolContext(),
			),
		);

		expect(calls).toEqual(["create"]);
		expect(result).toMatchObject({
			session_id: "destination/session",
			session_title: "Research topic (auto)",
			message:
				"Created new session for auto: Research topic (auto) (destination/session). Handoff registered.",
		});

		await Promise.all([
			coordinator.handleEvent(sourceTurnEndedEvent()),
			coordinator.handleEvent(sourceTurnEndedEvent()),
		]);

		expect(calls).toEqual(["create", "update", "promptAsync"]);
		expect(client.session.update).toHaveBeenCalledWith({
			path: { id: "source-session" },
			query: { directory: worktree },
			body: {
				title: expect.stringMatching(
					/^Research topic \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/,
				),
			},
		});
		expect(client.session.promptAsync).toHaveBeenCalledWith({
			path: { id: "destination/session" },
			query: { directory: worktree },
			body: {
				agent: "auto",
				model: {
					providerID: "openai",
					modelID: "gpt-5.5",
					variant: "thinking",
				},
				parts: [{ type: "text", text: "Implement exact handoff" }],
			},
		});
		expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
		coordinator.dispose();
	});

	const emptyPromptCases: Array<
		[string, { agent: string; prompt?: string }]
	> = [
		["omitted", { agent: "assist" }],
		["empty", { prompt: "", agent: "assist" }],
		["whitespace-only", { prompt: " \t\n", agent: "assist" }],
	];
	test.each(emptyPromptCases)(
		"loads matching design for %s prompt and defers it to destination",
		async (promptKind, args) => {
			const sourceTitle = "Durable Design";
			const design = `# Design handoff (${promptKind})`;
			writeJobDesign(
				"2026-08-20_10-30-00_durable_design",
				design,
			);
			const client = createMockClient({ sourceTitle });
			const coordinator = createPendingAgentRestartCoordinator();

			const result = parseToolResult(
				await createAutocodeSessionCreateTool(client, coordinator).execute(
					args,
					createToolContext(),
				),
			);

			expect(result).toMatchObject({
				session_id: "destination/session",
			});
			expect(client.session.create).toHaveBeenCalledTimes(1);
			expect(client.session.promptAsync).not.toHaveBeenCalled();

			await coordinator.handleEvent(sourceTurnEndedEvent());

			expect(client.session.promptAsync).toHaveBeenCalledWith(
				expect.objectContaining({
					body: expect.objectContaining({
						parts: [{ type: "text", text: design }],
					}),
				}),
			);
			coordinator.dispose();
		},
	);

	test("selects latest timestamped matching design directory", async () => {
		const sourceTitle = "Durable Design";
		writeJobDesign(
			"2026-08-20_10-30-00_durable_design",
			"# Earlier design",
		);
		writeJobDesign(
			"2026-08-21_10-30-00_durable_design",
			"# Latest design",
		);
		writeJobDesign("2027-08-21T10-30-00_durable_design", "# Malformed");
		writeJobDesign("2028-08-21_10-30-00_other_design", "# Wrong title");
		const client = createMockClient({ sourceTitle });
		const coordinator = createPendingAgentRestartCoordinator();

		await createAutocodeSessionCreateTool(client, coordinator).execute(
			{ agent: "assist" },
			createToolContext(),
		);
		await coordinator.handleEvent(sourceTurnEndedEvent());

		expect(client.session.promptAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.objectContaining({
					parts: [{ type: "text", text: "# Latest design" }],
				}),
			}),
		);
		coordinator.dispose();
	});

	test("selects latest matching design over older session-linked design", async () => {
		const sourceTitle = "Durable Design";
		const olderDirectory = "2026-08-20_10-30-00_durable_design";
		writeJobDesign(olderDirectory, "# Older session-linked design");
		writeFileSync(
			join(worktree, ".agents", "jobs", olderDirectory, "session.yml"),
			"session_id: source-session\n",
		);
		writeJobDesign(
			"2026-08-21_10-30-00_durable_design",
			"# Newer timestamped design",
		);
		const client = createMockClient({ sourceTitle });
		const coordinator = createPendingAgentRestartCoordinator();

		await createAutocodeSessionCreateTool(client, coordinator).execute(
			{ agent: "assist" },
			createToolContext(),
		);
		await coordinator.handleEvent(sourceTurnEndedEvent());

		expect(client.session.promptAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.objectContaining({
					parts: [{ type: "text", text: "# Newer timestamped design" }],
				}),
			}),
		);
		coordinator.dispose();
	});

	test("returns retry response without destination when no matching design exists", async () => {
		writeJobDesign("2026-08-20_10-30-00_other_design", "# Wrong title");
		writeJobDesign("2026-08-20T10-30-00_source_session", "# Malformed");
		const client = createMockClient({ sourceTitle: "Source Session" });
		const coordinator = createPendingAgentRestartCoordinator();

		const result = parseToolResult(
			await createAutocodeSessionCreateTool(client, coordinator).execute(
				{ prompt: "\t ", agent: "assist" },
				createToolContext(),
			),
		);

		expect(result).toEqual({
			failedAction: "autocode_session_create",
			error: "No matching job design.md found for current session title.",
			instruction: "Provide a nonempty prompt and retry autocode_session_create.",
		});
		expect(client.session.create).not.toHaveBeenCalled();
		coordinator.dispose();
	});

	test("uses explicit nonblank prompt without inspecting job design files", async () => {
		const fileSystem = {
			readdir: mock(async () => {
				throw new Error("job design lookup must be skipped");
			}),
			readFile: mock(async () => {
				throw new Error("job design lookup must be skipped");
			}),
		};
		const client = createMockClient({ sourceTitle: "Explicit Prompt" });
		const coordinator = createPendingAgentRestartCoordinator();
		const prompt = "Use supplied handoff instructions.";

		const result = parseToolResult(
			await createAutocodeSessionCreateTool(
				client,
				coordinator,
				undefined,
				undefined,
				undefined,
				fileSystem,
			).execute({ prompt, agent: "assist" }, createToolContext()),
		);

		expect(result).toMatchObject({ session_id: "destination/session" });
		expect(client.session.create).toHaveBeenCalledTimes(1);
		expect(fileSystem.readdir).not.toHaveBeenCalled();
		expect(fileSystem.readFile).not.toHaveBeenCalled();
		expect(client.session.get).toHaveBeenCalledTimes(1);
		await coordinator.handleEvent(sourceTurnEndedEvent());
		expect(client.session.promptAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.objectContaining({
					parts: [{ type: "text", text: prompt }],
				}),
			}),
		);
		coordinator.dispose();
	});

	test("uses canonical trailing-slash-free server URL key from live server URL", async () => {
		const destinationSessionID = "destination-session";
		let runtimeServerUrl: URL | undefined = new URL("http://127.0.0.1:4200/");
		let browserOrigin: string | undefined = "http://127.0.0.1:3200";
		const client = createMockClient({
			baseUrl: "http://stale-client.test:3000",
			createResponse: { data: { id: destinationSessionID } },
		});
		const coordinator = createPendingAgentRestartCoordinator();
		const sessionTool = createAutocodeSessionCreateTool(
			client,
			coordinator,
			undefined,
			() => runtimeServerUrl,
			() => browserOrigin,
		);

		runtimeServerUrl = new URL("http://127.0.0.1:4300/");
		browserOrigin = "http://127.0.0.1:3300/browser";
		const result = parseToolResult(
			await sessionTool.execute(
				{ prompt: "Continue", agent: "assist" },
				createToolContext(),
			),
		);

		const link = (result.message as string).match(/\]\(([^)]+)\)/)?.[1];
		expect(link).toBeDefined();
		const sessionUrl = new URL(link as string);
		const encodedServerUrl = sessionUrl.pathname.split("/")[2];
		const expectedEncodedServerUrl = Buffer.from(
			"http://127.0.0.1:4300",
			"utf8",
		).toString("base64url");

		expect(link).toBe(
			`http://127.0.0.1:3300/server/${expectedEncodedServerUrl}/session/${destinationSessionID}`,
		);
		expect(sessionUrl.origin).toBe("http://127.0.0.1:3300");
		expect(Buffer.from(encodedServerUrl, "base64url").toString("utf8")).toBe(
			"http://127.0.0.1:4300",
		);
		expect(sessionUrl.pathname).toBe(
			`/server/${encodedServerUrl}/session/${destinationSessionID}`,
		);
		coordinator.dispose();
	});

	test("uses runtime server URL before AUTOCODE_WEB_URL browser origin", async () => {
		const previousServerUrl = process.env.AUTOCODE_WEB_URL;
		process.env.AUTOCODE_WEB_URL = "http://127.0.0.1:4500/";
		const coordinator = createPendingAgentRestartCoordinator();

		try {
			const client = createMockClient({
				createResponse: { data: { id: "destination-session" } },
			});
			const result = parseToolResult(
				await createAutocodeSessionCreateTool(
					client,
					coordinator,
					undefined,
					() => new URL("http://127.0.0.1:4444/"),
					() => new URL("http://127.0.0.1:3333/"),
				).execute(
					{ prompt: "Continue", agent: "assist" },
					createToolContext(),
				),
			);
			const encodedServerUrl = Buffer.from(
				"http://127.0.0.1:4444",
				"utf8",
			).toString("base64url");

			expect(result.message).toContain(
				`http://127.0.0.1:4500/server/${encodedServerUrl}/session/destination-session`,
			);
		} finally {
			coordinator.dispose();
			if (previousServerUrl === undefined) delete process.env.AUTOCODE_WEB_URL;
			else process.env.AUTOCODE_WEB_URL = previousServerUrl;
		}
	});

	test.each([undefined, "not a URL"])(
		"falls back to server origin when browser origin is %p",
		async (browserOrigin) => {
			const destinationSessionID = "destination-session";
			const serverUrl = new URL("http://127.0.0.1:4300/");
			const client = createMockClient({
				createResponse: { data: { id: destinationSessionID } },
			});
			const coordinator = createPendingAgentRestartCoordinator();
			const sessionTool = createAutocodeSessionCreateTool(
				client,
				coordinator,
				undefined,
				() => serverUrl,
				() => browserOrigin,
			);

			const result = parseToolResult(
				await sessionTool.execute(
					{ prompt: "Continue", agent: "assist" },
					createToolContext(),
				),
			);

			const link = (result.message as string).match(/\]\(([^)]+)\)/)?.[1];
			const encodedServerUrl = Buffer.from(
				"http://127.0.0.1:4300",
				"utf8",
			).toString("base64url");

			expect(link).toBe(
				`http://127.0.0.1:4300/server/${encodedServerUrl}/session/${destinationSessionID}`,
			);
			coordinator.dispose();
		},
	);

	test("cleans destination when handoff registration fails", async () => {
		const client = createMockClient();
		const coordinator: PendingAgentRestartCoordinator = {
			register: () => "registered",
			registerHandoff: () => ({
				status: "duplicate",
				error: "A continuation is already pending for this source session.",
				instruction:
					"Wait for pending source-session handoff before requesting another continuation.",
			}),
			async handleEvent(): Promise<void> {},
			dispose(): void {},
			pendingCount: () => 0,
		};

		const result = parseToolResult(
			await createAutocodeSessionCreateTool(client, coordinator).execute(
				{ prompt: "Continue", agent: "assist" },
				createToolContext(),
			),
		);

		expect(result).toMatchObject({
			failedAction: "autocode_session_create",
			error: "A continuation is already pending for this source session.",
		});
		expect(client.session.delete).toHaveBeenCalledWith({
			path: { id: "destination/session" },
			query: { directory: worktree },
		});
		expect(client.session.update).not.toHaveBeenCalled();
		expect(client.session.promptAsync).not.toHaveBeenCalled();
	});

	test("cleans destination when handoff registration throws", async () => {
		const client = createMockClient();
		const coordinator: PendingAgentRestartCoordinator = {
			register: () => "registered",
			registerHandoff: () => {
				throw new Error("registration failed");
			},
			async handleEvent(): Promise<void> {},
			dispose(): void {},
			pendingCount: () => 0,
		};

		const result = parseToolResult(
			await createAutocodeSessionCreateTool(client, coordinator).execute(
				{ prompt: "Continue", agent: "assist" },
				createToolContext(),
			),
		);

		expect(result).toMatchObject({
			failedAction: "autocode_session_create",
			error: "registration failed",
		});
		expect(client.session.delete).toHaveBeenCalledWith({
			path: { id: "destination/session" },
			query: { directory: worktree },
		});
	});

	test("rejects overlapping source and destination without deleting source", async () => {
		const client = createMockClient({
			createResponse: { data: { id: "source-session" } },
		});
		const coordinator = createPendingAgentRestartCoordinator();

		const result = parseToolResult(
			await createAutocodeSessionCreateTool(client, coordinator).execute(
				{ prompt: "Continue", agent: "assist" },
				createToolContext(),
			),
		);

		expect(result).toMatchObject({
			failedAction: "autocode_session_create",
			error: "Source and destination sessions must be distinct.",
		});
		expect(client.session.delete).not.toHaveBeenCalled();
		expect(client.session.update).not.toHaveBeenCalled();
		expect(client.session.promptAsync).not.toHaveBeenCalled();
		coordinator.dispose();
	});

	test("cleans destination when deferred source archive fails", async () => {
		const client = createMockClient();
		const coordinator = createPendingAgentRestartCoordinator();
		client.session.update.mockImplementation(async () => ({
			error: "rename failed",
		}));

		await createAutocodeSessionCreateTool(client, coordinator).execute(
			{ prompt: "Continue", agent: "assist" },
			createToolContext(),
		);
		await coordinator.handleEvent(sourceTurnEndedEvent());

		expect(client.session.delete).toHaveBeenCalledWith({
			path: { id: "destination/session" },
			query: { directory: worktree },
		});
		expect(client.session.promptAsync).not.toHaveBeenCalled();
		coordinator.dispose();
	});

	test("rejects unavailable lifecycle before destination creation", async () => {
		const client = createMockClient();

		const result = parseToolResult(
			await createAutocodeSessionCreateTool(client).execute(
				{ prompt: "Continue", agent: "assist" },
				createToolContext(),
			),
		);

		expect(result).toMatchObject({ failedAction: "autocode_session_create" });
		expect(client.session.create).not.toHaveBeenCalled();
	});
});
