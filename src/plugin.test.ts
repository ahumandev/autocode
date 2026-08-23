import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Config as PluginHookConfig,
	PluginInput,
	ToolContext,
} from "@opencode-ai/plugin";
import type { Event, OpencodeClient } from "@opencode-ai/sdk";
import type { Config as PluginConfig } from "@opencode-ai/sdk/v2";
import type { SandboxPlatformSupportOptions } from "@/utils/sandbox";
import { createCommands } from "./commands";
import {
	createPendingAgentRestartCoordinator as createActualPendingAgentRestartCoordinator,
	type PendingAgentHandoffRegistration,
	type PendingAgentRestartCoordinator,
	type PendingAgentRestartRegistration,
} from "./hooks/agent_restart_coordinator";
import {
	createManagedScriptLifecycle as createActualManagedScriptLifecycle,
	type ManagedScriptLifecycle,
} from "./hooks/managed_script_lifecycle";
import { createNoopAsk } from "./tools/test_context";
import { createPlatformCapabilities } from "./utils/platform";

let managedScriptLifecycleFactoryOverride:
	| ((...args: Parameters<typeof createActualManagedScriptLifecycle>) => ManagedScriptLifecycle)
	| undefined;
let restartCoordinatorFactoryOverride:
	| ((...args: Parameters<typeof createActualPendingAgentRestartCoordinator>) => PendingAgentRestartCoordinator)
	| undefined;
const actualManagedScriptLifecycles: ManagedScriptLifecycle[] = [];
const actualRestartCoordinators: PendingAgentRestartCoordinator[] = [];
const actualCreateManagedScriptLifecycle = createActualManagedScriptLifecycle;
const actualCreatePendingAgentRestartCoordinator =
	createActualPendingAgentRestartCoordinator;

mock.module("./hooks/managed_script_lifecycle", () => ({
	createManagedScriptLifecycle: (...args: Parameters<typeof createActualManagedScriptLifecycle>): ManagedScriptLifecycle => {
		if (managedScriptLifecycleFactoryOverride) {
			return managedScriptLifecycleFactoryOverride(...args);
		}
		const lifecycle = actualCreateManagedScriptLifecycle(...args);
		actualManagedScriptLifecycles.push(lifecycle);
		return lifecycle;
	},
}));
mock.module("./hooks/agent_restart_coordinator", () => ({
	createPendingAgentRestartCoordinator: (...args: Parameters<typeof createActualPendingAgentRestartCoordinator>): PendingAgentRestartCoordinator => {
		if (restartCoordinatorFactoryOverride) {
			return restartCoordinatorFactoryOverride(...args);
		}
		const coordinator = actualCreatePendingAgentRestartCoordinator(...args);
		actualRestartCoordinators.push(coordinator);
		return coordinator;
	},
}));

const { default: autocode } = await import("./plugin");

afterAll(() => {
	mock.restore();
});

const tempRoots: string[] = [];

type PluginConfigHook = { config?: (input: PluginConfig) => Promise<void> };
type CreateTool = {
	execute(
        args: { prompt?: string; agent: "assist" | "advise" | "auto" | "design" },
		context: ToolContext,
	): Promise<string | { output: string }>;
};
type PluginRestartHooks = PluginConfigHook & {
	event?: (input: { event: Event }) => Promise<void>;
	dispose?: () => Promise<void>;
	tool?: {
		autocode_session_create?: CreateTool;
	};
};
type PluginInputWithSandboxSupportOverride = PluginInput & {
	sandboxSupportOverride?: SandboxPlatformSupportOptions;
	platformOverride?: NodeJS.Platform;
	homeOverride?: string;
};
type PluginAgentConfig = NonNullable<
	NonNullable<PluginHookConfig["agent"]>[string]
>;
type SandboxPermission = NonNullable<PluginAgentConfig["permission"]> & {
	autocode_sandbox_cli?: "ask" | "allow" | "deny";
	task?: { execute_sandbox?: "ask" | "allow" | "deny" };
};
type PluginConfigWithSandboxPermissions = Omit<PluginHookConfig, "agent"> & {
	agent?: Record<
		string,
		| (Omit<PluginAgentConfig, "permission"> & {
				permission?: SandboxPermission;
		  })
		| undefined
	>;
};
type SkillSource = { type: "directory"; path: string };
type V2Plugin = {
	setup(
		context: PluginInputWithSandboxSupportOverride & {
			skill: {
				transform(
					callback: (draft: { source(source: SkillSource): void }) => void,
				): void;
			};
		},
	): Promise<void>;
};
type RestartTestClient = OpencodeClient & {
	session: Pick<
		OpencodeClient["session"],
		"messages" | "summarize" | "promptAsync"
	> & {
		messages: ReturnType<typeof mock>;
		summarize: ReturnType<typeof mock>;
		promptAsync: ReturnType<typeof mock>;
	};
};

