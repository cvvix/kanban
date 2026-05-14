import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import {
	loadAgentSessionRegistration,
	writeAgentSessionRegistration,
} from "../../src/state/agent-session-registration";
import {
	loadWorkspaceContext,
	loadWorkspaceSessionRecoveryRecord,
	syncWorkspaceSessionRecoveryFromSummary,
} from "../../src/state/workspace-state";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "codex",
		agentSessionId: "session-1",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

describe("workspace session recovery", () => {
	let tempRoot: string;
	let originalHome: string | undefined;
	let repoPath: string;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempRoot = await mkdtemp(join(tmpdir(), "kanban-session-recovery-"));
		process.env.HOME = join(tempRoot, "home");
		repoPath = join(tempRoot, "repo");
		await mkdir(repoPath, { recursive: true });
		execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });
	});

	afterEach(async () => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("persists and removes recoverable terminal agent sessions by task id", async () => {
		const context = await loadWorkspaceContext(repoPath);

		await syncWorkspaceSessionRecoveryFromSummary(context.workspaceId, createSummary());

		await expect(loadWorkspaceSessionRecoveryRecord(context.workspaceId, "task-1")).resolves.toMatchObject({
			taskId: "task-1",
			agentId: "codex",
			agentSessionId: "session-1",
			lastKnownState: "running",
		});

		await syncWorkspaceSessionRecoveryFromSummary(
			context.workspaceId,
			createSummary({
				state: "idle",
				pid: null,
				startedAt: null,
			}),
		);

		await expect(loadWorkspaceSessionRecoveryRecord(context.workspaceId, "task-1")).resolves.toBeNull();
	});

	it("persists wrapper agent session registrations by workspace and task", async () => {
		const context = await loadWorkspaceContext(repoPath);

		await writeAgentSessionRegistration({
			workspaceId: context.workspaceId,
			taskId: "task-1",
			agentId: "hermes",
			agentSessionId: "20260513_010001_match",
			workspacePath: "/tmp/worktree",
			startedAt: 10,
			updatedAt: 20,
			source: "hermes-source:kanban:test",
		});

		await expect(loadAgentSessionRegistration(context.workspaceId, "task-1", "hermes")).resolves.toMatchObject({
			taskId: "task-1",
			agentId: "hermes",
			agentSessionId: "20260513_010001_match",
			workspacePath: "/tmp/worktree",
			startedAt: 10,
			updatedAt: 20,
		});
		await expect(loadAgentSessionRegistration(context.workspaceId, "task-1", "codex")).resolves.toBeNull();
	});
});
