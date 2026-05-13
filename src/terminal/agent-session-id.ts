import type { Dirent, Stats } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeAgentId } from "../core/api-contract";
import { stripAnsi } from "./output-utils";

const MAX_CODEX_ROLLOUT_FILES_TO_SCAN = 250;
const CODEX_ROLLOUT_FILE_FRESH_WINDOW_MS = 10 * 60 * 1000;
const CODEX_ROLLOUT_MATCH_SCAN_BYTES = 256 * 1024;
const MAX_HERMES_SESSION_FILES_TO_SCAN = 100;
const HERMES_SESSION_FILE_FRESH_WINDOW_MS = 10 * 60 * 1000;

interface HermesSessionMessageRecord {
	role?: unknown;
	content?: unknown;
}

interface HermesSessionRecord {
	session_id?: unknown;
	session_start?: unknown;
	last_updated?: unknown;
	title?: unknown;
	messages?: unknown;
}

interface SessionFileCandidate {
	path: string;
	mtimeMs: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeAgentSessionId(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim().replace(/^[`"']+|[`"',.;:)]+$/g, "");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,191}$/.test(trimmed)) {
		return null;
	}
	return trimmed;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
	try {
		return asRecord(JSON.parse(value));
	} catch {
		return null;
	}
}

function normalizePathForComparison(path: string): string {
	return path.replaceAll("\\", "/");
}

async function readFilePrefix(filePath: string, byteLength: number): Promise<string> {
	if (byteLength <= 0) {
		return "";
	}
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(filePath, "r");
		const buffer = Buffer.alloc(byteLength);
		const readResult = await handle.read(buffer, 0, byteLength, 0);
		return buffer.subarray(0, readResult.bytesRead).toString("utf8");
	} finally {
		await handle?.close();
	}
}

async function listCodexRolloutFiles(rootPath: string): Promise<string[]> {
	const stack = [rootPath];
	const files: Array<{ path: string; mtimeMs: number }> = [];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}

		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const entryPath = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(entryPath);
				continue;
			}
			if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
				continue;
			}
			let fileStat: Stats;
			try {
				fileStat = await stat(entryPath);
			} catch {
				continue;
			}
			files.push({ path: entryPath, mtimeMs: fileStat.mtimeMs });
		}
	}

	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return files.map((file) => file.path);
}

async function listHermesSessionFiles(rootPath: string): Promise<SessionFileCandidate[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(rootPath, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: SessionFileCandidate[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.startsWith("session_") || !entry.name.endsWith(".json")) {
			continue;
		}
		const entryPath = join(rootPath, entry.name);
		try {
			const fileStat = await stat(entryPath);
			files.push({ path: entryPath, mtimeMs: fileStat.mtimeMs });
		} catch {}
	}
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return files;
}

function extractCodexSessionIdFromSessionMeta(record: Record<string, unknown>, cwd?: string): string | null {
	const lineType = readStringField(record, "type");
	if (lineType !== "session_meta") {
		return null;
	}
	const payload = asRecord(record.payload);
	const candidateCwd = payload ? readStringField(payload, "cwd") : readStringField(record, "cwd");
	if (cwd && candidateCwd && normalizePathForComparison(candidateCwd) !== normalizePathForComparison(cwd)) {
		return null;
	}
	return normalizeAgentSessionId((payload ? readStringField(payload, "id") : null) ?? readStringField(record, "id"));
}

function extractJsonSessionId(text: string, cwd?: string): string | null {
	for (const line of text.split(/\r?\n/)) {
		const parsed = parseJsonObject(line.trim());
		if (!parsed) {
			continue;
		}
		const sessionId = extractCodexSessionIdFromSessionMeta(parsed, cwd);
		if (sessionId) {
			return sessionId;
		}
	}
	return null;
}

function extractLabeledSessionId(text: string): string | null {
	const patterns = [
		/\bFAKE_AGENT_SESSION_ID\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._-]{5,191})/i,
		/\bsession[_ -]?id\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._-]{5,191})/i,
		/\bsession\s+([A-Za-z0-9][A-Za-z0-9._-]{5,191})\s+(?:started|created|ready|resumed)\b/i,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(text);
		const sessionId = normalizeAgentSessionId(match?.[1] ?? null);
		if (sessionId) {
			return sessionId;
		}
	}
	return null;
}

