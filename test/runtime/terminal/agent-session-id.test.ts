import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	extractAgentSessionIdFromOutput,
	resolveCodexSessionIdForCwd,
	resolveHermesSessionIdForPrompt,
} from "../../../src/terminal/agent-session-id";

function formatDatePathPart(value: number): string {
	return value.toString().padStart(2, "0");
}

function getCodexSessionDateDir(root: string, timestamp: number): string {
	const date = new Date(timestamp);
	return join(
		root,
		String(date.getFullYear()),
		formatDatePathPart(date.getMonth() + 1),
		formatDatePathPart(date.getDate()),
	);
}

describe("agent session id helpers", () => {
	it("extracts labeled session ids from terminal output", () => {
		expect(extractAgentSessionIdFromOutput("hermes", "Session ID: hermes-session_123\n")).toBe("hermes-session_123");
		expect(
			extractAgentSessionIdFromOutput("claude", "FAKE_AGENT_SESSION_ID=11111111-1111-4111-8111-111111111111"),
		).toBe("11111111-1111-4111-8111-111111111111");
	});

	it("extracts Codex session ids from session_meta lines", () => {
		const line = JSON.stringify({
			type: "session_meta",
			payload: {
				id: "22222222-2222-4222-8222-222222222222",
				cwd: "/tmp/kanban/task",
			},
		});

		expect(extractAgentSessionIdFromOutput("codex", `${line}\n`)).toBe("22222222-2222-4222-8222-222222222222");
	});

	it("ignores Codex descendant session_meta lines", () => {
		const line = JSON.stringify({
			type: "session_meta",
			payload: {
				id: "child-session-123",
				cwd: "/tmp/kanban/task",
				source: {
					subagent: {
						thread_spawn: {
							parent_thread_id: "root-session-123",
							depth: 1,
						},
					},
				},
			},
		});

		expect(extractAgentSessionIdFromOutput("codex", `${line}\n`)).toBeNull();
	});

	it("resolves Codex session ids from matching rollout files", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "kanban-codex-session-id-"));
		const sessionsRoot = join(tempDir, "sessions");
		const taskCwd = "/tmp/kanban/task-session-id";
		const startedAt = Date.now() - 1000;

		try {
			const dateDir = getCodexSessionDateDir(sessionsRoot, startedAt);
			await mkdir(dateDir, { recursive: true });
			await writeFile(
				join(dateDir, "rollout-2026-05-13T00-00-01-other.jsonl"),
				JSON.stringify({
					type: "session_meta",
					payload: {
						id: "33333333-3333-4333-8333-333333333333",
						cwd: "/tmp/kanban/other",
					},
				}),
				"utf8",
			);
			await writeFile(
				join(dateDir, "rollout-2026-05-13T00-00-02-match.jsonl"),
				JSON.stringify({
					type: "session_meta",
					payload: {
						id: "44444444-4444-4444-8444-444444444444",
						cwd: taskCwd,
					},
				}),
				"utf8",
			);

			const resolved = await resolveCodexSessionIdForCwd(taskCwd, startedAt, sessionsRoot);
			expect(resolved).toBe("44444444-4444-4444-8444-444444444444");
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves Hermes session ids from matching session files", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "kanban-hermes-session-id-"));
		const sessionsRoot = join(tempDir, "sessions");

		try {
			await mkdir(sessionsRoot, { recursive: true });
			await writeFile(
				join(sessionsRoot, "session_20260513_010000_other.json"),
				JSON.stringify({
					session_id: "20260513_010000_other",
					messages: [{ role: "user", content: "Other task" }],
				}),
				"utf8",
			);
			await writeFile(
				join(sessionsRoot, "session_20260513_010001_match.json"),
				JSON.stringify({
					session_id: "20260513_010001_match",
					messages: [{ role: "user", content: "Fix the Hermes resume flow" }],
				}),
				"utf8",
			);

			const resolved = await resolveHermesSessionIdForPrompt(
				"Fix the Hermes resume flow",
				Date.now() - 1000,
				sessionsRoot,
			);
			expect(resolved).toBe("20260513_010001_match");
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
