import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import type { Command } from "commander";
import type { RuntimeHookEvent, RuntimeTaskHookActivity } from "../core/api-contract";
import { buildKanbanCommandParts } from "../core/kanban-command";
import { buildKanbanRuntimeUrl, getRuntimeFetch } from "../core/runtime-endpoint";
import { buildWindowsCmdArgsArray, resolveWindowsComSpec, shouldUseWindowsCmdLaunch } from "../core/windows-cmd-launch";
import { writeAgentSessionRegistration } from "../state/agent-session-registration";
import type { RuntimeRecoverableAgentId } from "../state/workspace-state";
import { resolveCodexSessionIdForCwd } from "../terminal/agent-session-id";
import { parseHookRuntimeContextFromEnv } from "../terminal/hook-runtime-context";
import type { RuntimeAppRouter } from "../trpc/app-router";
import {
	type CodexMappedHookEvent,
	resolveCodexRolloutFinalMessageForCwd,
	startCodexSessionWatcher,
} from "./hook-events/codex-hook-events";
import { enrichDroidReviewMetadata } from "./hook-events/droid-hook-events";
import { asRecord, normalizeWhitespace, readNestedString, readStringField } from "./hook-events/hook-utils";
import { normalizeKiroHookMetadata } from "./hook-events/kiro-hook-events";

export {
	createCodexWatcherState,
	parseCodexEventLine,
	resolveCodexRolloutFinalMessageForCwd,
	startCodexSessionWatcher,
} from "./hook-events/codex-hook-events";

const VALID_EVENTS = new Set<RuntimeHookEvent>(["to_review", "to_in_progress", "activity"]);

interface HooksIngestArgs {
	event: RuntimeHookEvent;
	taskId: string;
	workspaceId: string;
	metadata?: Partial<RuntimeTaskHookActivity>;
	payload?: Record<string, unknown> | null;
}

interface HookCommandMetadataOptionValues {
	source?: string;
	activityText?: string;
	toolName?: string;
	finalMessage?: string;
	hookEventName?: string;
	notificationType?: string;
	metadataBase64?: string;
}

interface CodexWrapperArgs {
	realBinary: string;
	agentArgs: string[];
}

interface HermesWrapperArgs {
	realBinary: string;
	agentArgs: string[];
}

