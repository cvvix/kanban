import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

interface MockSpawnRequest {
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
		triggerData: (chunk: string | Buffer) => {
			request.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
		},
		triggerExit: (exitCode: number | null) => {
			request.onExit?.({ exitCode });
		},
	};
}

describe("TerminalSessionManager auto-restart", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	it("restarts an attached agent session after it exits", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		spawnedSessions[0]?.triggerExit(130);

		await vi.waitFor(() => {
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		});
		expect(manager.getSummary("task-1")?.state).toBe("running");
		expect(manager.getSummary("task-1")?.pid).toBe(222);
	});

	it("does not restart an attached agent session after an explicit stop", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		manager.stopTaskSession("task-1");
		spawnedSessions[0]?.triggerExit(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.pid).toBeNull();
	});

	it("restarts Hermes sessions by resuming the existing CLI conversation", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-hermes-restart", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-hermes-restart",
			agentId: "hermes",
			binary: "hermes",
			args: ["chat"],
			cwd: "/tmp/task-hermes-restart",
			prompt: "Fix the bug",
		});

		spawnedSessions[0]?.triggerData("Session ID: hermes-session-abc\n");
		spawnedSessions[0]?.triggerExit(130);

		await vi.waitFor(() => {
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		});
		expect(prepareAgentLaunchMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				taskId: "task-hermes-restart",
				agentId: "hermes",
				resumeExistingSession: true,
				agentSessionId: "hermes-session-abc",
			}),
		);
	});

	it("restarts Hermes sessions by resolving the recorded session file when output has no session id", async () => {
		const originalHome = process.env.HOME;
		const tempHome = await mkdtemp(join(tmpdir(), "kanban-hermes-home-"));
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];

		try {
			process.env.HOME = tempHome;
			ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
				const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
				spawnedSessions.push(session);
				return session;
			});

			const manager = new TerminalSessionManager();
			manager.attach("task-hermes-file-restart", {
				onState: vi.fn(),
				onOutput: vi.fn(),
				onExit: vi.fn(),
			});

			await manager.startTaskSession({
				taskId: "task-hermes-file-restart",
				agentId: "hermes",
				binary: "hermes",
				args: ["chat"],
				cwd: "/tmp/task-hermes-file-restart",
				prompt: "Fix the Hermes resume flow",
			});

			const sessionsRoot = join(tempHome, ".hermes", "sessions");
			await mkdir(sessionsRoot, { recursive: true });
			await writeFile(
				join(sessionsRoot, "session_20260513_010001_match.json"),
				JSON.stringify({
					session_id: "20260513_010001_match",
					messages: [{ role: "user", content: "Fix the Hermes resume flow" }],
				}),
				"utf8",
			);
			spawnedSessions[0]?.triggerExit(130);

			await vi.waitFor(() => {
				expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
			});
			expect(prepareAgentLaunchMock).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({
					taskId: "task-hermes-file-restart",
					agentId: "hermes",
					resumeExistingSession: true,
					agentSessionId: "20260513_010001_match",
				}),
			);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			await rm(tempHome, { recursive: true, force: true });
		}
	});

	it("restarts Codex sessions by resuming the recorded CLI session", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-codex-restart", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-codex-restart",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-codex-restart",
			prompt: "Promote the release",
		});

		spawnedSessions[0]?.triggerData(
			`${JSON.stringify({
				type: "session_meta",
				payload: { id: "22222222-2222-4222-8222-222222222222", cwd: "/tmp/task-codex-restart" },
			})}\n`,
		);
		spawnedSessions[0]?.triggerExit(130);

		await vi.waitFor(() => {
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		});
		expect(prepareAgentLaunchMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				taskId: "task-codex-restart",
				agentId: "codex",
				resumeExistingSession: true,
				agentSessionId: "22222222-2222-4222-8222-222222222222",
			}),
		);
	});

	it("restarts Claude sessions by resuming the generated session id", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-claude-restart", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-claude-restart",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-claude-restart",
			prompt: "Fix the bug",
		});

		const agentSessionId = manager.getSummary("task-claude-restart")?.agentSessionId;
		expect(agentSessionId).toMatch(/^[0-9a-f-]{36}$/);
		spawnedSessions[0]?.triggerExit(130);

		await vi.waitFor(() => {
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		});
		expect(prepareAgentLaunchMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				taskId: "task-claude-restart",
				agentId: "claude",
				resumeExistingSession: true,
				agentSessionId,
			}),
		);
	});

	it("sends deferred Codex startup input when the prompt marker appears", async () => {
		const deferredStartupInput = "\u001b[200~/plan Validate rollout\u001b[201~\r";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			deferredStartupInput,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
			startInPlanMode: true,
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData("Booting Codex\n");
		expect(session.write).not.toHaveBeenCalledWith(deferredStartupInput);

		session.triggerData("› ");
		expect(session.write).toHaveBeenCalledWith(deferredStartupInput);
		expect(session.write).toHaveBeenCalledTimes(1);
	});

	it("sends deferred Codex startup input when the startup UI header appears", async () => {
		const deferredStartupInput = "\u001b[200~/plan Validate startup UI detect\u001b[201~\r";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			deferredStartupInput,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
			startInPlanMode: true,
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData(">_ OpenAI Codex (v0.117.0)\n");
		expect(session.write).toHaveBeenCalledWith(deferredStartupInput);
		expect(session.write).toHaveBeenCalledTimes(1);
	});

	it("sends deferred Hermes startup input when the interactive prompt appears", async () => {
		const deferredStartupInput = "\u001b[200~Investigate deployment drift\u001b[201~\r";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "hermes",
			args: ["chat", "--quiet"],
			env: {},
			deferredStartupInput,
			detectOutputTransition: (data: string, summary: { state: string }) =>
				summary.state === "running" && data.includes("❯") ? { type: "hook.to_review" as const } : null,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-hermes-1",
			agentId: "hermes",
			binary: "hermes",
			args: ["chat"],
			cwd: "/tmp/task-hermes-1",
			prompt: "Investigate deployment drift",
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData("Welcome to Hermes Agent!\n");
		expect(session.write).not.toHaveBeenCalledWith(deferredStartupInput);

		session.triggerData("\n❯ ");
		expect(session.write).toHaveBeenCalledWith(deferredStartupInput);
		expect(session.write).toHaveBeenCalledTimes(1);
		expect(manager.getSummary("task-hermes-1")?.state).toBe("running");

		session.triggerData("\nOK\n\n❯ ");
		expect(manager.getSummary("task-hermes-1")?.state).toBe("awaiting_review");
	});

	it("sends deferred Hermes startup input when the prompt marker is split across chunks", async () => {
		const deferredStartupInput = "\u001b[200~Investigate deployment drift\u001b[201~\r";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "hermes",
			args: ["chat", "--quiet"],
			env: {},
			deferredStartupInput,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-hermes-2",
			agentId: "hermes",
			binary: "hermes",
			args: ["chat"],
			cwd: "/tmp/task-hermes-2",
			prompt: "Investigate deployment drift",
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData("\n");
		expect(session.write).not.toHaveBeenCalled();
		session.triggerData("❯ ");
		expect(session.write).toHaveBeenCalledWith(deferredStartupInput);
		expect(session.write).toHaveBeenCalledTimes(1);
	});
});