function normalizeTextForComparison(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function contentToText(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed : null;
	}
	if (!value || typeof value !== "object") {
		return null;
	}
	try {
		const serialized = JSON.stringify(value);
		return serialized.length > 2 ? serialized : null;
	} catch {
		return null;
	}
}

function promptMatchesText(prompt: string, text: string): boolean {
	const normalizedPrompt = normalizeTextForComparison(prompt);
	if (!normalizedPrompt) {
		return false;
	}
	const normalizedText = normalizeTextForComparison(text);
	if (!normalizedText) {
		return false;
	}
	return normalizedText.includes(normalizedPrompt);
}

function parseHermesSessionRecord(value: string): HermesSessionRecord | null {
	try {
		const parsed = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as HermesSessionRecord;
	} catch {
		return null;
	}
}

function hermesRecordMatchesPrompt(record: HermesSessionRecord, prompt: string): boolean {
	if (typeof record.title === "string" && promptMatchesText(prompt, record.title)) {
		return true;
	}
	if (!Array.isArray(record.messages)) {
		return false;
	}
	for (const value of record.messages) {
		const message = asRecord(value) as HermesSessionMessageRecord | null;
		if (!message) {
			continue;
		}
		const text = contentToText(message.content);
		if (text && promptMatchesText(prompt, text)) {
			return true;
		}
	}
	return false;
}

export function extractAgentSessionIdFromOutput(agentId: RuntimeAgentId, text: string): string | null {
	const stripped = stripAnsi(text);
	const labeledSessionId = extractLabeledSessionId(stripped);
	if (labeledSessionId) {
		return labeledSessionId;
	}
	if (agentId === "codex") {
		return extractJsonSessionId(stripped);
	}
	return null;
}

export async function resolveCodexSessionIdForCwd(
	cwd: string,
	sessionStartedAtMs: number,
	sessionsRoot = join(homedir(), ".codex", "sessions"),
): Promise<string | null> {
	if (!cwd.trim()) {
		return null;
	}
	const normalizedCwd = normalizePathForComparison(cwd);
	const encodedCwd = JSON.stringify(normalizedCwd);
	const rolloutFiles = (await listCodexRolloutFiles(sessionsRoot)).slice(0, MAX_CODEX_ROLLOUT_FILES_TO_SCAN);

	for (const filePath of rolloutFiles) {
		let fileStat: Stats;
		try {
			fileStat = await stat(filePath);
			if (fileStat.mtimeMs < sessionStartedAtMs - CODEX_ROLLOUT_FILE_FRESH_WINDOW_MS) {
				continue;
			}
		} catch {
			continue;
		}

		let prefix = "";
		try {
			prefix = await readFilePrefix(filePath, Math.min(fileStat.size, CODEX_ROLLOUT_MATCH_SCAN_BYTES));
		} catch {
			continue;
		}
		if (!prefix.includes(`"cwd":${encodedCwd}`)) {
			continue;
		}
		const sessionId = extractJsonSessionId(prefix, cwd);
		if (sessionId) {
			return sessionId;
		}
	}

	return null;
}

export async function resolveHermesSessionIdForPrompt(
	prompt: string,
	sessionStartedAtMs: number,
	sessionsRoot = join(homedir(), ".hermes", "sessions"),
): Promise<string | null> {
	if (!prompt.trim()) {
		return null;
	}
	const sessionFiles = (await listHermesSessionFiles(sessionsRoot)).slice(0, MAX_HERMES_SESSION_FILES_TO_SCAN);
	for (const file of sessionFiles) {
		if (file.mtimeMs < sessionStartedAtMs - HERMES_SESSION_FILE_FRESH_WINDOW_MS) {
			continue;
		}
		let record: HermesSessionRecord | null = null;
		try {
			record = parseHermesSessionRecord(await readFile(file.path, "utf8"));
		} catch {
			continue;
		}
		if (!record || !hermesRecordMatchesPrompt(record, prompt)) {
			continue;
		}
		const sessionId = normalizeAgentSessionId(typeof record.session_id === "string" ? record.session_id : null);
		if (sessionId) {
			return sessionId;
		}
	}
	return null;
}
