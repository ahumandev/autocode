import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import * as promiseFileSystem from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
import { createNoopAsk, createToolContext } from "./tools/test_context";
import { createTools } from "./tools";
import * as skillModule from "./tools/skill";
import { getBundledSkillsRoot, managedSkills } from "./skills";
import { initializeAutocodeGitExclude as initializeActualAutocodeGitExclude } from "./utils/git_exclude";
import { createPlatformCapabilities } from "./utils/platform";
import { permissionEffect, type PermissionRule } from "./utils/permissions";

let managedScriptLifecycleFactoryOverride:
	| ((...args: Parameters<typeof createActualManagedScriptLifecycle>) => ManagedScriptLifecycle)
	| undefined;
let restartCoordinatorFactoryOverride:
	| ((...args: Parameters<typeof createActualPendingAgentRestartCoordinator>) => PendingAgentRestartCoordinator)
	| undefined;
const actualManagedScriptLifecycles: ManagedScriptLifecycle[] = [];
const actualRestartCoordinators: PendingAgentRestartCoordinator[] = [];
const actualInitializeAutocodeGitExclude = initializeActualAutocodeGitExclude;
const actualCreateManagedScriptLifecycle = createActualManagedScriptLifecycle;
const actualCreatePendingAgentRestartCoordinator =
	createActualPendingAgentRestartCoordinator;
const initializeGitExclude = mock(async (_directory: string): Promise<void> => {});

mock.module("./utils/git_exclude", () => ({
	initializeAutocodeGitExclude: initializeGitExclude,
}));

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

afterAll((): void => {
	mock.restore();
	mock.module("./utils/git_exclude", () => ({
		initializeAutocodeGitExclude: actualInitializeAutocodeGitExclude,
	}));
	mock.module("./hooks/managed_script_lifecycle", () => ({
		createManagedScriptLifecycle: actualCreateManagedScriptLifecycle,
	}));
	mock.module("./hooks/agent_restart_coordinator", () => ({
		createPendingAgentRestartCoordinator: actualCreatePendingAgentRestartCoordinator,
	}));
});

const tempRoots: string[] = [];
let originalConfigDir: string | undefined;

beforeEach(async (): Promise<void> => {
	initializeGitExclude.mockClear();
	originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
	process.env.OPENCODE_CONFIG_DIR = await createTempRoot();
});

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
type V2SkillDefinition = {
	id: string;
	name: string;
	description?: string;
	path: string;
	content: string;
};
type V2Plugin = {
	setup(
		context: unknown,
	): Promise<(() => Promise<void> | void) | void>;
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
		platformOverride: "linux",
	} as PluginInputWithSandboxSupportOverride;
}

async function registerGeneratedSkills(
	input: PluginInputWithSandboxSupportOverride,
): Promise<V2SkillDefinition[]> {
	const skills: V2SkillDefinition[] = [];
	const agents = new Map<string, Record<string, unknown>>();
	const registration = { async dispose(): Promise<void> {} };
	const transform = async (callback: (editor: unknown) => void, editor: unknown): Promise<typeof registration> => {
		callback(editor);
		return registration;
	};
	const context = {
		...input,
		location: {
			directory: input.directory,
			project: { id: "test-project", directory: input.worktree, canonical: input.worktree },
		},
		agent: {
			transform: async (callback: (editor: unknown) => void) => transform(callback, {
				get(id: string): Record<string, unknown> | undefined {
					return agents.get(id);
				},
				remove(id: string): void {
					agents.delete(id);
				},
				update(id: string, update: (agent: Record<string, unknown>) => void): void {
					const agent = agents.get(id) ?? {
						id,
						name: id,
						request: { settings: {}, headers: {}, body: {} },
						mode: "primary",
						hidden: false,
						permissions: [],
					};
					update(agent);
					agents.set(id, agent);
				},
			}),
		},
		skill: {
			transform: async (callback: (editor: unknown) => void) => transform(callback, {
				add(skill: V2SkillDefinition): void {
					skills.push(skill);
				},
			}),
		},
		command: {
			transform: async (callback: (editor: unknown) => void) => transform(callback, { add(): void {} }),
		},
		tool: {
			transform: async (callback: (editor: unknown) => void) => transform(callback, { add(): void {} }),
		},
		session: {
			hook: async (): Promise<typeof registration> => registration,
		},
		shell: {
			hook: async (): Promise<typeof registration> => registration,
		},
		event: {
			async *subscribe(): AsyncIterable<never> {},
		},
	};
	const cleanup = await (autocode as unknown as V2Plugin).setup(context);
	await cleanup?.();
	return skills;
}