function formatError(error: unknown): string {
	if (error instanceof TRPCClientError) {
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timeoutHandle: NodeJS.Timeout | null = null;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			reject(new Error(`${label} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
}

function parseHookEvent(value: string): RuntimeHookEvent {
	if (!VALID_EVENTS.has(value as RuntimeHookEvent)) {
		throw new Error(`Invalid event "${value}". Must be one of: ${[...VALID_EVENTS].join(", ")}`);
	}
	return value as RuntimeHookEvent;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
	try {
		return asRecord(JSON.parse(value));
	} catch {
		return null;
	}
}

function parseMetadataFromOptions(options: HookCommandMetadataOptionValues): Partial<RuntimeTaskHookActivity> {
	const metadata: Partial<RuntimeTaskHookActivity> = {};
	const activityText = options.activityText;
	const toolName = options.toolName;
	const finalMessage = options.finalMessage;
	const hookEventName = options.hookEventName;
	const notificationType = options.notificationType;
	const source = options.source;

	if (activityText) {
		metadata.activityText = normalizeWhitespace(activityText);
	}
	if (toolName) {
		metadata.toolName = normalizeWhitespace(toolName);
	}
	if (finalMessage) {
		metadata.finalMessage = normalizeWhitespace(finalMessage);
	}
	if (hookEventName) {
		metadata.hookEventName = normalizeWhitespace(hookEventName);
	}
	if (notificationType) {
		metadata.notificationType = normalizeWhitespace(notificationType);
	}
	if (source) {
		metadata.source = normalizeWhitespace(source);
	}

	return metadata;
}

function parseMetadataFromBase64(encoded: string | undefined): Record<string, unknown> | null {
	if (!encoded) {
		return null;
	}
	try {
		return asRecord(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
	} catch {
		return null;
	}
}

function extractToolInput(payload: Record<string, unknown>): Record<string, unknown> | null {
	const direct = asRecord(payload.tool_input);
	if (direct) {
		return direct;
	}
	const directCamel = asRecord(payload.toolInput);
	if (directCamel) {
		return directCamel;
	}
	const preTool = asRecord(payload.preToolUse);
	const preParams = preTool ? asRecord(preTool.parameters) : null;
	if (preParams) {
		return preParams;
	}
	const preInput = preTool ? asRecord(preTool.input) : null;
	if (preInput) {
		return preInput;
	}
	const postTool = asRecord(payload.postToolUse);
	const postParams = postTool ? asRecord(postTool.parameters) : null;
	if (postParams) {
		return postParams;
	}
	const postInput = postTool ? asRecord(postTool.input) : null;
	if (postInput) {
		return postInput;
	}
	const output = asRecord(payload.output);
	const outputArgs = output ? asRecord(output.args) : null;
	return outputArgs;
}

function describeToolOperation(toolName: string | null, toolInput: Record<string, unknown> | null): string | null {
	if (!toolName || !toolInput) {
		return null;
	}

	const command =
		readStringField(toolInput, "command") ??
		readStringField(toolInput, "cmd") ??
		readStringField(toolInput, "query") ??
		readStringField(toolInput, "description");
	if (command) {
		return `${toolName}: ${command}`;
	}

	const filePath =
		readStringField(toolInput, "file_path") ??
		readStringField(toolInput, "filePath") ??
		readStringField(toolInput, "path");
	if (filePath) {
		return `${toolName}: ${filePath}`;
	}

	return toolName;
}

function inferActivityText(
	event: RuntimeHookEvent,
	payload: Record<string, unknown> | null,
	toolName: string | null,
	finalMessage: string | null,
	notificationType: string | null,
): string | null {
	const hookEventName = payload
		? (readStringField(payload, "hook_event_name") ??
			readStringField(payload, "hookEventName") ??
			readStringField(payload, "hookName"))
		: null;
	const normalizedHookEvent = hookEventName?.toLowerCase() ?? "";
	const codexType = payload ? readStringField(payload, "type") : null;
	const normalizedCodexType = codexType?.toLowerCase() ?? "";
	const toolInput = payload ? extractToolInput(payload) : null;
	const toolOperation = describeToolOperation(toolName, toolInput);

	if (normalizedCodexType === "task_started") {
		return "Working on task";
	}
	if (normalizedCodexType === "exec_command_begin") {
		return "Running command";
	}
	if (normalizedCodexType.endsWith("_approval_request")) {
		return "Waiting for approval";
	}

	if (normalizedHookEvent === "pretooluse" || normalizedHookEvent === "beforetool") {
		return toolOperation ? `Using ${toolOperation}` : "Using tool";
	}
	if (normalizedHookEvent === "posttooluse" || normalizedHookEvent === "aftertool") {
		return toolOperation ? `Completed ${toolOperation}` : "Completed tool";
	}
	if (normalizedHookEvent === "posttoolusefailure") {
		const error = payload ? readStringField(payload, "error") : null;
		if (toolOperation && error) {
			return `Failed ${toolOperation}: ${error}`;
		}
		if (toolOperation) {
			return `Failed ${toolOperation}`;
		}
		return error ? `Tool failed: ${error}` : "Tool failed";
	}
	if (normalizedHookEvent === "permissionrequest") {
		return "Waiting for approval";
	}
	if (normalizedHookEvent === "userpromptsubmit" || normalizedHookEvent === "beforeagent") {
		return "Resumed after user input";
	}
	if (
		normalizedHookEvent === "stop" ||
		normalizedHookEvent === "subagentstop" ||
		normalizedHookEvent === "afteragent"
	) {
		return finalMessage ? `Final: ${finalMessage}` : null;
	}
	if (normalizedHookEvent === "taskcomplete") {
		return finalMessage ? `Final: ${finalMessage}` : null;
	}

	if (notificationType === "permission_prompt" || notificationType === "permission.asked") {
		return "Waiting for approval";
	}
	if (notificationType === "user_attention") {
		return null;
	}

	if (event === "to_review") {
		return null;
	}
	if (event === "to_in_progress") {
		return "Agent active";
	}
	return null;
}

export function inferHookSourceFromPayload(payload: Record<string, unknown> | null): string | null {
	const transcriptPath = payload
		? (readStringField(payload, "transcript_path") ?? readStringField(payload, "transcriptPath"))
		: null;
	const normalizedTranscriptPath = transcriptPath?.replaceAll("\\", "/").toLowerCase() ?? null;
	if (normalizedTranscriptPath?.includes("/.claude/")) {
		return "claude";
	}
	if (normalizedTranscriptPath?.includes("/.kiro/")) {
		return "kiro";
	}
	if (normalizedTranscriptPath?.includes("/.factory/")) {
		return "droid";
	}
	if (payload && readStringField(payload, "type") === "agent-turn-complete") {
		return "codex";
	}
	return null;
}

function normalizeHookMetadata(
	event: RuntimeHookEvent,
	payload: Record<string, unknown> | null,
	flagMetadata: Partial<RuntimeTaskHookActivity>,
): Partial<RuntimeTaskHookActivity> | undefined {
	const inferredSource = inferHookSourceFromPayload(payload);
	const sourceHint = flagMetadata.source ?? inferredSource;
	if (sourceHint?.toLowerCase() === "kiro") {
		const kiroMetadata = normalizeKiroHookMetadata({
			event,
			payload,
			flagMetadata,
			sourceHint,
		});
		if (kiroMetadata) {
			return kiroMetadata;
		}
	}

	const hookEventName = payload
		? (readStringField(payload, "hook_event_name") ??
			readStringField(payload, "hookEventName") ??
			readStringField(payload, "hookName"))
		: null;
	const toolName = payload
		? (readStringField(payload, "tool_name") ??
			readStringField(payload, "toolName") ??
			readNestedString(payload, ["preToolUse", "tool"]) ??
			readNestedString(payload, ["preToolUse", "toolName"]) ??
			readNestedString(payload, ["postToolUse", "tool"]) ??
			readNestedString(payload, ["postToolUse", "toolName"]) ??
			readNestedString(payload, ["input", "tool"]) ??
			readNestedString(payload, ["input", "toolName"]))
		: null;
	const notificationType = payload
		? (readStringField(payload, "notification_type") ??
			readStringField(payload, "notificationType") ??
			readNestedString(payload, ["event", "type"]) ??
			readNestedString(payload, ["notification", "event"]))
		: null;
	const finalMessage = payload
		? (readStringField(payload, "last_assistant_message") ??
			readStringField(payload, "lastAssistantMessage") ??
			readStringField(payload, "last-assistant-message") ??
			readNestedString(payload, ["taskComplete", "taskMetadata", "result"]) ??
			readNestedString(payload, ["taskComplete", "result"]))
		: null;

	const activityText = inferActivityText(event, payload, toolName, finalMessage, notificationType);
	const merged: Partial<RuntimeTaskHookActivity> = {
		source: flagMetadata.source ?? inferredSource ?? null,
		hookEventName: flagMetadata.hookEventName ?? hookEventName ?? null,
		toolName: flagMetadata.toolName ?? toolName ?? null,
		notificationType: flagMetadata.notificationType ?? notificationType ?? null,
		finalMessage: flagMetadata.finalMessage ?? (finalMessage ? normalizeWhitespace(finalMessage) : null),
		activityText: flagMetadata.activityText ?? (activityText ? normalizeWhitespace(activityText) : null),
	};

	const hasValue = Object.values(merged).some((value) => typeof value === "string" && value.trim().length > 0);
	if (!hasValue) {
		return undefined;
	}

	return merged;
}

function parseHooksIngestArgs(
	event: RuntimeHookEvent,
	options: HookCommandMetadataOptionValues,
	payloadArg: string | undefined,
	stdinPayload: string,
): HooksIngestArgs {
	const context = parseHookRuntimeContextFromEnv();
	const flagMetadata = parseMetadataFromOptions(options);
	const payloadFromBase64 = parseMetadataFromBase64(options.metadataBase64);
	const payloadFromStdin = parseJsonObject(stdinPayload.trim());
	const payloadFromArg = payloadArg ? parseJsonObject(payloadArg) : null;
	const payload = payloadFromBase64 ?? payloadFromStdin ?? payloadFromArg;
	const metadata = normalizeHookMetadata(event, payload, flagMetadata);
	return {
		event,
		taskId: context.taskId,
		workspaceId: context.workspaceId,
		metadata,
		payload,
	};
}

async function ingestHookEvent(args: HooksIngestArgs): Promise<void> {
	const trpcClient = createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: buildKanbanRuntimeUrl("/api/trpc"),
				maxItems: 1,
				fetch: async (url, options) => {
					const runtimeFetch = await getRuntimeFetch();
					return runtimeFetch(url, options);
				},
			}),
		],
	});
	const ingestResponse = await withTimeout(
		trpcClient.hooks.ingest.mutate({
			taskId: args.taskId,
			workspaceId: args.workspaceId,
			event: args.event,
			metadata: args.metadata,
		}),
		3000,
		"kanban hooks ingest",
	);
	if (ingestResponse.ok === false) {
		throw new Error(ingestResponse.error ?? "Hook ingest failed");
	}
}

function spawnBackgroundKanban(args: string[]): void {
	try {
		const commandParts = buildKanbanCommandParts(args);
		const child = spawn(commandParts[0], commandParts.slice(1), {
			detached: false,
			stdio: "ignore",
			env: process.env,
		});
		child.unref();
	} catch {
		// Best effort: hook notification failures should never block agents.
	}
}

function appendMetadataFlags(args: string[], metadata?: Partial<RuntimeTaskHookActivity>): string[] {
	if (!metadata) {
		return args;
	}
	if (metadata.source) {
		args.push("--source", metadata.source);
	}
	if (metadata.activityText) {
		args.push("--activity-text", metadata.activityText);
	}
	if (metadata.toolName) {
		args.push("--tool-name", metadata.toolName);
	}
	if (metadata.finalMessage) {
		args.push("--final-message", metadata.finalMessage);
	}
	if (metadata.hookEventName) {
		args.push("--hook-event-name", metadata.hookEventName);
	}
	if (metadata.notificationType) {
		args.push("--notification-type", metadata.notificationType);
	}
	return args;
}

function notifyCodexSessionWatcherEvent(mapped: CodexMappedHookEvent): void {
	spawnBackgroundKanban(appendMetadataFlags(["hooks", "notify", "--event", mapped.event], mapped.metadata));
}

function normalizeAgentSessionId(value: string | null | undefined): string | null {
	const trimmed = value?.trim().replace(/^[`"']+|[`"',.;:)]+$/g, "");
	if (!trimmed || !/^[A-Za-z0-9][A-Za-z0-9._-]{5,191}$/.test(trimmed)) {
		return null;
	}
	return trimmed;
}

async function writeWrapperAgentSessionRegistration(
	agentId: RuntimeRecoverableAgentId,
	agentSessionId: string,
	startedAt: number,
	source: string,
): Promise<void> {
	const normalizedSessionId = normalizeAgentSessionId(agentSessionId);
	if (!normalizedSessionId) {
		return;
	}
	const context = parseHookRuntimeContextFromEnv();
	await writeAgentSessionRegistration({
		workspaceId: context.workspaceId,
		taskId: context.taskId,
		agentId,
		agentSessionId: normalizedSessionId,
		workspacePath: process.cwd(),
		startedAt,
		source,
	});
}

async function enrichCodexReviewMetadata(args: HooksIngestArgs, cwd: string): Promise<HooksIngestArgs> {
	if (args.event !== "to_review") {
		return args;
	}
	const metadata = args.metadata ?? {};
	const source = metadata.source?.toLowerCase();
	if (source !== "codex") {
		return args;
	}
	const existingFinalMessage =
		typeof metadata.finalMessage === "string" && metadata.finalMessage.trim().length > 0
			? metadata.finalMessage
			: null;
	if (existingFinalMessage) {
		return {
			...args,
			metadata: {
				...metadata,
				activityText: metadata.activityText ?? `Final: ${existingFinalMessage}`,
			},
		};
	}

	const fallbackFinalMessage = await resolveCodexRolloutFinalMessageForCwd(cwd);
	if (!fallbackFinalMessage) {
		return {
			...args,
			metadata: {
				...metadata,
				activityText: metadata.activityText ?? "Waiting for review",
			},
		};
	}

	return {
		...args,
		metadata: {
			...metadata,
			finalMessage: fallbackFinalMessage,
			activityText: metadata.activityText ?? `Final: ${fallbackFinalMessage}`,
		},
	};
}

async function runHooksNotify(
	event: RuntimeHookEvent,
	options: HookCommandMetadataOptionValues,
	payloadArg: string | undefined,
): Promise<void> {
	try {
		const stdinPayload = await readStdinText();
		const parsedArgs = parseHooksIngestArgs(event, options, payloadArg, stdinPayload);
		const codexEnrichedArgs = await enrichCodexReviewMetadata(parsedArgs, process.cwd());
		const args = await enrichDroidReviewMetadata(codexEnrichedArgs);
		await ingestHookEvent(args);
	} catch {
		// Best effort only.
	}
}

async function readStdinText(): Promise<string> {
	if (process.stdin.isTTY) {
		return "";
	}
	const chunks: string[] = [];
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		chunks.push(chunk);
	}
	return chunks.join("");
}

function mapGeminiHookEvent(eventName: string): RuntimeHookEvent | null {
	if (eventName === "AfterAgent") {
		return "to_review";
	}
	if (eventName === "BeforeAgent") {
		return "to_in_progress";
	}
	if (eventName === "AfterTool" || eventName === "BeforeTool" || eventName === "Notification") {
		return "activity";
	}
	return null;
}

async function runCodexHookSubcommand(
	event: RuntimeHookEvent,
	options: HookCommandMetadataOptionValues,
	payloadArg: string | undefined,
): Promise<void> {
	let payload = "";
	try {
		payload = await readStdinText();
	} catch {
		payload = "";
	}

	process.stdout.write("{}\n");

	try {
		const parsedArgs = parseHooksIngestArgs(event, options, payloadArg, payload);
		const codexEnrichedArgs = await enrichCodexReviewMetadata(parsedArgs, process.cwd());
		await ingestHookEvent(codexEnrichedArgs);
	} catch {
		// Best effort only.
	}
}

async function runGeminiHookSubcommand(): Promise<void> {
	let payload = "";
	try {
		payload = await readStdinText();
	} catch {
		payload = "";
	}

	let hookEventName = "";
	let payloadRecord: Record<string, unknown> | null = null;
	try {
		const parsed = JSON.parse(payload || "{}") as { hook_event_name?: unknown };
		payloadRecord = asRecord(parsed);
		hookEventName =
			typeof parsed.hook_event_name === "string"
				? parsed.hook_event_name
				: payloadRecord && typeof payloadRecord.hookEventName === "string"
					? payloadRecord.hookEventName
					: "";
	} catch {
		hookEventName = "";
		payloadRecord = null;
	}

	process.stdout.write("{}\n");

	const mappedEvent = mapGeminiHookEvent(hookEventName);
	if (!mappedEvent) {
		return;
	}
	const metadata = normalizeHookMetadata(mappedEvent, payloadRecord, {
		source: "gemini",
		hookEventName: hookEventName || undefined,
	});
	spawnBackgroundKanban(appendMetadataFlags(["hooks", "notify", "--event", mappedEvent], metadata));
}

export function buildCodexWrapperChildArgs(agentArgs: string[]): string[] {
	return [...agentArgs];
}

export function buildCodexWrapperSpawn(
	realBinary: string,
	agentArgs: string[],
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): { binary: string; args: string[] } {
	const childArgs = buildCodexWrapperChildArgs(agentArgs);
	if (!shouldUseWindowsCmdLaunch(realBinary, platform, env)) {
		return {
			binary: realBinary,
			args: childArgs,
		};
	}
	return {
		binary: resolveWindowsComSpec(env),
		args: buildWindowsCmdArgsArray(realBinary, childArgs),
	};
}

async function runCodexWrapperSubcommand(wrapperArgs: CodexWrapperArgs): Promise<void> {
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	const wrapperStartedAt = Date.now();
	let shuttingDown = false;
	let stopWatcher: () => Promise<void> = async () => {};
	let watcherStartPromise: Promise<void> | null = null;
	let cwdPollTimer: NodeJS.Timeout | null = null;
	let queuedCwdPoll = Promise.resolve();
	let registeredSessionId = "";

	const registerSessionId = async (sessionId: string, source: string) => {
		const normalizedSessionId = normalizeAgentSessionId(sessionId);
		if (!normalizedSessionId || registeredSessionId === normalizedSessionId) {
			return;
		}
		await writeWrapperAgentSessionRegistration("codex", normalizedSessionId, wrapperStartedAt, source);
		registeredSessionId = normalizedSessionId;
	};

	const pollSessionIdFromCwd = async () => {
		if (registeredSessionId) {
			return;
		}
		const sessionId = await resolveCodexSessionIdForCwd(process.cwd(), wrapperStartedAt);
		if (!sessionId) {
			return;
		}
		await registerSessionId(sessionId, "codex-session-cwd");
	};

	const queueCwdPoll = () => {
		queuedCwdPoll = queuedCwdPoll.then(
			() => pollSessionIdFromCwd(),
			() => pollSessionIdFromCwd(),
		);
		return queuedCwdPoll;
	};

	let shouldWatchSessionLog = false;
	try {
		parseHookRuntimeContextFromEnv(childEnv);
		shouldWatchSessionLog = true;
	} catch {
		shouldWatchSessionLog = false;
	}

	if (shouldWatchSessionLog) {
		childEnv.CODEX_TUI_RECORD_SESSION = "1";
		if (!childEnv.CODEX_TUI_SESSION_LOG_PATH) {
			childEnv.CODEX_TUI_SESSION_LOG_PATH = join(
				tmpdir(),
				`kanban-codex-session-${process.pid}_${Date.now()}.jsonl`,
			);
		}
		const sessionLogPath = childEnv.CODEX_TUI_SESSION_LOG_PATH;
		if (sessionLogPath) {
			watcherStartPromise = (async () => {
				const startedStopWatcher = await startCodexSessionWatcher(
					sessionLogPath,
					notifyCodexSessionWatcherEvent,
					undefined,
					{
						cwd: process.cwd(),
						onSessionId: (sessionId) => {
							void registerSessionId(sessionId, "codex-session-log").catch(() => {});
						},
					},
				);
				if (shuttingDown) {
					await startedStopWatcher();
					return;
				}
				stopWatcher = startedStopWatcher;
			})().catch(() => {
				// Best effort only.
			});
		}
		cwdPollTimer = setInterval(() => {
			void queueCwdPoll();
		}, 500);
		cwdPollTimer.unref?.();
		void queueCwdPoll();
	}

	const childLaunch = buildCodexWrapperSpawn(wrapperArgs.realBinary, wrapperArgs.agentArgs);
	const child = spawn(childLaunch.binary, childLaunch.args, {
		stdio: "inherit",
		env: childEnv,
	});

	const forwardSignal = (signal: NodeJS.Signals) => {
		if (!child.killed) {
			child.kill(signal);
		}
	};

	const onSigint = () => {
		forwardSignal("SIGINT");
	};
	const onSigterm = () => {
		forwardSignal("SIGTERM");
	};

	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	const cleanup = async () => {
		shuttingDown = true;
		if (cwdPollTimer) {
			clearInterval(cwdPollTimer);
			cwdPollTimer = null;
		}
		await queueCwdPoll().catch(() => {});
		await queuedCwdPoll.catch(() => {});
		await watcherStartPromise;
		await stopWatcher();
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	};

	await new Promise<void>((resolve) => {
		let finished = false;
		const finish = (exitCode: number) => {
			if (finished) {
				return;
			}
			finished = true;
			void (async () => {
				await cleanup();
				process.exitCode = exitCode;
				resolve();
			})();
		};

		child.on("error", () => {
			finish(1);
		});
		child.on("exit", (code) => {
			finish(code ?? 1);
		});
	});
}

export function buildHermesWrapperSpawn(
	realBinary: string,
	agentArgs: string[],
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): { binary: string; args: string[] } {
	if (!shouldUseWindowsCmdLaunch(realBinary, platform, env)) {
		return {
			binary: realBinary,
			args: [...agentArgs],
		};
	}
	return {
		binary: resolveWindowsComSpec(env),
		args: buildWindowsCmdArgsArray(realBinary, agentArgs),
	};
}

function readCliOptionValue(args: string[], optionName: string): string | null {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === optionName) {
			const next = args[index + 1];
			return next && !next.startsWith("-") ? next : null;
		}
		if (arg.startsWith(`${optionName}=`)) {
			const value = arg.slice(optionName.length + 1).trim();
			return value || null;
		}
	}
	return null;
}

function quoteSqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function resolveHermesHome(env: NodeJS.ProcessEnv): string {
	return env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
}

async function runBufferedCommand(binary: string, args: string[], timeoutMs: number): Promise<string> {
	return await new Promise((resolve) => {
		const child = spawn(binary, args, {
			stdio: ["ignore", "pipe", "ignore"],
		});
		let output = "";
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
		}, timeoutMs);
		timeout.unref?.();
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			output += chunk;
		});
		child.on("error", () => {
			clearTimeout(timeout);
			resolve("");
		});
		child.on("exit", () => {
			clearTimeout(timeout);
			resolve(output);
		});
	});
}

async function resolveHermesSessionIdBySource(
	source: string,
	startedAt: number,
	env: NodeJS.ProcessEnv,
): Promise<string | null> {
	const query = [
		"SELECT id FROM sessions",
		`WHERE source = ${quoteSqlString(source)}`,
		`AND started_at >= ${Math.floor((startedAt - 10_000) / 1000)}`,
		"ORDER BY started_at DESC LIMIT 1;",
	].join(" ");
	const output = await runBufferedCommand(
		"sqlite3",
		["-readonly", join(resolveHermesHome(env), "state.db"), query],
		1500,
	);
	return normalizeAgentSessionId(output.split(/\r?\n/)[0]);
}

