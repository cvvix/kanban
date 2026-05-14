import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath, type RuntimeRecoverableAgentId } from "./workspace-state";

const REGISTRY_DIRNAME = "agent-session-registry";

const agentSessionRegistrationSchema = z.object({
	workspaceId: z.string().min(1),
	taskId: z.string().min(1),
	agentId: z.enum(["claude", "codex", "hermes"]),
	agentSessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{5,191}$/),
	workspacePath: z.string().nullable(),
	startedAt: z.number().nullable(),
	updatedAt: z.number(),
	source: z.string().min(1),
});

export type AgentSessionRegistration = z.infer<typeof agentSessionRegistrationSchema>;

export interface WriteAgentSessionRegistrationInput {
	workspaceId: string;
	taskId: string;
	agentId: RuntimeRecoverableAgentId;
	agentSessionId: string;
	workspacePath: string | null;
	startedAt: number | null;
	source: string;
	updatedAt?: number;
}

function getAgentSessionRegistryDirectory(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), REGISTRY_DIRNAME);
}

export function getAgentSessionRegistrationPath(workspaceId: string, taskId: string): string {
	return join(getAgentSessionRegistryDirectory(workspaceId), `${encodeURIComponent(taskId)}.json`);
}

export async function writeAgentSessionRegistration(input: WriteAgentSessionRegistrationInput): Promise<void> {
	const record = agentSessionRegistrationSchema.parse({
		...input,
		updatedAt: input.updatedAt ?? Date.now(),
	});
	await lockedFileSystem.writeJsonFileAtomic(
		getAgentSessionRegistrationPath(record.workspaceId, record.taskId),
		record,
	);
}

export async function loadAgentSessionRegistration(
	workspaceId: string,
	taskId: string,
	expectedAgentId?: RuntimeRecoverableAgentId,
): Promise<AgentSessionRegistration | null> {
	let raw: string;
	try {
		raw = await readFile(getAgentSessionRegistrationPath(workspaceId, taskId), "utf8");
	} catch {
		return null;
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		return null;
	}
	const parsed = agentSessionRegistrationSchema.safeParse(parsedJson);
	if (!parsed.success) {
		return null;
	}
	const record = parsed.data;
	if (record.workspaceId !== workspaceId || record.taskId !== taskId) {
		return null;
	}
	if (expectedAgentId && record.agentId !== expectedAgentId) {
		return null;
	}
	return record;
}

export async function removeAgentSessionRegistration(workspaceId: string, taskId: string): Promise<void> {
	await rm(getAgentSessionRegistrationPath(workspaceId, taskId), { force: true });
}
