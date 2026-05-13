import { delimiter } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import { TerminalSessionManager } from "../../../src/terminal/session-manager";

const originalPath = process.env.PATH;

function createMockPtySession() {
	return {
		pid: 1234,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
	};
}

describe("TerminalSessionManager environment", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		prepareAgentLaunchMock.mockResolvedValue({
			args: [],
			env: {},
		});
		ptySessionSpawnMock.mockReset();
		ptySessionSpawnMock.mockReturnValue(createMockPtySession());
	});

	afterEach(() => {
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
	});

	it("removes npm-injected node_modules binaries from shell terminal PATH", async () => {
		process.env.PATH = [
			"/repo/node_modules/.bin",
			"/Users/example/.nvm/versions/node/v22.14.0/bin",
			"/repo/packages/app/node_modules/.bin",
			"/usr/local/bin",
		].join(delimiter);

		const manager = new TerminalSessionManager();
		await manager.startShellSession({
			taskId: "shell",
			cwd: "/repo",
			binary: "zsh",
			args: ["-i"],
		});

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		const request = ptySessionSpawnMock.mock.calls[0]?.[0] as { env: NodeJS.ProcessEnv };
		expect(request.env.PATH).toBe(
			["/Users/example/.nvm/versions/node/v22.14.0/bin", "/usr/local/bin"].join(delimiter),
		);
	});

	it("removes npm-injected node_modules binaries from task agent PATH", async () => {
		process.env.PATH = ["/repo/node_modules/.bin", "/usr/local/bin"].join(delimiter);

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task",
			agentId: "codex",
			binary: "/usr/local/bin/codex",
			args: [],
			cwd: "/repo",
			prompt: "hello",
		});

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		const request = ptySessionSpawnMock.mock.calls[0]?.[0] as { env: NodeJS.ProcessEnv };
		expect(request.env.PATH).toBe("/usr/local/bin");
	});
});