async function resolveHermesSessionIdBySystemPromptText(
	text: string,
	startedAt: number,
	env: NodeJS.ProcessEnv,
): Promise<string | null> {
	const query = [
		"SELECT id FROM sessions",
		`WHERE system_prompt LIKE ${quoteSqlString(`%${text}%`)}`,
		`AND started_at >= ${Math.floor((startedAt - 10_000) / 1000)}`,
		"ORDER BY started_at DESC LIMIT 1;",
	].join(" ");
	const output = await runBufferedCommand(
		"sqlite3",
		["-readonly", join(resolveHermesHome(env), "state.db"), query],
		1500,
	);
	return normalizeAgentSessionId(output.split(/\r?\n/)[0]);
}

async function runHermesWrapperSubcommand(wrapperArgs: HermesWrapperArgs): Promise<void> {
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	const wrapperStartedAt = Date.now();
	const source = readCliOptionValue(wrapperArgs.agentArgs, "--source");
	let systemPromptText = "";
	let registeredSessionId = "";
	let shuttingDown = false;
	let queuedPoll = Promise.resolve();

	const pollSessionId = async () => {
		if (registeredSessionId) {
			return;
		}
		let registrationSource = "";
		let sessionId = source ? await resolveHermesSessionIdBySource(source, wrapperStartedAt, childEnv) : null;
		if (sessionId) {
			registrationSource = `hermes-source:${source}`;
		} else if (systemPromptText) {
			sessionId = await resolveHermesSessionIdBySystemPromptText(systemPromptText, wrapperStartedAt, childEnv);
			if (sessionId) {
				registrationSource = "hermes-system-prompt-cwd";
			}
		}
		if (!sessionId || registeredSessionId === sessionId) {
			return;
		}
		registeredSessionId = sessionId;
		await writeWrapperAgentSessionRegistration("hermes", sessionId, wrapperStartedAt, registrationSource);
	};
	const queuePoll = () => {
		queuedPoll = queuedPoll.then(
			() => pollSessionId(),
			() => pollSessionId(),
		);
		return queuedPoll;
	};

	let timer: NodeJS.Timeout | null = null;
	try {
		parseHookRuntimeContextFromEnv(childEnv);
		systemPromptText = process.cwd();
		if (source || systemPromptText) {
			timer = setInterval(() => {
				void queuePoll();
			}, 500);
			timer.unref?.();
			void queuePoll();
		}
	} catch {
		timer = null;
	}

	const childLaunch = buildHermesWrapperSpawn(wrapperArgs.realBinary, wrapperArgs.agentArgs);
	const child = spawn(childLaunch.binary, childLaunch.args, {
		stdio: "inherit",
		env: childEnv,
	});

	const forwardSignal = (signal: NodeJS.Signals) => {
		if (!child.killed) {
			child.kill(signal);
		}
	};

	const onSigint = () => {
		forwardSignal("SIGINT");
	};
	const onSigterm = () => {
		forwardSignal("SIGTERM");
	};

	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	const cleanup = async () => {
		shuttingDown = true;
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		await queuePoll().catch(() => {});
		await queuedPoll.catch(() => {});
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	};

	await new Promise<void>((resolve) => {
		let finished = false;
		const finish = (exitCode: number) => {
			if (finished) {
				return;
			}
			finished = true;
			void (async () => {
				await cleanup();
				process.exitCode = exitCode;
				resolve();
			})();
		};

		child.on("error", () => {
			finish(1);
		});
		child.on("exit", (code) => {
			finish(code ?? (shuttingDown ? 0 : 1));
		});
	});
}

