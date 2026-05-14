import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { shutdownRuntimeServer } from "../../src/server/shutdown-coordinator";
import { loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import type { TerminalSessionManager } from "../../src/terminal/session-manager";
import {
	getWorkspaceFolderLabelForWorktreePath,
	KANBAN_TASK_WORKTREES_HOME_DIR_NAME,
} from "../../src/workspace/task-worktree-path";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-shutdown-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run();
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanup();
	}
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

function createCard(taskId: string) {
	return {
		id: taskId,
		title: `Task ${taskId}`,
		prompt: `Task ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function createBoard(taskIds: { inProgress?: string[]; review?: string[] }): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{
				id: "in_progress",
				title: "In Progress",
				cards: (taskIds.inProgress ?? []).map((taskId) => createCard(taskId)),
			},
			{
				id: "review",
				title: "Review",
				cards: (taskIds.review ?? []).map((taskId) => createCard(taskId)),
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function createTaskWorktreeDirectory(homePath: string, repoPath: string, taskId: string): string {
	const worktreePath = join(
		homePath,
		KANBAN_TASK_WORKTREES_HOME_DIR_NAME,
		taskId,
		getWorkspaceFolderLabelForWorktreePath(repoPath),
	);
	mkdirSync(worktreePath, { recursive: true });
	writeFileSync(join(worktreePath, "marker.txt"), taskId);
	return worktreePath;
}

function createSession(taskId: string, state: "running" | "awaiting_review" | "idle"): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: "codex",
		workspacePath: `/tmp/${taskId}`,
		pid: state === "idle" ? null : 1234,
		startedAt: state === "idle" ? null : Date.now() - 1_000,
		updatedAt: Date.now(),
		lastOutputAt: state === "idle" ? null : Date.now(),
		reviewReason: state === "awaiting_review" ? "hook" : null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

describe.sequential("shutdown coordinator integration", () => {
	it("stops managed terminal sessions on shutdown", async () => {
		let didCloseRuntimeServer = false;
		const markInterruptedAndStopAll = vi.fn(() => [createSession("managed-running", "running")]);
		const managedTerminalManager = {
			markInterruptedAndStopAll,
			listSummaries: () => [createSession("managed-running", "running")],
			getSummary: () => null,
		} as unknown as TerminalSessionManager;

		await shutdownRuntimeServer({
			workspaceRegistry: {
				listManagedWorkspaces: () => [
					{
						workspaceId: "managed-project",
						workspacePath: "/tmp/managed-project",
						terminalManager: managedTerminalManager,
					},
				],
			},
			closeRuntimeServer: async () => {
				didCloseRuntimeServer = true;
			},
		});

		expect(markInterruptedAndStopAll).toHaveBeenCalledTimes(1);
		expect(didCloseRuntimeServer).toBe(true);
	});

	it("does not move cards or delete worktrees for any project on shutdown", async () => {
		await withTemporaryHome(async () => {
			const tempHome = process.env.HOME;
			if (!tempHome) {
				throw new Error("Expected temporary HOME to be set.");
			}
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-shutdown-scope-");
			try {
				const managedProjectPath = join(sandboxRoot, "managed-project");
				const indexedProjectPath = join(sandboxRoot, "indexed-project");
				mkdirSync(managedProjectPath, { recursive: true });
				mkdirSync(indexedProjectPath, { recursive: true });
				initGitRepository(managedProjectPath);
				initGitRepository(indexedProjectPath);

				const managedInitial = await loadWorkspaceState(managedProjectPath);
				const managedBoard = createBoard({
					inProgress: ["managed-running", "managed-missing-session"],
					review: ["managed-idle"],
				});
				await saveWorkspaceState(managedProjectPath, {
					board: managedBoard,
					sessions: {
						"managed-running": createSession("managed-running", "running"),
						"managed-idle": createSession("managed-idle", "idle"),
					},
					expectedRevision: managedInitial.revision,
				});
				const managedRunningWorktree = createTaskWorktreeDirectory(tempHome, managedProjectPath, "managed-running");
				const managedMissingSessionWorktree = createTaskWorktreeDirectory(
					tempHome,
					managedProjectPath,
					"managed-missing-session",
				);
				const managedIdleWorktree = createTaskWorktreeDirectory(tempHome, managedProjectPath, "managed-idle");

				const indexedInitial = await loadWorkspaceState(indexedProjectPath);
				const indexedBoard = createBoard({
					inProgress: ["indexed-missing-session"],
					review: ["indexed-awaiting-review"],
				});
				await saveWorkspaceState(indexedProjectPath, {
					board: indexedBoard,
					sessions: {
						"indexed-awaiting-review": createSession("indexed-awaiting-review", "awaiting_review"),
					},
					expectedRevision: indexedInitial.revision,
				});
				const indexedMissingSessionWorktree = createTaskWorktreeDirectory(
					tempHome,
					indexedProjectPath,
					"indexed-missing-session",
				);
				const indexedAwaitingReviewWorktree = createTaskWorktreeDirectory(
					tempHome,
					indexedProjectPath,
					"indexed-awaiting-review",
				);

				let didCloseRuntimeServer = false;
				const managedTerminalManager = {
					markInterruptedAndStopAll: () => [createSession("managed-running", "running")],
					listSummaries: () => [createSession("managed-running", "running")],
					getSummary: (taskId: string) => {
						if (taskId === "managed-running") {
							return createSession("managed-running", "running");
						}
						if (taskId === "managed-idle") {
							return createSession("managed-idle", "idle");
						}
						return null;
					},
				} as unknown as TerminalSessionManager;
				await shutdownRuntimeServer({
					workspaceRegistry: {
						listManagedWorkspaces: () => [
							{
								workspaceId: "managed-project",
								workspacePath: managedProjectPath,
								terminalManager: managedTerminalManager,
							},
						],
					},
					closeRuntimeServer: async () => {
						didCloseRuntimeServer = true;
					},
				});

				expect(didCloseRuntimeServer).toBe(true);

				const managedAfter = await loadWorkspaceState(managedProjectPath);
				expect(managedAfter.board).toEqual(managedBoard);
				expect(managedAfter.sessions["managed-running"]?.state).toBe("running");
				expect(managedAfter.sessions["managed-idle"]?.state).toBe("idle");
				expect(managedAfter.sessions["managed-missing-session"]).toBeUndefined();
				expect(existsSync(managedRunningWorktree)).toBe(true);
				expect(existsSync(managedMissingSessionWorktree)).toBe(true);
				expect(existsSync(managedIdleWorktree)).toBe(true);

				const indexedAfter = await loadWorkspaceState(indexedProjectPath);
				expect(indexedAfter.board).toEqual(indexedBoard);
				expect(indexedAfter.sessions["indexed-awaiting-review"]?.state).toBe("awaiting_review");
				expect(indexedAfter.sessions["indexed-missing-session"]).toBeUndefined();
				expect(existsSync(indexedMissingSessionWorktree)).toBe(true);
				expect(existsSync(indexedAwaitingReviewWorktree)).toBe(true);
			} finally {
				cleanup();
			}
		});
	}, 30_000);
});