function skillPermissions(
	config: PluginConfig,
	agentName: string,
): Record<string, unknown> | undefined {
	const rules = config.agent?.[agentName]?.permissions;
	return Array.isArray(rules) ? Object.fromEntries((rules as PermissionRule[]).filter((rule) => rule.action === "skill").map((rule) => [rule.resource, rule.effect])) : undefined;
}

afterEach(async () => {
	try {
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
	} finally {
		if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
		else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
	}
});

describe("autocode plugin config", () => {
	test("split memory agents retain loaded directory snapshot across config callbacks", async (): Promise<void> => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		const directory = join(worktree, "project");
		const configPath = join(worktree, ".opencode", "autocode.jsonc");
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await mkdir(directory, { recursive: true });
		for (const name of ["first-memory", "second-memory"]) {
			await mkdir(join(directory, name), { recursive: true });
			await writeFile(join(directory, name, "INDEX.md"), `# ${name}\n`);
		}
		const writeConfig = async (memoryDirectory: string): Promise<void> => {
			await writeFile(configPath, JSON.stringify({ autocode: { skills: { freeze: true }, memory: { directory: memoryDirectory } } }));
		};
		await writeConfig("first-memory");

		await withEnv({ HOME: root, XDG_CONFIG_HOME: join(root, "xdg"), PATH: process.env.PATH, BUN_INSTALL: process.env.BUN_INSTALL }, async (): Promise<void> => {
			const input = { ...createInput(worktree), directory, homeOverride: root };
			const hooks = await autocode.server(input);
			try {
				if (!hooks.config) throw new Error("plugin config hook unavailable");
				const first: PluginConfig = {};
				await hooks.config(first as unknown as PluginHookConfig);
				expect(first.agent?.memory).toBeUndefined();
				for (const name of ["query-memory", "learn-memory"] as const) {
					expect(first.agent?.[name]?.prompt).toContain(join(directory, "first-memory", "INDEX.md"));
					expect(first.agent?.[name]?.prompt).not.toContain(join(worktree, "first-memory", "INDEX.md"));
					expect(first.agent?.[name]?.prompt).not.toContain(join(process.cwd(), "first-memory", "INDEX.md"));
				}
				await writeConfig("second-memory");
				const toolContext = createToolContext({ directory, worktree, agent: "query-memory" });
				expect(await hooks.tool?.autocode_md_read.execute({ file_path_glob: "first-memory/INDEX.md" }, toolContext))
					.toBe(JSON.stringify({ content: "# first-memory\n" }));
				for (let attempt = 0; attempt < 2; attempt++) {
					const repeated: PluginConfig = {};
					await hooks.config(repeated as unknown as PluginHookConfig);
					expect(repeated.agent?.memory).toBeUndefined();
					for (const name of ["query-memory", "learn-memory"] as const) {
						expect(repeated.agent?.[name]?.prompt).toContain(join(directory, "first-memory", "INDEX.md"));
						expect(repeated.agent?.[name]?.prompt).not.toContain(join(directory, "second-memory", "INDEX.md"));
					}
				}
				const fresh = await autocode.server(input);
				try {
					if (!fresh.config) throw new Error("fresh plugin config hook unavailable");
					const updated: PluginConfig = {};
					await fresh.config(updated as unknown as PluginHookConfig);
					expect(updated.agent?.memory).toBeUndefined();
					for (const name of ["query-memory", "learn-memory"] as const) {
						expect(updated.agent?.[name]?.prompt).toContain(join(directory, "second-memory", "INDEX.md"));
					}
					expect(await fresh.tool?.autocode_md_read.execute({ file_path_glob: "second-memory/INDEX.md" }, toolContext))
						.toBe(JSON.stringify({ content: "# second-memory\n" }));
				} finally {
					await fresh.dispose?.();
				}
			} finally {
				await hooks.dispose?.();
			}
		});
	});

	test("split memory agents preserve standard disable and prompt overrides", async (): Promise<void> => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await writeFile(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({ autocode: { skills: { freeze: true }, memory: { directory: "configured-memory" } } }));
		await withEnv({ HOME: root, XDG_CONFIG_HOME: join(root, "xdg"), PATH: process.env.PATH, BUN_INSTALL: process.env.BUN_INSTALL }, async (): Promise<void> => {
			const input: PluginInputWithSandboxSupportOverride = { ...createInput(worktree), homeOverride: root };
			const hooks = await autocode.server(input);
			try {
				if (!hooks.config) throw new Error("plugin config hook unavailable");
				const overridden: PluginConfig = { agent: {
					"query-memory": { disable: true, prompt: "Custom query memory prompt" },
					"learn-memory": { disable: true, prompt: "Custom learn memory prompt" },
				} };
				await hooks.config(overridden as unknown as PluginHookConfig);
				expect(overridden.agent?.memory).toBeUndefined();
				expect(overridden.agent?.["query-memory"]).toEqual(expect.objectContaining({ disable: true, prompt: "Custom query memory prompt" }));
				expect(overridden.agent?.["learn-memory"]).toEqual(expect.objectContaining({ disable: true, prompt: "Custom learn memory prompt" }));
			} finally {
				await hooks.dispose?.();
			}
		});
	});

	test.each(["V1", "V2"])("%s initializes Git exclude once using cwd, not project root", async (version: string): Promise<void> => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		const directory = join(worktree, "nested");
		await mkdir(directory, { recursive: true });
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await writeFile(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({ autocode: { skills: { freeze: true } } }));
		await withEnv({ OPENCODE_CONFIG_DIR: join(root, "config"), PATH: process.env.PATH, BUN_INSTALL: process.env.BUN_INSTALL }, async (): Promise<void> => {
			const input: PluginInputWithSandboxSupportOverride = { ...createInput(worktree), directory, homeOverride: root };
			if (version === "V2") {
				await registerGeneratedSkills(input);
			} else {
				const hooks = await autocode.server(input);
				try {
					await (hooks as unknown as PluginConfigHook).config?.({});
					await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
				} finally {
					await hooks.dispose?.();
				}
			}
			expect(initializeGitExclude).toHaveBeenCalledTimes(1);
			expect(initializeGitExclude).toHaveBeenCalledWith(directory);
		});
	});

	test("legacy retains hidden worker defaults, tool shapes, and nesting depth bounds", async () => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await writeFile(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({ autocode: { skills: { freeze: true } } }));
		await withEnv({ OPENCODE_CONFIG_DIR: join(root, "config"), PATH: process.env.PATH, BUN_INSTALL: process.env.BUN_INSTALL }, async () => {
			const input: PluginInputWithSandboxSupportOverride = { ...createInput(worktree), homeOverride: root };
			const hooks = await autocode.server(input);
			try {
				for (const [configuredDepth, expectedDepth] of [[1, 5], [8, 7]]) {
					const cfg: PluginConfig = { subagent_depth: configuredDepth };
					await (hooks as unknown as PluginConfigHook).config?.(cfg);
					expect(cfg.subagent_depth).toBe(expectedDepth);
					expect(cfg.agent?.["query-code"]).toEqual(expect.objectContaining({ mode: "subagent", hidden: true }));
					expect(permissionEffect(cfg.agent?.assist?.permissions as PermissionRule[], "execute", "*")).toBe("deny");
				}
				expect(hooks.tool?.autocode_md_read?.args).toBeDefined();
				expect(hooks.tool?.autocode_md_read).not.toHaveProperty("options");
				expect(hooks.tool?.skill?.args).toBeDefined();
				expect(Object.keys(hooks.tool ?? {}).sort()).toEqual(Object.keys(createTools(input.client, {}, undefined, createPlatformCapabilities("linux", process.env))).sort());
				for (const name of ["learn", "autocode_memory_recall", "autocode_memory_forget"]) expect(hooks.tool).not.toHaveProperty(name);
				expect(Object.keys(hooks.tool ?? {})).toEqual(expect.arrayContaining([
					"autocode_ssh_command",
					"autocode_ssh_config_read",
					"autocode_db_schemas",
					"autocode_db_tables",
					"autocode_db_table",
					"autocode_db_table_read",
					"autocode_rest",
				]));
			} finally {
				await hooks.dispose?.();
			}
		});
	});

	test("runtime exposes create and restart session tools", async () => {
		const root = await createTempRoot();
		const hooks = (await autocode.server(
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
		const hooks = (await autocode.server(createInput(join(root, "worktree")))) as unknown as PluginRestartHooks;
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
		const hooks = (await autocode.server(createInput(join(root, "worktree")))) as unknown as PluginRestartHooks;
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
			const hooks = (await autocode.server(createInput(join(root, "worktree")))) as unknown as PluginRestartHooks;
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
				const hooks = (await autocode.server({
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
		const hooks = (await autocode.server({
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
		const hooks = (await autocode.server({
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
		const hooks = (await autocode.server({
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
				permissions: [{ action: "external_directory", resource: "/configured/*", effect: "allow" }],
			}),
		);

		await withEnv(
			{
				XDG_CONFIG_HOME: configHome,
				OPENCODE_CONFIG_DIR: join(configHome, "opencode"),
				HOME: root,
				PATH: process.env.PATH,
				BUN_INSTALL: process.env.BUN_INSTALL,
			},
			async () => {
				const cfg: PluginConfig & { permissions?: PermissionRule[] } = {
					agent: {
						assist: {
							model: "user-model",
							permissions: [{ action: "question", resource: "*", effect: "allow" }],
						},
						"execute-code": { model: "user-worker-model" },
						"auto-test": { variant: "user-test-variant" },
					},
					permissions: [
						{ action: "external_directory", resource: "/native/*", effect: "ask" },
						{ action: "external_directory", resource: "/configured/*", effect: "deny" },
					],
				};
				const input = { ...createInput(worktree), homeOverride: root };
				const hooks = (await autocode.server(input)) as unknown as PluginConfigHook;
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
				expect(Object.keys(cfg.command ?? {})).toEqual([
					"job-concepts",
					"new-advise",
					"new-assist",
					"new-auto",
					"new-design",
					"new-fix",
					"autocode-install",
					"autocode-version",
					"author",
					"docs",
					"explain",
					"git-conflict",
					"init",
					"learn",
					"learn-conventions",
					"learn-code",
					"learn-env",
					"learn-prd",
					"learn-ux",
					"repeat-as-md",
					"repeat-as-wiki",
					"report",
					"tests",
				]);
				for (const [name, commandDef] of Object.entries(commands)) expect(cfg.command?.[name]).toEqual(commandDef);
				for (const domain of ["conventions", "code", "env", "prd", "ux"]) {
					expect(cfg.command?.[`learn-${domain}`]?.agent).toBe("learn-memory");
					expect(cfg.command?.[`docs-${domain}`]).toBeUndefined();
				}
				expect(cfg.agent?.assist?.model).toBe("user-model");
				expect(cfg.agent?.assist?.variant).toBe("balanced-variant");
				expect(cfg.agent?.["execute-code"]?.model).toBe("user-worker-model");
				expect(cfg.agent?.["execute-code"]?.variant).toBe("balanced-variant");
				expect(cfg.agent?.["auto-test"]?.variant).toBe("user-test-variant");
				const assist = cfg.agent?.assist;
				const design = cfg.agent?.design;
				const assistPermission = assist?.permissions as PermissionRule[] | undefined;
				expect(
					((assist ?? {}) as Record<string, unknown>).tier,
				).toBeUndefined();
				expect(cfg.agent?.design?.model).toBe("balanced-model");
				expect(
					((design ?? {}) as Record<string, unknown>).tier,
				).toBeUndefined();
				expect(permissionEffect(assistPermission, "external_directory", "/native/file.md")).toBe("ask");
				expect(permissionEffect(assistPermission, "external_directory", "/configured/file.md")).toBe("allow");
				expect(permissionEffect(assistPermission, "external_directory", "/unconfigured/file.md")).toBe("ask");
				const registeredSkills = await registerGeneratedSkills(input);
				expect(registeredSkills.some((skill) => skill.path === join(getBundledSkillsRoot(), "code-typescript", "SKILL.md"))).toBe(true);

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

	test("registers bundled root but skips existing learned permissions root at startup", async () => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		const learnedSkillsRoot = join(worktree, ".agents", "skills");
		const learnedPermissionsRoot = join(learnedSkillsRoot, "learned-permissions");
		const learnedSkillDir = join(learnedPermissionsRoot, "example");
		await mkdir(learnedSkillDir, { recursive: true });
		await writeFile(join(learnedSkillDir, "SKILL.md"), "learned skill");
		const unrelatedSkillDir = join(learnedSkillsRoot, "unrelated", "example");
		await mkdir(unrelatedSkillDir, { recursive: true });
		await writeFile(join(unrelatedSkillDir, "SKILL.md"), "unrelated skill");

		await withEnv(
			{ HOME: root, XDG_CONFIG_HOME: join(root, "xdg"), PATH: process.env.PATH, BUN_INSTALL: process.env.BUN_INSTALL },
			async () => {
				const input = { ...createInput(worktree), homeOverride: root };
				const sources = await registerGeneratedSkills(input);

				expect(sources.length).toBeGreaterThan(0);
				expect(sources.every((skill) => skill.path.startsWith(getBundledSkillsRoot()))).toBe(true);
				expect(sources.some((skill) => skill.path.startsWith(learnedPermissionsRoot))).toBe(false);
				expect(sources.some((skill) => skill.path.startsWith(join(learnedSkillsRoot, "unrelated")))).toBe(false);
			},
		);
	});

	test("keeps spy memory policy while forcing learn denial after hostile overrides", async () => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await writeFile(
			join(worktree, ".opencode", "autocode.jsonc"),
			JSON.stringify({ autocode: { tiers: { spy: { model: "spy-model" } } } }),
		);

		await withEnv(
			{},
			async () => {
				const hooks = (await autocode.server(createInput(worktree))) as unknown as PluginConfigHook;
				const baseConfig: PluginConfig = {};
				await hooks.config?.(baseConfig);
				const basePermission = baseConfig.agent?.spy?.permissions as PermissionRule[] | undefined;

				expect(permissionEffect(basePermission, "learn", "*")).toBe("deny");
				expect(permissionEffect(basePermission, "read", "*")).toBe("allow");

				const hostileConfig: PluginConfig = {
					agent: {
						spy: {
							permissions: [
								{ action: "*", resource: "*", effect: "allow" },
								{ action: "learn", resource: "*", effect: "allow" },
							],
						},
					},
				};
				await hooks.config?.(hostileConfig);
				const hostilePermission = hostileConfig.agent?.spy?.permissions as PermissionRule[] | undefined;

				expect(hostilePermission).toContainEqual({ action: "*", resource: "*", effect: "allow" });
				expect(permissionEffect(hostilePermission, "learn", "*")).toBe("deny");
			},
		);
	});

	test("Windows removes sandbox exposure from user agent overrides", async () => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		await withEnv({ PSModulePath: undefined }, async () => {
			const cfg: PluginConfig = {
				agent: {
					"execute-sandbox": {
						prompt: "sandbox guidance",
						permissions: [{ action: "autocode_sandbox_cli", resource: "*", effect: "allow" }],
					},
					assist: {
						prompt: "use sandbox guidance",
						permissions: [
							{ action: "autocode_sandbox_cli", resource: "*", effect: "allow" },
							{ action: "subagent", resource: "execute-sandbox", effect: "allow" },
						],
					},
				},
			};
			const input: PluginInputWithSandboxSupportOverride = {
				...createInput(worktree),
				platformOverride: "win32",
			};
			const hooks = await autocode.server(input);

			await hooks.config?.(cfg as unknown as PluginHookConfig);

			expect(cfg.agent?.["execute-sandbox"]).toBeUndefined();
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
				const rules = agent.permissions as PermissionRule[] | undefined;
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
					expect(rules?.some((rule) => rule.action === toolName)).toBe(false);
				}
				expect(rules?.some((rule) => rule.action === "subagent" && rule.resource === "execute-sandbox")).toBe(false);
				expect(agent.description ?? "").not.toMatch(/sandbox/i);
				if (agent !== cfg.agent?.assist) expect(agent.prompt ?? "").not.toMatch(/sandbox/i);
			}
			expect(cfg.agent?.assist?.prompt).toBe("use sandbox guidance");
			for (const agentName of ["execute-os", "query-os"] as const) {
				expect(cfg.agent?.[agentName]?.prompt).toMatch(/cmd commands/i);
				expect(cfg.agent?.[agentName]?.prompt).toMatch(/never use bash/i);
			}
			expect(cfg.command?.['autocode-install']?.template).toContain("Run commands in CMD");
		});
	});

	test("Linux preserves supported sandbox registrations and Bash guidance", async () => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		const hooks = await autocode.server(createInput(worktree));
		const cfg: PluginConfig = {};

		await hooks.config?.(cfg as unknown as PluginHookConfig);

		expect(cfg.agent?.["execute-sandbox"]).toBeDefined();
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
		expect(cfg.agent?.["execute-os"]?.prompt).toMatch(
			/always use the `shell` tool/i,
		);
		expect(cfg.agent?.["query-os"]?.prompt).toMatch(
			/prefer other tools over `shell` tool/i,
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
			const hooks = await autocode.server(input);
			const cfg: PluginConfig = {};
			await hooks.config?.(cfg as unknown as PluginHookConfig);

			for (const agentName of ["execute-os", "query-os"] as const) {
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
				const hooks = (await autocode.server(input)) as unknown as PluginConfigHook;
				await hooks.config?.({});

				expect(process.env.BUN_INSTALL).toBe(`${home}/.bun`);
				expect(process.env.PATH).toBe(`${home}/.bun/bin:${originalPath}`);
			},
		);
	});

	test("Windows startup config prepends Bun bin using Windows paths", async (): Promise<void> => {
		const root = await createTempRoot();
		const home = "C:\\fixture home";
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
				const hooks = (await autocode.server(input)) as unknown as PluginConfigHook;
				await hooks.config?.({});

				expect(process.env.BUN_INSTALL).toBe("C:\\fixture home\\.bun");
				expect(process.env.PATH).toBe(
					`C:\\fixture home\\.bun\\bin;${originalPath}`,
				);
			},
		);
	});

	test("startup makes no network calls", async () => {
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
				{ XDG_CONFIG_HOME: join(root, "xdg"), HOME: root, PATH: process.env.PATH, BUN_INSTALL: process.env.BUN_INSTALL },
				async () => {
					const input: PluginInputWithSandboxSupportOverride = {
						...createInput(join(root, "worktree")),
						homeOverride: root,
					};
					const hooks = (await autocode.server(input)) as unknown as PluginConfigHook;
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
			await withEnv({ XDG_CONFIG_HOME: configHome, OPENCODE_CONFIG_DIR: join(configHome, "opencode"), HOME: root, PATH: process.env.PATH, BUN_INSTALL: process.env.BUN_INSTALL }, async () => {
				const input = { ...createInput(worktree), homeOverride: root };
				const hooks = (await autocode.server(input)) as unknown as PluginConfigHook;
				const cfg: PluginConfig = {};
				await hooks.config?.(cfg);

				expect(await registerGeneratedSkills(input)).toContainEqual(expect.objectContaining({
					id: "existing",
					path: existingSkill,
				}));
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
			await withEnv({ XDG_CONFIG_HOME: configHome, OPENCODE_CONFIG_DIR: join(configHome, "opencode"), HOME: root, PATH: process.env.PATH, BUN_INSTALL: process.env.BUN_INSTALL }, async () => {
				const input = { ...createInput(worktree), homeOverride: root };
				const hooks = (await autocode.server(input)) as unknown as PluginConfigHook;
				const cfg: PluginConfig = {};
				await hooks.config?.(cfg);

				expect(
					skillPermissions(cfg, "execute-os")?.["legacy-startup-url"],
				).toBeUndefined();
				expect((await registerGeneratedSkills(input)).some((skill) => skill.id === "legacy-startup-url")).toBe(false);
			});
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(fetchCalls).toBe(0);
		expect(
			await readdir(join(root, ".agents", "skills")).catch(() => []),
		).toEqual([]);
	});

	test.each([false, true])("legacy bundled skill lookup retains static grants with freeze=%s", async (freeze: boolean): Promise<void> => {
		const root = await createTempRoot();
		const configHome = join(root, "xdg");
		const worktree = join(root, "worktree");
		const userSkill = join(root, ".agents", "skills", "user", "SKILL.md");
		const userSkillText = "---\nname: user-canary\ndescription: User fixture\n---\nPreserve this skill.\n";
		const generatedRoot = join(root, ".agents", "skills", "autocode");
		const bundledSkill = managedSkills.find((skill) => skill.name === "code-typescript");
		if (!bundledSkill) throw new Error("bundled TypeScript skill unavailable");
		const bundledFiles = await Promise.all(managedSkills.map(async (skill) => {
			const path = join(getBundledSkillsRoot(), skill.directory, "SKILL.md");
			return { path, content: await readFile(path, "utf8"), mtimeMs: (await stat(path)).mtimeMs };
		}));
		await mkdir(join(configHome, "opencode"), { recursive: true });
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await mkdir(join(root, ".agents", "skills", "user"), { recursive: true });
		await writeFile(userSkill, userSkillText);
		const userMtime = (await stat(userSkill)).mtimeMs;
		await writeFile(
			join(configHome, "opencode", "autocode.jsonc"),
			JSON.stringify({ autocode: { skills: { freeze: false } } }),
		);
		await writeFile(
			join(worktree, ".opencode", "autocode.jsonc"),
			JSON.stringify({ autocode: { skills: { freeze } } }),
		);

		await withEnv({ XDG_CONFIG_HOME: configHome, OPENCODE_CONFIG_DIR: join(configHome, "opencode"), HOME: root, PATH: process.env.PATH, BUN_INSTALL: process.env.BUN_INSTALL }, async () => {
			const archivePath = join(worktree, ".opencode", "autocode", "memory-archive");
			const outsidePath = join(`${root}-outside`, ".agents", "skills");
			const allowedRoots = [root, getBundledSkillsRoot()].map((path) => resolve(path));
			const deniedPaths: string[] = [];
			const realPaths: string[] = [];
			const originalReaddir = promiseFileSystem.readdir;
			const guard = spyOn(promiseFileSystem, "readdir").mockImplementation((async (directory: Parameters<typeof promiseFileSystem.readdir>[0], options: Parameters<typeof promiseFileSystem.readdir>[1]) => {
				const path = typeof directory === "string" ? resolve(directory) : undefined;
				const within = (base: string): boolean => {
					if (path === undefined) return false;
					const fromBase = relative(base, path);
					return fromBase === "" || (fromBase !== ".." && !fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase));
				};
				if (path === undefined || within(archivePath) || !allowedRoots.some(within)) {
					deniedPaths.push(String(directory));
					throw Object.assign(new Error("Blocked directory access"), { code: "ENOENT" });
				}
				realPaths.push(path);
				return originalReaddir(directory, options);
			}) as unknown as typeof promiseFileSystem.readdir);
			const originalCreateSkillTool = skillModule.createSkillTool;
			const skillGuard = spyOn(skillModule, "createSkillTool").mockImplementation((client, fileSystem, runtime, trace, activeSessionContext) => {
				if (fileSystem !== undefined) throw new Error("Expected default skill filesystem");
				return originalCreateSkillTool(client, {
					readFile: (path, encoding) => promiseFileSystem.readFile(path, encoding),
					readdir: (path, options) => promiseFileSystem.readdir(path, options),
				}, runtime, trace, activeSessionContext);
			});
			let hooks: Awaited<ReturnType<typeof autocode.server>> | undefined;
			try {
				const input: PluginInputWithSandboxSupportOverride = {
					...createInput(worktree),
					homeOverride: root,
				};
				hooks = await autocode.server(input);
				const cfg: PluginConfig = {};
				await hooks.config?.(cfg as unknown as PluginHookConfig);

				expect(skillPermissions(cfg, "execute-code")?.["angular-developer"]).toBeUndefined();
				expect(skillPermissions(cfg, "execute-code")?.["code*"]).toBe("allow");
				expect(
					skillPermissions(cfg, "execute-os")?.["angular-developer"],
				).toBeUndefined();
				expect(skillPermissions(cfg, "auto-test")?.vitest).toBeUndefined();
				expect(skillPermissions(cfg, "auto-test")?.["test*"]).toBe("allow");
				expect(skillPermissions(cfg, "assist")?.["codebase-design"]).toBeUndefined();
				expect(skillPermissions(cfg, "auto")?.["codebase-design"]).toBeUndefined();
				expect(skillPermissions(cfg, "design")?.["codebase-design"]).toBeUndefined();
				const grants = Object.keys(skillPermissions(cfg, "execute-code") ?? {});
				expect(new Set(grants).size).toBe(grants.length);
				expect(hooks.tool).not.toHaveProperty("skill_edit");
				const skillTool = hooks.tool?.skill;
				if (!skillTool) throw new Error("legacy skill tool unavailable");
				expect(skillGuard).toHaveBeenCalled();
				const result = await skillTool.execute({ name: bundledSkill.name }, {
					sessionID: `bundled-v1-${freeze}`,
					messageID: "bundled-v1-message",
					agent: "execute-code",
					directory: worktree,
					worktree,
					abort: new AbortController().signal,
					metadata() {},
					ask: createNoopAsk(),
				});
				expect(result).toContain(bundledSkill.content);
				await expect(readdir(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
				await expect(readdir(outsidePath)).rejects.toMatchObject({ code: "ENOENT" });
				expect(deniedPaths).toContain(archivePath);
				expect(deniedPaths).toContain(outsidePath);
				expect(realPaths).toContain(resolve(getBundledSkillsRoot()));
				expect(realPaths).not.toContain(archivePath);
				expect(realPaths).not.toContain(outsidePath);
				expect(deniedPaths.every((path) => !realPaths.includes(resolve(path)))).toBe(true);
				for (const file of bundledFiles) {
					expect(await readFile(file.path, "utf8")).toBe(file.content);
					expect((await stat(file.path)).mtimeMs).toBe(file.mtimeMs);
				}
				expect(await readFile(userSkill, "utf8")).toBe(userSkillText);
				expect((await stat(userSkill)).mtimeMs).toBe(userMtime);
				expect(await readdir(join(root, ".agents", "skills"))).toEqual(["user"]);
				expect(existsSync(generatedRoot)).toBe(false);
				expect(existsSync(join(worktree, ".opencode", "skills"))).toBe(false);
			} finally {
				try {
					await hooks?.dispose?.();
				} finally {
					skillGuard.mockRestore();
					guard.mockRestore();
				}
			}
		});
	});

	test("refreshes smart agents before tier stripping without legacy chat hooks", async () => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		await mkdir(join(worktree, ".opencode"), { recursive: true });
		await writeFile(
			join(worktree, ".opencode", "autocode.jsonc"),
			JSON.stringify({ autocode: { skills: { freeze: true }, tiers: { smart: { model: "smart-model" } } } }),
		);
		await withEnv({ XDG_CONFIG_HOME: join(root, "xdg"), HOME: root }, async () => {
			const input: PluginInputWithSandboxSupportOverride = { ...createInput(worktree), homeOverride: root };
			const hooks = await autocode.server(input);
			try {
				if (!hooks.config) throw new Error("plugin config hook unavailable");
				expect(hooks).not.toHaveProperty("chat.message");
				expect(hooks).not.toHaveProperty("chat.params");
				expect(hooks).not.toHaveProperty("experimental.chat.messages.transform");
				expect(hooks).not.toHaveProperty("experimental.chat.system.transform");
				const cfg: PluginConfig = {};
				await hooks.config(cfg as unknown as PluginHookConfig);
				await hooks.config(cfg as unknown as PluginHookConfig);

				expect(cfg.agent?.auto).not.toHaveProperty("tier");
			} finally {
				await hooks.dispose?.();
			}
		});
	});

	test("default migration leaves existing memory folders unchanged", async (): Promise<void> => {
		const root = await createTempRoot();
		const worktree = join(root, "worktree");
		const memoryDir = join(worktree, ".opencode", "autocode", "memories");
		const sentinel = join(memoryDir, "sentinel.md");
		const formerDefault = join(worktree, ".opencode", "autocode", "memory");
		const formerSentinel = join(formerDefault, "sentinel.md");
		const content = "Synthetic legacy memory: do not inject 🧪\n";
		await mkdir(memoryDir, { recursive: true });
		await mkdir(formerDefault, { recursive: true });
		await writeFile(sentinel, content);
		await writeFile(formerSentinel, content);
		await withEnv({ HOME: root, XDG_CONFIG_HOME: join(root, "xdg") }, async (): Promise<void> => {
			const input: PluginInputWithSandboxSupportOverride = { ...createInput(worktree), homeOverride: root };
			const hooks = await autocode.server(input);
			try {
				expect(hooks).not.toHaveProperty("chat.message");
				expect(hooks).not.toHaveProperty("chat.params");
				expect(hooks).not.toHaveProperty("experimental.chat.messages.transform");
				expect(hooks).not.toHaveProperty("experimental.chat.system.transform");
				const cfg: PluginConfig = {};
				await hooks.config?.(cfg as unknown as PluginHookConfig);
				expect(cfg.agent?.memory).toBeUndefined();
				for (const name of ["query-memory", "learn-memory"] as const) {
					expect(cfg.agent?.[name]?.prompt).toContain(join(worktree, ".opencode", "autocode", "memory", "INDEX.md"));
				}
				await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "sentinel-session" } } });
			} finally {
				await hooks.dispose?.();
			}
		});
		expect(await readdir(memoryDir)).toEqual(["sentinel.md"]);
		expect(await readFile(sentinel, "utf8")).toBe(content);
		expect(await readdir(formerDefault)).toEqual(["sentinel.md"]);
		expect(await readFile(formerSentinel, "utf8")).toBe(content);
	});

	test("plugin, tool registry, and event handlers do not import legacy memory runtime modules", async (): Promise<void> => {
		for (const url of [
			new URL("./plugin.ts", import.meta.url),
			new URL("./tools/index.ts", import.meta.url),
			new URL("./hooks/agent_restart_coordinator.ts", import.meta.url),
			new URL("./hooks/managed_script_lifecycle.ts", import.meta.url),
			new URL("./hooks/root_session_title.ts", import.meta.url),
		]) {
			const source = await readFile(url, "utf8");
			const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)].map((match) => match[1]);
			for (const specifier of imports) expect(specifier.replaceAll("\\", "/")).not.toMatch(/(?:^|\/)(?:local[_-]memory|memory(?:[_-]runtime)?|autocode[_-]memory[_-](?:recall|forget)|learn)(?:[./_-]|$)/i);
		}
	});
});