async function runHooksIngest(
	event: RuntimeHookEvent,
	options: HookCommandMetadataOptionValues,
	payloadArg: string | undefined,
): Promise<void> {
	let args: HooksIngestArgs;
	try {
		const stdinPayload = await readStdinText();
		const parsedArgs = parseHooksIngestArgs(event, options, payloadArg, stdinPayload);
		const codexEnrichedArgs = await enrichCodexReviewMetadata(parsedArgs, process.cwd());
		args = await enrichDroidReviewMetadata(codexEnrichedArgs);
	} catch (error) {
		process.stderr.write(`kanban hooks ingest: ${formatError(error)}\n`);
		process.exitCode = 1;
		return;
	}

	try {
		await ingestHookEvent(args);
	} catch (error) {
		process.stderr.write(`kanban hooks ingest: ${formatError(error)}\n`);
		process.exitCode = 1;
	}
}

export function registerHooksCommand(program: Command): void {
	const hooks = program.command("hooks").description("Runtime hook helpers for agent integrations.");

	hooks
		.command("ingest [payload]")
		.description("Ingest hook event into Kanban runtime.")
		.requiredOption("--event <event>", "Event: to_review | to_in_progress | activity.", parseHookEvent)
		.option("--source <source>", "Hook source.")
		.option("--activity-text <text>", "Activity summary text.")
		.option("--tool-name <name>", "Tool name.")
		.option("--final-message <message>", "Final message.")
		.option("--hook-event-name <name>", "Original hook event name.")
		.option("--notification-type <type>", "Notification type.")
		.option("--metadata-base64 <base64>", "Base64-encoded JSON metadata payload.")
		.action(
			async (
				payload: string | undefined,
				options: HookCommandMetadataOptionValues & { event: RuntimeHookEvent },
			) => {
				await runHooksIngest(options.event, options, payload);
			},
		);

	hooks
		.command("notify [payload]")
		.description("Best-effort hook ingest that never throws.")
		.requiredOption("--event <event>", "Event: to_review | to_in_progress | activity.", parseHookEvent)
		.option("--source <source>", "Hook source.")
		.option("--activity-text <text>", "Activity summary text.")
		.option("--tool-name <name>", "Tool name.")
		.option("--final-message <message>", "Final message.")
		.option("--hook-event-name <name>", "Original hook event name.")
		.option("--notification-type <type>", "Notification type.")
		.option("--metadata-base64 <base64>", "Base64-encoded JSON metadata payload.")
		.action(
			async (
				payload: string | undefined,
				options: HookCommandMetadataOptionValues & { event: RuntimeHookEvent },
			) => {
				await runHooksNotify(options.event, options, payload);
			},
		);

	hooks
		.command("gemini-hook")
		.description("Gemini hook entrypoint.")
		.action(async () => {
			await runGeminiHookSubcommand();
		});

	hooks
		.command("codex-hook [payload]")
		.description("Codex hook entrypoint.")
		.requiredOption("--event <event>", "Event: to_review | to_in_progress | activity.", parseHookEvent)
		.option("--source <source>", "Hook source.")
		.option("--activity-text <text>", "Activity summary text.")
		.option("--tool-name <name>", "Tool name.")
		.option("--final-message <message>", "Final message.")
		.option("--hook-event-name <name>", "Original hook event name.")
		.option("--notification-type <type>", "Notification type.")
		.option("--metadata-base64 <base64>", "Base64-encoded JSON metadata payload.")
		.action(
			async (
				payload: string | undefined,
				options: HookCommandMetadataOptionValues & { event: RuntimeHookEvent },
			) => {
				await runCodexHookSubcommand(options.event, options, payload);
			},
		);

	hooks
		.command("codex-wrapper [agentArgs...]")
		.description("Codex wrapper that emits Kanban hook notifications.")
		.requiredOption("--real-binary <path>", "Path to the actual codex binary.")
		.allowUnknownOption(true)
		.action(async (agentArgs: string[] | undefined, options: { realBinary: string }) => {
			await runCodexWrapperSubcommand({
				realBinary: options.realBinary,
				agentArgs: agentArgs ?? [],
			});
		});

	hooks
		.command("hermes-wrapper [agentArgs...]")
		.description("Hermes wrapper that records Kanban session metadata.")
		.requiredOption("--real-binary <path>", "Path to the actual hermes binary.")
		.allowUnknownOption(true)
		.action(async (agentArgs: string[] | undefined, options: { realBinary: string }) => {
			await runHermesWrapperSubcommand({
				realBinary: options.realBinary,
				agentArgs: agentArgs ?? [],
			});
		});
}
