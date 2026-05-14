import * as pty from "node-pty";

import {
	buildWindowsCmdArgsCommandLine,
	resolveWindowsComSpec,
	shouldUseWindowsCmdLaunch,
} from "../core/windows-cmd-launch";

export interface PtyExitEvent {
	exitCode: number;
	signal?: number;
}

export interface SpawnPtySessionRequest {
	binary: string;
	args?: string[] | string;
	cwd: string;
	env?: Record<string, string | undefined>;
	cols: number;
	rows: number;
	onData?: (chunk: Buffer) => void;
	onExit?: (event: PtyExitEvent) => void;
}

type PtyOutputChunk = string | Buffer | Uint8Array;

const PROCESS_GROUP_KILL_GRACE_MS = 2_000;
const activePtyProcessGroupPids = new Set<number>();
let didInstallPtyProcessGroupExitCleanup = false;

function normalizeOutputChunk(data: PtyOutputChunk): Buffer {
	if (typeof data === "string") {
		return Buffer.from(data, "utf8");
	}
	return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function isKillableProcessGroupPid(pid: number): boolean {
	return process.platform !== "win32" && Number.isFinite(pid) && pid > 0;
}

function killPtyProcessGroup(pid: number, signal: NodeJS.Signals): void {
	if (!isKillableProcessGroupPid(pid)) {
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		// Best effort: process group may already be gone or inaccessible.
	}
}

function cleanupActivePtyProcessGroupsOnExit(): void {
	for (const pid of activePtyProcessGroupPids) {
		killPtyProcessGroup(pid, "SIGTERM");
	}
	for (const pid of activePtyProcessGroupPids) {
		killPtyProcessGroup(pid, "SIGKILL");
	}
	activePtyProcessGroupPids.clear();
}

function installPtyProcessGroupExitCleanup(): void {
	if (didInstallPtyProcessGroupExitCleanup) {
		return;
	}
	didInstallPtyProcessGroupExitCleanup = true;
	process.once("exit", cleanupActivePtyProcessGroupsOnExit);
}

function registerPtyProcessGroup(pid: number): void {
	if (!isKillableProcessGroupPid(pid)) {
		return;
	}
	activePtyProcessGroupPids.add(pid);
	installPtyProcessGroupExitCleanup();
}

function unregisterPtyProcessGroup(pid: number): void {
	activePtyProcessGroupPids.delete(pid);
}

function isIgnorablePtyWriteError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EIO" || code === "EBADF";
}

function isIgnorablePtyResizeError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "EIO" || code === "EBADF") {
		return true;
	}
	return error.message.toLowerCase().includes("already exited");
}

function terminatePtyProcess(ptyProcess: pty.IPty): void {
	const pid = ptyProcess.pid;
	killPtyProcessGroup(pid, "SIGTERM");
	ptyProcess.kill();
}

export class PtySession {
	private readonly ptyProcess: pty.IPty;
	private readonly ptyPid: number;
	private forceKillTimer: NodeJS.Timeout | null = null;
	private interrupted = false;
	private exited = false;

	private constructor(
		ptyProcess: pty.IPty,
		private readonly onDataCallback?: (chunk: Buffer) => void,
		private readonly onExitCallback?: (event: PtyExitEvent) => void,
	) {
		this.ptyProcess = ptyProcess;
		this.ptyPid = ptyProcess.pid;
		registerPtyProcessGroup(this.ptyPid);
		(this.ptyProcess.onData as unknown as (listener: (data: PtyOutputChunk) => void) => void)((data) => {
			const chunk = normalizeOutputChunk(data);
			this.onDataCallback?.(chunk);
		});
		this.ptyProcess.onExit((event) => {
			this.exited = true;
			unregisterPtyProcessGroup(this.ptyPid);
			if (this.forceKillTimer) {
				clearTimeout(this.forceKillTimer);
				this.forceKillTimer = null;
			}
			this.onExitCallback?.(event);
		});
	}

	static spawn({ binary, args = [], cwd, env, cols, rows, onData, onExit }: SpawnPtySessionRequest): PtySession {
		const normalizedArgs = typeof args === "string" ? [args] : args;
		const terminalName = env?.TERM?.trim() || process.env.TERM?.trim() || "xterm-256color";
		const launchEnv: NodeJS.ProcessEnv = env ? { ...process.env, ...env } : process.env;
		const useWindowsShellLaunch = shouldUseWindowsCmdLaunch(binary, process.platform, launchEnv);
		const spawnBinary = useWindowsShellLaunch ? resolveWindowsComSpec(launchEnv) : binary;
		const spawnArgs = useWindowsShellLaunch ? buildWindowsCmdArgsCommandLine(binary, normalizedArgs) : normalizedArgs;
		const ptyOptions: pty.IPtyForkOptions = {
			name: terminalName,
			cwd,
			env,
			cols,
			rows,
			encoding: null,
		};

		const ptyProcess = pty.spawn(spawnBinary, spawnArgs, ptyOptions);
		return new PtySession(ptyProcess, onData, onExit);
	}

	get pid(): number {
		return this.ptyPid;
	}

	write(data: string | Buffer): void {
		try {
			this.ptyProcess.write(typeof data === "string" ? data : data.toString("utf8"));
		} catch (error) {
			if (isIgnorablePtyWriteError(error)) {
				return;
			}
			throw error;
		}
	}

	resize(cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): void {
		if (this.exited) {
			return;
		}
		try {
			if (pixelWidth !== undefined && pixelHeight !== undefined) {
				this.ptyProcess.resize(cols, rows, {
					width: pixelWidth,
					height: pixelHeight,
				});
				return;
			}
			this.ptyProcess.resize(cols, rows);
		} catch (error) {
			if (isIgnorablePtyResizeError(error)) {
				this.exited = true;
				return;
			}
			throw error;
		}
	}

	pause(): void {
		this.ptyProcess.pause();
	}

	resume(): void {
		this.ptyProcess.resume();
	}

	stop(options?: { interrupted?: boolean }): void {
		if (options?.interrupted) {
			this.interrupted = true;
		}
		terminatePtyProcess(this.ptyProcess);
		if (!this.exited && isKillableProcessGroupPid(this.ptyPid) && this.forceKillTimer === null) {
			this.forceKillTimer = setTimeout(() => {
				this.forceKillTimer = null;
				if (!this.exited) {
					killPtyProcessGroup(this.ptyPid, "SIGKILL");
					unregisterPtyProcessGroup(this.ptyPid);
				}
			}, PROCESS_GROUP_KILL_GRACE_MS);
			this.forceKillTimer.unref?.();
		}
	}

	wasInterrupted(): boolean {
		return this.interrupted;
	}
}