async function createTempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "autocode-plugin-test-"));
	tempRoots.push(root);
	return root;
}

async function withEnv(
	entries: Record<string, string | undefined>,
	run: () => Promise<void>,
): Promise<void> {
	const originals = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(entries)) {
		originals.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}

	try {
		await run();
	} finally {
		for (const [key, value] of originals) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function createInput(
	worktree: string,
	sandboxSupportOverride: SandboxPlatformSupportOptions = {
		platform: "linux",
		env: {},
		bwrapUsable: true,
	},
): PluginInputWithSandboxSupportOverride {
	return {
		worktree,
		directory: worktree,
		client: {},
		sandboxSupportOverride,
	} as PluginInputWithSandboxSupportOverride;
}

async function registerGeneratedSkills(
	input: PluginInputWithSandboxSupportOverride,
): Promise<SkillSource[]> {
	const sources: SkillSource[] = [];
	await (autocode as unknown as V2Plugin).setup({
		...input,
		skill: {
			transform(callback) {
				callback({
					source(source) {
						sources.push(source);
					},
				});
			},
		},
	});
	return sources;
}

function skillPermissions(
	config: PluginConfig,
	agentName: string,
): Record<string, unknown> | undefined {
	const permission = config.agent?.[agentName]?.permission;
	if (!permission || typeof permission === "string") return undefined;
	const skill = (permission as Record<string, unknown>).skill;
	return skill && typeof skill !== "string"
		? (skill as Record<string, unknown>)
		: undefined;
}

afterEach(async () => {
	await Promise.all([
		...actualManagedScriptLifecycles.splice(0).map((lifecycle) => lifecycle.dispose()),
		...actualRestartCoordinators.splice(0).map((coordinator) => coordinator.dispose()),
	]);
	managedScriptLifecycleFactoryOverride = undefined;
	restartCoordinatorFactoryOverride = undefined;
	await Promise.all(
		tempRoots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("autocode plugin config", () => {
	test("runtime exposes create and restart session tools", async () => {
		const root = await createTempRoot();
		const hooks = (await autocode(
			createInput(join(root, "worktree")),
		)) as unknown as PluginRestartHooks;

		expect(hooks.tool?.autocode_session_create).toBeDefined();
	});

	test("forwards each plugin event to managed lifecycle before restart handling", async () => {
		const root = await createTempRoot();
		const order: string[] = [];
		const lifecycle: ManagedScriptLifecycle = {
			registerStart: mock((): void => {}),
			handleEvent: mock(async (): Promise<void> => {
				order.push("managed-lifecycle");
			}),
			dispose: mock(async (): Promise<void> => {}),
		};
		const restartCoordinator: PendingAgentRestartCoordinator = {
			register: mock((): PendingAgentRestartRegistration => "registered"),
			registerHandoff: mock((): PendingAgentHandoffRegistration => ({
				status: "registered",
				sourceSessionID: "source-session",
				destinationSessionID: "destination-session",
			})),
			handleEvent: mock(async (): Promise<void> => {
				order.push("restart-coordinator");
			}),
			dispose: mock((): void => {}),
			pendingCount: mock((): number => 0),
		};
		managedScriptLifecycleFactoryOverride = () => lifecycle;
		restartCoordinatorFactoryOverride = () => restartCoordinator;
		const hooks = (await autocode(createInput(join(root, "worktree")))) as unknown as PluginRestartHooks;
		if (!hooks.event) throw new Error("plugin event hook unavailable");
		const event = {
			type: "session.status",
			properties: { sessionID: "session-1", status: { type: "idle" } },
		} as unknown as Event;

		await hooks.event({ event });

		expect(lifecycle.handleEvent).toHaveBeenCalledWith(event);
		expect(restartCoordinator.handleEvent).toHaveBeenCalledWith(event);
		expect(order).toEqual(["managed-lifecycle", "restart-coordinator"]);
	});

	test("awaits managed lifecycle disposal while invoking restart disposal", async () => {
		const root = await createTempRoot();
		const order: string[] = [];
		let releaseLifecycleCleanup: (() => void) | undefined;
		const lifecycleCleanup = new Promise<void>((resolve) => {
			releaseLifecycleCleanup = resolve;
		});
		const lifecycle: ManagedScriptLifecycle = {
			registerStart: mock((): void => {}),
			handleEvent: mock(async (): Promise<void> => {}),
			dispose: mock(async (): Promise<void> => {
				order.push("managed-cleanup");
				await lifecycleCleanup;
				order.push("managed-cleanup-complete");
			}),
		};
		const restartCoordinator: PendingAgentRestartCoordinator = {
			register: mock((): PendingAgentRestartRegistration => "registered"),
			registerHandoff: mock((): PendingAgentHandoffRegistration => ({
				status: "registered",
				sourceSessionID: "source-session",
				destinationSessionID: "destination-session",
			})),
			handleEvent: mock(async (): Promise<void> => {}),
			dispose: mock((): void => {
				order.push("restart-dispose");
			}),
			pendingCount: mock((): number => 0),
		};
		managedScriptLifecycleFactoryOverride = () => lifecycle;
		restartCoordinatorFactoryOverride = () => restartCoordinator;
		const hooks = (await autocode(createInput(join(root, "worktree")))) as unknown as PluginRestartHooks;
		if (!hooks.dispose || !releaseLifecycleCleanup) throw new Error("plugin dispose hook unavailable");
		let disposeComplete = false;
		const disposing = hooks.dispose().then((): void => {
			disposeComplete = true;
		});

		expect(order).toEqual(["managed-cleanup", "restart-dispose"]);
		expect(disposeComplete).toBe(false);
		releaseLifecycleCleanup();
		await disposing;

		expect(order).toEqual(["managed-cleanup", "restart-dispose", "managed-cleanup-complete"]);
		expect(disposeComplete).toBe(true);
	});

	test("contains lifecycle cleanup rejection after disposing restart coordinator", async () => {
		const root = await createTempRoot();
		const order: string[] = [];
		const lifecycle: ManagedScriptLifecycle = {
			registerStart: mock((): void => {}),
			handleEvent: mock(async (): Promise<void> => {}),
			dispose: mock(async (): Promise<void> => {
				order.push("managed-cleanup");
				throw new Error("managed cleanup denied");
			}),
		};
		const restartCoordinator: PendingAgentRestartCoordinator = {
			register: mock((): PendingAgentRestartRegistration => "registered"),
			registerHandoff: mock((): PendingAgentHandoffRegistration => ({
				status: "registered",
				sourceSessionID: "source-session",
				destinationSessionID: "destination-session",
			})),
			handleEvent: mock(async (): Promise<void> => {}),
			dispose: mock((): void => {
				order.push("restart-dispose");
			}),
			pendingCount: mock((): number => 0),
		};
		managedScriptLifecycleFactoryOverride = () => lifecycle;
		restartCoordinatorFactoryOverride = () => restartCoordinator;
		const originalWarn = console.warn;
		const warn = mock((): void => {});
		console.warn = warn;
		try {
			const hooks = (await autocode(createInput(join(root, "worktree")))) as unknown as PluginRestartHooks;
			if (!hooks.dispose) throw new Error("plugin dispose hook unavailable");

			await hooks.dispose();
		} finally {
			console.warn = originalWarn;
		}

		expect(order).toEqual(["managed-cleanup", "restart-dispose"]);
		expect(warn).toHaveBeenCalledWith(
			"autocode: plugin lifecycle cleanup failed: managed cleanup denied",
		);
	});

	test("uses PluginInput server URL when AUTOCODE_WEB_URL is absent", async () => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await writeFile(
			join(worktree, ".opencode", "autocode.jsonc"),
			JSON.stringify({
				autocode: { tiers: { balanced: { model: "openai/gpt-5.5" } } },
			}),
		);
		const client = {
			session: {
				get: mock(async () => ({ data: { title: "Source session" } })),
				create: mock(async () => ({ data: { id: "destination-session" } })),
			},
		} as unknown as OpencodeClient;
		const context: ToolContext = {
			sessionID: "source-session",
			messageID: "source-message",
			agent: "assist",
			directory: worktree,
			worktree,
			abort: new AbortController().signal,
			metadata() {},
			ask: createNoopAsk(),
		};

		await withEnv(
			{
				AUTOCODE_WEB_URL: "http://127.0.0.1:3200"
			},
			async () => {
				const hooks = (await autocode({
					...createInput(worktree),
					client,
					serverUrl: new URL("http://127.0.0.1:4444/"),
				})) as unknown as PluginRestartHooks;
				const createTool = hooks.tool?.autocode_session_create;
				if (!createTool) throw new Error("session-create tool unavailable");

				process.env.AUTOCODE_WEB_URL = "http://127.0.0.1:3300";
				const result = await createTool.execute(
					{ prompt: "Continue", agent: "assist" },
					context,
				);
				const message = JSON.parse(
					typeof result === "string" ? result : result.output,
				).message as string;
				const link = message.match(/\]\(([^)]+)\)/)?.[1];
				const encodedServerUrl = Buffer.from(
					"http://127.0.0.1:4444",
					"utf8",
				).toString("base64url");

				expect(link).toBe(
					`http://127.0.0.1:3300/server/${encodedServerUrl}/session/destination-session`,
				);
			},
		);
	});

	test("runs one deferred restart only after matching idle status", async () => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await writeFile(
			join(worktree, ".opencode", "autocode.jsonc"),
			JSON.stringify({
				autocode: { tiers: { balanced: { model: "openai/gpt-5" } } },
			}),
		);
		const order: string[] = [];
		const client = {
			session: {
				get: mock(async () => ({ data: { title: "Source session" } })),
				create: mock(async () => {
					order.push("create");
					return { data: { id: "destination-session" } };
				}),
				update: mock(async () => {
					order.push("archive");
					return { data: true };
				}),
				messages: mock(async () => ({
					data: [
						{
							info: {
								id: "user-1",
								role: "user",
								agent: "assist",
								time: { created: 1 },
							},
							parts: [],
						},
					],
				})),
				summarize: mock(async () => {
					order.push("summarize");
					return { data: true };
				}),
				promptAsync: mock(async () => {
					order.push("prompt");
					return {};
				}),
			},
		} as unknown as RestartTestClient;
		const hooks = (await autocode({
			...createInput(worktree),
			client,
		})) as unknown as PluginRestartHooks;
		const createTool = hooks.tool?.autocode_session_create;
		if (!createTool || !hooks.event)
			throw new Error("restart lifecycle hooks unavailable");
		const context: ToolContext = {
			sessionID: "session-1",
			messageID: "message-1",
			agent: "assist",
			directory: worktree,
			worktree,
			abort: new AbortController().signal,
			metadata() {},
			ask: createNoopAsk(),
		};

		const result = await createTool.execute(
			{ prompt: "Resume compacted session", agent: "advise" },
			context,
		);

		expect(
			JSON.parse(typeof result === "string" ? result : result.output),
		).toMatchObject({
			session_id: "destination-session",
			session_title: "Source session (advise)",
			message:
				"Created new session for advise: Source session (advise) (destination-session). Handoff registered.",
		});
		expect(client.session.summarize).not.toHaveBeenCalled();
		await hooks.event({
			event: {
				type: "session.status",
				properties: { sessionID: "session-1", status: { type: "idle" } },
			} as unknown as Event,
		});

		expect(order).toEqual(["create", "archive", "prompt"]);
		expect(client.session.summarize).not.toHaveBeenCalled();
		expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
	});

	test("forwards title tool events while preserving deferred restart handling", async () => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await writeFile(
			join(worktree, ".opencode", "autocode.jsonc"),
			JSON.stringify({
				autocode: { tiers: { balanced: { model: "openai/gpt-5" } } },
			}),
		);
		const updates: unknown[] = [];
		const client = {
			session: {
				get: mock(async ({ path }: { path: { id: string } }) => ({
					data: {
						id: path.id,
						title: "Source session",
						...(path.id === "session-1" ? {} : { parentID: "session-1" }),
					},
				})),
				create: mock(async () => ({ data: { id: "destination-session" } })),
				messages: mock(async () => ({
					data: [{
						info: { id: "message-1", role: "assistant", agent: "assist" },
						parts: [{ type: "text", text: "# 🚀 Plugin title" }],
					}],
				})),
				update: mock(async (input: unknown) => {
					updates.push(input);
					return { data: true };
				}),
				promptAsync: mock(async () => ({})),
			},
		} as unknown as RestartTestClient;
		const hooks = (await autocode({
			...createInput(worktree),
			client,
		})) as unknown as PluginRestartHooks;
		const createTool = hooks.tool?.autocode_session_create;
		if (!createTool || !hooks.event)
			throw new Error("plugin lifecycle hooks unavailable");
		const context: ToolContext = {
			sessionID: "session-1",
			messageID: "message-1",
			agent: "assist",
			directory: worktree,
			worktree,
			abort: new AbortController().signal,
			metadata() {},
			ask: createNoopAsk(),
		};

		await createTool.execute({ prompt: "Resume", agent: "advise" }, context);
		await hooks.event({
			event: {
				type: "message.part.updated",
				properties: {
					sessionID: "session-1",
					part: { type: "tool", messageID: "message-1" },
				},
			} as unknown as Event,
		});
		await hooks.event({
			event: {
				type: "session.status",
				properties: { sessionID: "session-1", status: { type: "idle" } },
			} as unknown as Event,
		});

		expect(updates).toContainEqual({
			path: { id: "session-1" },
			query: { directory: worktree },
			body: { title: "Source session (🚀 Plugin title)" },
		});
		expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
	});

	test("defers plugin-wired session-create handoff until matching source idle event", async () => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await writeFile(
			join(worktree, ".opencode", "autocode.jsonc"),
			JSON.stringify({
				autocode: {
					tiers: { smart: { model: "openai/gpt-5.5", variant: "thinking" } },
				},
			}),
		);
		const order: string[] = [];
		const sourceGet = mock(async () => ({ data: { title: "Source session" } }));
		const sessionCreate = mock(async () => {
			order.push("create");
			return { data: { id: "destination-session" } };
		});
		const sourceUpdate = mock(async () => {
			order.push("archive");
			return { data: true };
		});
		const destinationPrompt = mock(async () => {
			order.push("prompt");
			return {};
		});
		const client = {
			session: {
				get: sourceGet,
				create: sessionCreate,
				update: sourceUpdate,
				promptAsync: destinationPrompt,
			},
		} as unknown as OpencodeClient;
		const hooks = (await autocode({
			...createInput(worktree),
			client,
		})) as unknown as PluginRestartHooks;
		const createTool = hooks.tool?.autocode_session_create;
		if (!createTool || !hooks.event)
			throw new Error("session-create lifecycle hooks unavailable");
		const context: ToolContext = {
			sessionID: "source-session",
			messageID: "source-message",
			agent: "assist",
			directory: worktree,
			worktree,
			abort: new AbortController().signal,
			metadata() {},
			ask: createNoopAsk(),
		};

		const result = await createTool.execute(
			{ prompt: "Implement exact handoff", agent: "auto" },
			context,
		);

		expect(
			JSON.parse(typeof result === "string" ? result : result.output),
		).toMatchObject({
			session_id: "destination-session",
		});
		expect(order).toEqual(["create"]);
		expect(sourceUpdate).not.toHaveBeenCalled();
		expect(destinationPrompt).not.toHaveBeenCalled();

		await hooks.event({
			event: {
				type: "session.idle",
				properties: { sessionID: "unrelated-session" },
			} as unknown as Event,
		});

		expect(order).toEqual(["create"]);
		expect(sourceUpdate).not.toHaveBeenCalled();
		expect(destinationPrompt).not.toHaveBeenCalled();

		const event = {
			type: "session.status",
			properties: { sessionID: "source-session", status: { type: "idle" } },
		} as unknown as Event;
		await Promise.all([hooks.event({ event }), hooks.event({ event })]);

		expect(order).toEqual(["create", "archive", "prompt"]);
		expect(sourceUpdate).toHaveBeenCalledWith({
			path: { id: "source-session" },
			query: { directory: worktree },
			body: {
				title: expect.stringMatching(
					/^Source session \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/,
				),
			},
		});
		expect(sourceUpdate).toHaveBeenCalledTimes(1);
		expect(destinationPrompt).toHaveBeenCalledWith({
			path: { id: "destination-session" },
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
		expect(destinationPrompt).toHaveBeenCalledTimes(1);
	});

	test("merges plugin config while preserving user command and agent overrides", async () => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		const configHome = join(root, "xdg");
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await writeFile(
			join(worktree, ".opencode", "autocode.jsonc"),
			JSON.stringify({
				autocode: {
					tiers: {
						cheap: { model: "cheap-model", variant: "high" },
						fast: { model: "fast-model" },
						balanced: { model: "balanced-model", variant: "balanced-variant" },
						smart: { model: "smart-model" },
					},
				},
				permission: {
					external_directory: {
						"/configured/*": "allow",
					},
				},
			}),
		);

		await withEnv(
			{
				XDG_CONFIG_HOME: configHome,
				HOME: root,
				AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP: "1",
			},
			async () => {
				const cfg: PluginConfig = {
					agent: {
						assist: {
							model: "user-model",
							permission: {
								question: "allow",
								task_external: "ask",
							},
						},
					},
					command: {
						"job-execute": {
							description: "user description",
							template: "user template",
							subtask: true,
						},
					},
					permission: {
						external_directory: {
							"/native/*": "ask",
							"/configured/*": "deny",
						},
					},
				};
				const input = { ...createInput(worktree), homeOverride: root };
				const hooks = (await autocode(input)) as unknown as PluginConfigHook;
				const commands = createCommands(createPlatformCapabilities("linux"));

				await hooks.config?.(cfg);

				expect(cfg.small_model).toBe("cheap-model");
				expect(cfg.agent?.title).toEqual(
					expect.objectContaining({
						model: "cheap-model",
						variant: "high",
					}),
				);
				expect(cfg.agent?.title?.options?.reasoningEffort).toBeUndefined();
				expect(cfg.agent?.compaction?.model).toBeUndefined();
				expect(cfg.command?.["job-execute"]).toEqual(
					expect.objectContaining({
						description: "user description",
						template: "user template",
						subtask: true,
					}),
				);
				expect(cfg.command?.["job-execute"]?.agent).toBe("design");
				expect(cfg.command?.["job-facilitate"]?.template).toContain(
					"autocode_job_execute",
				);
				expect(Object.keys(cfg.command ?? {})).toEqual([
					"job-execute",
					"job-concepts",
					"job-design",
					"job-facilitate",
					"assist",
					"new-advise",
					"new-assist",
					"new-auto",
					"new-design",
					"new-fix",
					"autocode-install",
					"autocode-version",
					"author",
					"commit",
					"docs",
					"docs-conventions",
					"docs-code",
					"docs-env",
					"docs-prd",
					"docs-ux",
					"explain",
					"git-conflict",
					"init",
					"learn",
					"repeat-as-md",
					"repeat-as-wiki",
					"report",
					"resume",
					"tests",
				]);
				for (const [name, commandDef] of Object.entries(commands)) {
					if (name === "job-execute") continue;
					expect(cfg.command?.[name]).toEqual(commandDef);
				}
				expect(cfg.command?.["job-execute"]).toEqual({
					...commands["job-execute"],
					description: "user description",
					template: "user template",
					subtask: true,
				});
				expect(cfg.agent?.assist?.model).toBe("user-model");
				expect(cfg.agent?.assist?.variant).toBe("balanced-variant");
				const assist = cfg.agent?.assist;
				const design = cfg.agent?.design;
				const assistPermission = assist?.permission;
				expect(
					((assist ?? {}) as Record<string, unknown>).tier,
				).toBeUndefined();
				expect(cfg.agent?.design?.model).toBe("balanced-model");
				expect(
					((design ?? {}) as Record<string, unknown>).tier,
				).toBeUndefined();
				expect(
					((assistPermission ?? {}) as Record<string, unknown>)
						.external_directory,
				).toEqual({
					"*": "ask",
					"/native/*": "ask",
					"/configured/*": "allow",
				});
				expect(await registerGeneratedSkills(input)).toContainEqual({
					type: "directory",
					path: join(root, ".agents", "skills", "autocode"),
				});

				const explicitTitleConfig: PluginConfig = {
					agent: {
						title: {
							options: {
								reasoningEffort: "high",
							},
						},
					},
				};
				await hooks.config?.(explicitTitleConfig);

				expect(explicitTitleConfig.agent?.title?.options?.reasoningEffort).toBe(
					"high",
				);
			},
		);
	});

	test("Windows removes sandbox exposure from user agent overrides", async () => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		await withEnv({ PSModulePath: undefined }, async () => {
			const cfg: PluginConfigWithSandboxPermissions = {
				agent: {
					execute_sandbox: {
						prompt: "sandbox guidance",
						permission: { autocode_sandbox_cli: "allow" },
					},
					assist: {
						prompt: "use sandbox guidance",
						permission: {
							autocode_sandbox_cli: "allow",
							task: { execute_sandbox: "allow" },
						},
					},
				},
			};
			const input: PluginInputWithSandboxSupportOverride = {
				...createInput(worktree),
				platformOverride: "win32",
			};
			const hooks = await autocode(input);

			await hooks.config?.(cfg as PluginHookConfig);

			expect(cfg.agent?.execute_sandbox).toBeUndefined();
			for (const toolName of [
				"autocode_sandbox_create",
				"autocode_sandbox_cli",
				"autocode_sandbox_delete",
				"autocode_sandbox_edit",
				"autocode_sandbox_glob",
				"autocode_sandbox_grep",
				"autocode_sandbox_read",
				"autocode_sandbox_copy",
				"autocode_sandbox_config_edit",
				"autocode_sandbox_config_read",
				"autocode_sandbox_config_remove",
			]) {
				expect(hooks.tool).not.toHaveProperty(toolName);
			}
			for (const agent of Object.values(cfg.agent ?? {})) {
				expect(agent).toBeDefined();
				if (agent === undefined)
					throw new Error("agent override unexpectedly undefined");
				const permission = agent.permission;
				const rules =
					permission && typeof permission !== "string"
						? (permission as Record<string, unknown>)
						: undefined;
				for (const toolName of [
					"autocode_sandbox_create",
					"autocode_sandbox_cli",
					"autocode_sandbox_delete",
					"autocode_sandbox_edit",
					"autocode_sandbox_glob",
					"autocode_sandbox_grep",
					"autocode_sandbox_read",
					"autocode_sandbox_copy",
					"autocode_sandbox_config_edit",
					"autocode_sandbox_config_read",
					"autocode_sandbox_config_remove",
				]) {
					expect(rules?.[toolName]).toBeUndefined();
				}
				const task = rules?.task;
				const taskRules =
					task && typeof task === "object"
						? (task as Record<string, unknown>)
						: undefined;
				expect(taskRules?.execute_sandbox).toBeUndefined();
				expect(`${agent.description ?? ""}\n${agent.prompt ?? ""}`).not.toMatch(
					/sandbox/i,
				);
			}
			for (const agentName of ["execute_os", "query_os"] as const) {
				expect(cfg.agent?.[agentName]?.prompt).toMatch(/cmd commands/i);
				expect(cfg.agent?.[agentName]?.prompt).toMatch(/never use bash/i);
			}
			expect(cfg.command?.['autocode-install']?.template).toContain("Run commands in CMD");
		});
	});

	test("Linux preserves supported sandbox registrations and Bash guidance", async () => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		const hooks = await autocode(createInput(worktree));
		const cfg: PluginConfig = {};

		await hooks.config?.(cfg as unknown as PluginHookConfig);

		expect(cfg.agent?.execute_sandbox).toBeDefined();
		for (const toolName of [
			"autocode_sandbox_create",
			"autocode_sandbox_cli",
			"autocode_sandbox_delete",
			"autocode_sandbox_edit",
			"autocode_sandbox_glob",
			"autocode_sandbox_grep",
			"autocode_sandbox_read",
			"autocode_sandbox_copy",
			"autocode_sandbox_config_edit",
			"autocode_sandbox_config_read",
			"autocode_sandbox_config_remove",
		]) {
			expect(hooks.tool).toHaveProperty(toolName);
		}
		expect(cfg.agent?.execute_os?.prompt).toMatch(
			/always use the `bash` tool/i,
		);
		expect(cfg.agent?.query_os?.prompt).toMatch(
			/prefer other tools over `bash` tool/i,
		);
		expect(cfg.command?.['autocode-install']?.template).toContain(
			"If bwrap install is needed",
		);
	});

	test("PowerShell startup assigns PowerShell-only OS prompts", async () => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");

		await withEnv({ PSModulePath: "present" }, async () => {
			const input: PluginInputWithSandboxSupportOverride = {
				...createInput(worktree),
				platformOverride: "win32",
			};
			const hooks = await autocode(input);
			const cfg: PluginConfig = {};
			await hooks.config?.(cfg as unknown as PluginHookConfig);

			for (const agentName of ["execute_os", "query_os"] as const) {
				expect(cfg.agent?.[agentName]?.prompt).toMatch(/windows powershell/i);
				expect(cfg.agent?.[agentName]?.prompt).not.toMatch(/cmd commands/i);
			}
			expect(cfg.command?.['autocode-install']?.template).toContain("Run commands in CMD");
		});
	});

	test("Linux startup config prepends Bun bin using POSIX paths", async (): Promise<void> => {
		const root = await createTempRoot();
		const home = `${root}/Jane Doe`;
		const originalPath = "/usr/local/bin:/usr/bin:/custom/bin";

		await withEnv(
			{ HOME: home, PATH: originalPath, BUN_INSTALL: undefined },
			async (): Promise<void> => {
				const input: PluginInputWithSandboxSupportOverride = {
					...createInput(join(root, "worktree")),
					homeOverride: home,
				};
				const hooks = (await autocode(input)) as unknown as PluginConfigHook;
				await hooks.config?.({});

				expect(process.env.BUN_INSTALL).toBe(`${home}/.bun`);
				expect(process.env.PATH).toBe(`${home}/.bun/bin:${originalPath}`);
			},
		);
	});

	test("Windows startup config prepends Bun bin using Windows paths", async (): Promise<void> => {
		const root = await createTempRoot();
		const home = "C:\\Users\\Jane Doe";
		const originalPath = "C:\\Windows\\System32;C:\\Tools\\bin";
		const worktree = join(root, "worktree");
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await writeFile(
			join(worktree, ".opencode", "autocode.jsonc"),
			JSON.stringify({ autocode: { skills: { freeze: true } } }),
		);

		await withEnv(
			{ HOME: undefined, PATH: originalPath, BUN_INSTALL: undefined },
			async (): Promise<void> => {
				const input: PluginInputWithSandboxSupportOverride = {
					...createInput(worktree),
					platformOverride: "win32",
					homeOverride: home,
				};
				const hooks = (await autocode(input)) as unknown as PluginConfigHook;
				await hooks.config?.({});

				expect(process.env.BUN_INSTALL).toBe("C:\\Users\\Jane Doe\\.bun");
				expect(process.env.PATH).toBe(
					`C:\\Users\\Jane Doe\\.bun\\bin;${originalPath}`,
				);
			},
		);
	});

	test("startup reconciliation makes no network calls", async () => {
		const root = await createTempRoot();
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = Object.assign(
			async (..._args: Parameters<typeof fetch>): Promise<Response> => {
				fetchCalls += 1;
				throw new Error("network must not run during startup");
			},
			{ preconnect: originalFetch.preconnect.bind(originalFetch) },
		);

		try {
			await withEnv(
				{ XDG_CONFIG_HOME: join(root, "xdg"), HOME: root },
				async () => {
					const input: PluginInputWithSandboxSupportOverride = {
						...createInput(join(root, "worktree")),
						homeOverride: root,
					};
					const hooks = (await autocode(input)) as unknown as PluginConfigHook;
					await hooks.config?.({});
				},
			);
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(fetchCalls).toBe(0);
	});

	test("frozen skills skip startup writes and network while exposing existing generated root", async () => {
		const root = await createTempRoot();
		const configHome = join(root, "xdg");
		const worktree = join(root, "worktree");
		const generatedRoot = join(root, ".agents", "skills", "autocode");
		const existingSkill = join(generatedRoot, "existing", "SKILL.md");
		await mkdir(join(configHome, "opencode"), { recursive: true });
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await mkdir(join(generatedRoot, "existing"), { recursive: true });
		await writeFile(
			join(configHome, "opencode", "autocode.jsonc"),
			JSON.stringify({ autocode: { skills: { freeze: false } } }),
		);
		await writeFile(
			join(worktree, ".opencode", "autocode.jsonc"),
			JSON.stringify({ autocode: { skills: { freeze: true } } }),
		);
		await writeFile(existingSkill, "pre-existing skill");
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = Object.assign(
			async (..._args: Parameters<typeof fetch>): Promise<Response> => {
				fetchCalls += 1;
				throw new Error("network must not run during frozen startup");
			},
			{ preconnect: originalFetch.preconnect.bind(originalFetch) },
		);

		try {
			await withEnv({ XDG_CONFIG_HOME: configHome, HOME: root }, async () => {
				const input = { ...createInput(worktree), homeOverride: root };
				const hooks = (await autocode(input)) as unknown as PluginConfigHook;
				const cfg: PluginConfig = {};
				await hooks.config?.(cfg);

				expect(await registerGeneratedSkills(input)).toContainEqual({
					type: "directory",
					path: generatedRoot,
				});
			});
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(await readdir(generatedRoot)).toEqual(["existing"]);
		expect(await Bun.file(existingSkill).text()).toBe("pre-existing skill");
		expect(fetchCalls).toBe(0);
	});

	test("legacy skill URL has no startup fetch, grant, or generated-file effect", async () => {
		const root = await createTempRoot();
		const configHome = join(root, "xdg");
		const worktree = join(root, "worktree");
		const legacyUrl =
			"https://github.com/example/legacy-startup-url/blob/main/SKILL.md";
		await mkdir(join(configHome, "opencode"), { recursive: true });
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await writeFile(
			join(configHome, "opencode", "autocode.jsonc"),
			JSON.stringify({ autocode: { skills: { freeze: false } } }),
		);
		await writeFile(
			join(worktree, ".opencode", "autocode.jsonc"),
			JSON.stringify({
				autocode: { skills: { freeze: true, bash: [legacyUrl] } },
			}),
		);
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = Object.assign(
			async (..._args: Parameters<typeof fetch>): Promise<Response> => {
				fetchCalls += 1;
				throw new Error("legacy URL must not fetch during startup");
			},
			{ preconnect: originalFetch.preconnect.bind(originalFetch) },
		);

		try {
			await withEnv({ XDG_CONFIG_HOME: configHome, HOME: root }, async () => {
				const input = { ...createInput(worktree), homeOverride: root };
				const hooks = (await autocode(input)) as unknown as PluginConfigHook;
				const cfg: PluginConfig = {};
				await hooks.config?.(cfg);

				expect(
					skillPermissions(cfg, "execute_os")?.["legacy-startup-url"],
				).toBeUndefined();
				expect(await registerGeneratedSkills(input)).toContainEqual({
					type: "directory",
					path: join(root, ".agents", "skills", "autocode"),
				});
			});
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(fetchCalls).toBe(0);
		expect(
			await readdir(join(root, ".agents", "skills")).catch(() => []),
		).toEqual([]);
	});

	test("manifest skills grant matching category agents without duplicate grants", async () => {
		const root = await createTempRoot();
		const configHome = join(root, "xdg");
		const worktree = join(root, "worktree");
		await mkdir(join(configHome, "opencode"), { recursive: true });
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await writeFile(
			join(configHome, "opencode", "autocode.jsonc"),
			JSON.stringify({ autocode: { skills: { freeze: false } } }),
		);
		await writeFile(
			join(worktree, ".opencode", "autocode.jsonc"),
			JSON.stringify({ autocode: { skills: { freeze: true } } }),
		);

		await withEnv({ XDG_CONFIG_HOME: configHome, HOME: root }, async () => {
			const input: PluginInputWithSandboxSupportOverride = {
				...createInput(worktree),
				homeOverride: root,
			};
			const hooks = (await autocode(input)) as unknown as PluginConfigHook;
			const cfg: PluginConfig = {};
			await hooks.config?.(cfg);

			expect(skillPermissions(cfg, "execute_code")?.["angular-developer"]).toBe(
				"allow",
			);
			expect(
				skillPermissions(cfg, "execute_os")?.["angular-developer"],
			).toBeUndefined();
			expect(skillPermissions(cfg, "auto_test")?.vitest).toBe("allow");
			expect(skillPermissions(cfg, "assist")?.["codebase-design"]).toBe(
				"allow",
			);
			expect(skillPermissions(cfg, "auto")?.["codebase-design"]).toBe("allow");
			expect(skillPermissions(cfg, "design")?.["codebase-design"]).toBe(
				"allow",
			);
			const grants = Object.keys(skillPermissions(cfg, "execute_code") ?? {});
			expect(new Set(grants).size).toBe(grants.length);
		});
	});
});
