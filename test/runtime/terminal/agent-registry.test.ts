import { beforeEach, describe, expect, it, vi } from "vitest";

const commandDiscoveryMocks = vi.hoisted(() => ({
	resolveBinaryOnPath: vi.fn(),
}));

vi.mock("../../../src/terminal/command-discovery.js", () => ({
	isNodeModulesBinPath: (entry: string) => {
		const parts = entry.split(/[\\/]+/).filter(Boolean);
		return parts.length >= 2 && parts.at(-2) === "node_modules" && parts.at(-1) === ".bin";
	},
	resolveBinaryOnPath: commandDiscoveryMocks.resolveBinaryOnPath,
}));

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import {
	buildRuntimeConfigResponse,
	detectInstalledCommands,
	resolveAgentCommand,
} from "../../../src/terminal/agent-registry";

function createRuntimeConfigState(overrides: Partial<RuntimeConfigState> = {}): RuntimeConfigState {
	return {
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		readyForReviewNotificationsEnabled: true,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		...overrides,
	};
}

beforeEach(() => {
	commandDiscoveryMocks.resolveBinaryOnPath.mockReset();
	commandDiscoveryMocks.resolveBinaryOnPath.mockReturnValue(null);
	delete process.env.KANBAN_DEBUG_MODE;
	delete process.env.DEBUG_MODE;
	delete process.env.debug_mode;
});

describe("agent-registry", () => {
	it("detects installed commands from the inherited PATH", () => {
		commandDiscoveryMocks.resolveBinaryOnPath.mockImplementation((binary: string) =>
			binary === "claude" ? "/usr/local/bin/claude" : null,
		);

		const detected = detectInstalledCommands();

		expect(detected).toEqual(["claude"]);
		expect(commandDiscoveryMocks.resolveBinaryOnPath).toHaveBeenCalledTimes(9);
	});

	it("treats shell-only agents as unavailable", () => {
		commandDiscoveryMocks.resolveBinaryOnPath.mockImplementation((binary: string) =>
			binary === "npx" ? "/usr/local/bin/npx" : null,
		);

		const resolved = resolveAgentCommand(createRuntimeConfigState({ selectedAgentId: "claude" }));

		expect(resolved).toBeNull();
	});

	it("resolves codex to the system binary instead of project node_modules", () => {
		commandDiscoveryMocks.resolveBinaryOnPath.mockImplementation(
			(binary: string, options?: { skipPathEntry?: (entry: string) => boolean }) => {
				if (binary !== "codex") {
					return null;
				}
				if (!options?.skipPathEntry?.("/repo/node_modules/.bin")) {
					return "/repo/node_modules/.bin/codex";
				}
				return "/usr/local/bin/codex";
			},
		);

		const resolved = resolveAgentCommand(createRuntimeConfigState({ selectedAgentId: "codex" }));

		expect(resolved).toEqual(
			expect.objectContaining({
				agentId: "codex",
				command: "codex",
				binary: "/usr/local/bin/codex",
			}),
		);
	});

	it("does not detect codex when only the project node_modules binary is available", () => {
		commandDiscoveryMocks.resolveBinaryOnPath.mockImplementation(
			(binary: string, options?: { skipPathEntry?: (entry: string) => boolean }) => {
				if (binary !== "codex") {
					return null;
				}
				return options?.skipPathEntry?.("/repo/node_modules/.bin") ? null : "/repo/node_modules/.bin/codex";
			},
		);

		expect(detectInstalledCommands()).not.toContain("codex");
	});
});

describe("buildRuntimeConfigResponse", () => {
	it("keeps curated agent default args independent of autonomous mode", () => {
		const config = createRuntimeConfigState({
			agentAutonomousModeEnabled: true,
		});

		const response = buildRuntimeConfigResponse(config, {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});

		expect(response.agentAutonomousModeEnabled).toBe(true);
		expect(response.agents.map((agent) => agent.id)).toEqual(["claude", "codex", "cline", "droid", "kiro", "hermes"]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "cline")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "droid")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "kiro")?.defaultArgs).toEqual(["chat"]);
		expect(response.agents.find((agent) => agent.id === "hermes")?.defaultArgs).toEqual(["chat"]);
		expect(response.agents.find((agent) => agent.id === "cline")?.installed).toBe(true);
	});

	it("omits autonomous flags from curated agent commands when disabled", () => {
		const config = createRuntimeConfigState({
			agentAutonomousModeEnabled: false,
		});
		commandDiscoveryMocks.resolveBinaryOnPath.mockImplementation((binary: string) =>
			binary === "claude" ? "/usr/local/bin/claude" : null,
		);

		const response = buildRuntimeConfigResponse(config, {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});

		expect(response.agentAutonomousModeEnabled).toBe(false);
		expect(response.agents.map((agent) => agent.id)).toEqual(["claude", "codex", "cline", "droid", "kiro", "hermes"]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "cline")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "droid")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "kiro")?.defaultArgs).toEqual(["chat"]);
		expect(response.agents.find((agent) => agent.id === "hermes")?.defaultArgs).toEqual(["chat"]);
		expect(response.agents.find((agent) => agent.id === "cline")?.installed).toBe(true);
		expect(response.agents.find((agent) => agent.id === "claude")?.command).toBe("claude");
		expect(response.agents.find((agent) => agent.id === "codex")?.command).toBe("codex");
		expect(response.agents.find((agent) => agent.id === "droid")?.command).toBe("droid");
		expect(response.agents.find((agent) => agent.id === "kiro")?.command).toBe("kiro-cli chat");
		expect(response.agents.find((agent) => agent.id === "hermes")?.command).toBe("hermes chat");
	});

	it("sets debug mode from runtime environment variables", () => {
		process.env.KANBAN_DEBUG_MODE = "true";
		const response = buildRuntimeConfigResponse(createRuntimeConfigState(), {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});
		expect(response.debugModeEnabled).toBe(true);
	});

	it("supports debug_mode fallback env name", () => {
		process.env.debug_mode = "1";
		const response = buildRuntimeConfigResponse(createRuntimeConfigState(), {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});
		expect(response.debugModeEnabled).toBe(true);
	});
});
