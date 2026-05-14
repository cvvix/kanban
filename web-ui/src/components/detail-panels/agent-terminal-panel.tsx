import "@xterm/xterm/css/xterm.css";

import { Command, Maximize2, MessageSquare, Minimize2, Plus, X } from "lucide-react";
import type { MutableRefObject, ReactElement, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useMemo, useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";
import { usePersistentTerminalSession } from "@/terminal/use-persistent-terminal-session";
import { isMacPlatform } from "@/utils/platform";

interface AgentTerminalSessionControls {
	clearTerminal: () => void;
	containerRef: MutableRefObject<HTMLDivElement | null>;
	isStopping: boolean;
	lastError: string | null;
	stopTerminal: () => Promise<void>;
}

export interface AgentTerminalPanelTab {
	fullTitle: string;
	id: string;
	title: string;
}

export interface AgentTerminalPanelProps {
	taskId: string;
	workspaceId: string | null;
	terminalEnabled?: boolean;
	summary: RuntimeTaskSessionSummary | null;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onCommit?: () => void;
	onOpenPr?: () => void;
	isCommitLoading?: boolean;
	isOpenPrLoading?: boolean;
	taskColumnId?: string;
	onMoveToTrash?: () => void;
	isMoveToTrashLoading?: boolean;
	onCancelAutomaticAction?: () => void;
	cancelAutomaticActionLabel?: string | null;
	showMoveToTrash?: boolean;
	showSessionToolbar?: boolean;
	onClose?: () => void;
	autoFocus?: boolean;
	minimalHeaderTitle?: string;
	minimalHeaderSubtitle?: string | null;
	panelBackgroundColor?: string;
	terminalBackgroundColor?: string;
	cursorColor?: string;
	isVisible?: boolean;
	onConnectionReady?: (taskId: string) => void;
	agentCommand?: string | null;
	onSendAgentCommand?: () => void;
	isExpanded?: boolean;
	onToggleExpand?: () => void;
	terminalTabs?: AgentTerminalPanelTab[];
	activeTerminalTabId?: string | null;
	onSelectTerminalTab?: (tabId: string) => void;
	onAddTerminalTab?: () => void;
	onCloseTerminalTab?: (tabId: string) => void;
}

function describeState(summary: RuntimeTaskSessionSummary | null): string {
	if (!summary) {
		return "No session yet";
	}
	if (summary.state === "running") {
		return "Running";
	}
	if (summary.state === "awaiting_review") {
		return "Ready for review";
	}
	if (summary.state === "interrupted") {
		return "Interrupted";
	}
	if (summary.state === "failed") {
		return "Failed";
	}
	return "Idle";
}

type StatusTagStyle = "neutral" | "success" | "warning" | "danger";

function getStateTagStyle(summary: RuntimeTaskSessionSummary | null): StatusTagStyle {
	if (!summary) {
		return "neutral";
	}
	if (summary.state === "running") {
		return "success";
	}
	if (summary.state === "awaiting_review") {
		return "warning";
	}
	if (summary.state === "interrupted" || summary.state === "failed") {
		return "danger";
	}
	return "neutral";
}

const statusTagColors: Record<StatusTagStyle, string> = {
	neutral: "bg-surface-3 text-text-secondary",
	success: "bg-status-green/15 text-status-green",
	warning: "bg-status-orange/15 text-status-orange",
	danger: "bg-status-red/15 text-status-red",
};

function AgentTerminalReviewActions({
	taskId,
	taskColumnId,
	onCommit,
	onOpenPr,
	isCommitLoading,
	isOpenPrLoading,
}: {
	taskId: string;
	taskColumnId: string;
	onCommit?: () => void;
	onOpenPr?: () => void;
	isCommitLoading: boolean;
	isOpenPrLoading: boolean;
}): ReactElement | null {
	const reviewWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(taskId);
	const showReviewGitActions = taskColumnId === "review" && (reviewWorkspaceSnapshot?.changedFiles ?? 0) > 0;

	if (!showReviewGitActions) {
		return null;
	}

	return (
		<div style={{ display: "flex", gap: 6 }}>
			<Button
				variant="primary"
				size="sm"
				style={{ flex: "1 1 0" }}
				disabled={isCommitLoading || isOpenPrLoading}
				onClick={onCommit}
			>
				{isCommitLoading ? "..." : "Commit"}
			</Button>
			<Button
				variant="primary"
				size="sm"
				style={{ flex: "1 1 0" }}
				disabled={isCommitLoading || isOpenPrLoading}
				onClick={onOpenPr}
			>
				{isOpenPrLoading ? "..." : "Open PR"}
			</Button>
		</div>
	);
}

function AgentTerminalPanelLayout({
	taskId,
	summary,
	onSummary: _onSummary,
	onCommit,
	onOpenPr,
	isCommitLoading = false,
	isOpenPrLoading = false,
	taskColumnId = "in_progress",
	onMoveToTrash,
	isMoveToTrashLoading = false,
	onCancelAutomaticAction,
	cancelAutomaticActionLabel,
	showMoveToTrash,
	showSessionToolbar = true,
	onClose,
	autoFocus: _autoFocus = false,
	minimalHeaderTitle = "Terminal",
	minimalHeaderSubtitle = null,
	panelBackgroundColor = "var(--color-surface-1)",
	terminalBackgroundColor = "var(--color-surface-1)",
	cursorColor: _cursorColor = "var(--color-text-primary)",
	isVisible: _isVisible = true,
	onConnectionReady: _onConnectionReady,
	agentCommand,
	onSendAgentCommand,
	isExpanded = false,
	onToggleExpand,
	terminalTabs = [],
	activeTerminalTabId = null,
	onSelectTerminalTab,
	onAddTerminalTab,
	onCloseTerminalTab,
	sessionControls,
}: AgentTerminalPanelProps & { sessionControls: AgentTerminalSessionControls }): ReactElement {
	const { containerRef, lastError, isStopping, clearTerminal, stopTerminal } = sessionControls;
	const tabListRef = useRef<HTMLDivElement | null>(null);
	const canStop = summary?.state === "running" || summary?.state === "awaiting_review";
	const statusLabel = useMemo(() => describeState(summary), [summary]);
	const statusTagStyle = useMemo(() => getStateTagStyle(summary), [summary]);
	const agentLabel = useMemo(() => {
		const normalizedCommand = agentCommand?.trim();
		if (!normalizedCommand) {
			return null;
		}
		return normalizedCommand.split(/\s+/)[0] ?? null;
	}, [agentCommand]);
	const hasTerminalTabs = terminalTabs.length > 0;
	const handleTerminalTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, tabId: string) => {
		if (event.key !== "Enter" && event.key !== " ") {
			return;
		}
		event.preventDefault();
		onSelectTerminalTab?.(tabId);
	};
	const handleTerminalPanelKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const isAddTerminalShortcut =
			event.metaKey &&
			!event.ctrlKey &&
			!event.altKey &&
			!event.shiftKey &&
			(event.key === "\\" || event.code === "Backslash");

		if (!isAddTerminalShortcut || !onAddTerminalTab) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		onAddTerminalTab();
	};

	useEffect(() => {
		if (!activeTerminalTabId) {
			return;
		}
		const activeTab = tabListRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
		activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [activeTerminalTabId]);

	return (
		<div
			onKeyDownCapture={handleTerminalPanelKeyDownCapture}
			style={{
				display: "flex",
				flex: "1 1 0",
				flexDirection: "column",
				minWidth: 0,
				minHeight: 0,
				background: panelBackgroundColor,
			}}
		>
			{showSessionToolbar ? (
				<>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 8,
							padding: "8px 12px",
						}}
					>
						<div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
							<span
								className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${statusTagColors[statusTagStyle]}`}
							>
								{statusLabel}
							</span>
						</div>
						<div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
							<Button variant="default" size="sm" onClick={clearTerminal}>
								Clear
							</Button>
							<Button
								variant="default"
								size="sm"
								onClick={() => {
									void stopTerminal();
								}}
								disabled={!canStop || isStopping}
							>
								Stop
							</Button>
						</div>
					</div>
					<div className="h-px bg-border" />
				</>
			) : onClose ? (
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 8,
						padding: "6px 0 0 3px",
					}}
				>
					<div className="flex min-w-0 flex-1 items-center gap-1">
						{hasTerminalTabs ? (
							<>
								<div
									ref={tabListRef}
									role="tablist"
									aria-label="Terminal tabs"
									className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5"
								>
									{terminalTabs.map((tab) => {
										const isActive = tab.id === activeTerminalTabId;
										return (
											<div
												key={tab.id}
												role="tab"
												aria-selected={isActive}
												tabIndex={0}
												title={tab.fullTitle}
												onClick={() => onSelectTerminalTab?.(tab.id)}
												onKeyDown={(event) => handleTerminalTabKeyDown(event, tab.id)}
												className={cn(
													"group/tab flex h-7 min-w-[120px] max-w-[180px] shrink-0 cursor-default items-center rounded-md border px-2 text-left text-xs",
													"focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
													isActive
														? "border-border-bright bg-surface-2 text-text-primary"
														: "border-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary",
												)}
											>
												<span className="min-w-0 flex-1 truncate">{tab.title}</span>
												{onCloseTerminalTab ? (
													<button
														type="button"
														aria-label={`Close ${tab.title}`}
														onClick={(event) => {
															event.preventDefault();
															event.stopPropagation();
															onCloseTerminalTab(tab.id);
														}}
														className="ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-text-tertiary opacity-0 transition-opacity hover:bg-surface-3 hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent group-hover/tab:opacity-100"
													>
														<X size={12} />
													</button>
												) : null}
											</div>
										);
									})}
								</div>
								{onAddTerminalTab ? (
									<Tooltip side="top" content="New terminal">
										<Button
											icon={<Plus size={12} />}
											variant="ghost"
											size="sm"
											onClick={onAddTerminalTab}
											aria-label="New terminal"
											aria-keyshortcuts="Meta+Backslash"
										/>
									</Tooltip>
								) : null}
							</>
						) : (
							<>
								<span className="text-text-secondary" style={{ fontSize: 12 }}>
									{minimalHeaderTitle}
								</span>
								{minimalHeaderSubtitle ? (
									<span
										className="truncate font-mono text-text-secondary"
										style={{ fontSize: 10 }}
										title={minimalHeaderSubtitle}
									>
										{minimalHeaderSubtitle}
									</span>
								) : null}
							</>
						)}
					</div>
					<div style={{ display: "flex", alignItems: "center", gap: 2, marginRight: "-6px" }}>
						{agentLabel && onSendAgentCommand ? (
							<Tooltip side="top" content={`Run ${agentLabel}`}>
								<Button
									icon={<MessageSquare size={12} />}
									variant="ghost"
									size="sm"
									onClick={onSendAgentCommand}
									aria-label={`Run ${agentLabel}`}
								/>
							</Tooltip>
						) : null}
						{onToggleExpand ? (
							<Tooltip
								side="top"
								content={
									<span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
										<span>{isExpanded ? "Collapse" : "Expand"}</span>
										<span
											style={{ display: "inline-flex", alignItems: "center", gap: 2, whiteSpace: "nowrap" }}
										>
											<span>(</span>
											{isMacPlatform ? <Command size={11} /> : <span style={{ fontSize: 11 }}>Ctrl</span>}
											<span>+ M)</span>
										</span>
									</span>
								}
							>
								<Button
									icon={isExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
									variant="ghost"
									size="sm"
									onClick={onToggleExpand}
									aria-label={isExpanded ? "Collapse terminal" : "Expand terminal"}
								/>
							</Tooltip>
						) : null}
						<Button
							icon={<X size={14} />}
							variant="ghost"
							size="sm"
							onClick={onClose}
							aria-label="Close terminal"
						/>
					</div>
				</div>
			) : null}
			<div style={{ flex: "1 1 0", minHeight: 0, overflow: "hidden", padding: "3px 1.5px 3px 3px" }}>
				<div
					ref={containerRef}
					className="kb-terminal-container"
					style={{ height: "100%", width: "100%", background: terminalBackgroundColor }}
				/>
			</div>
			{lastError ? (
				<div className="flex gap-2 rounded-none border-t border-status-red/30 bg-status-red/10 p-3 text-[13px] text-status-red">
					{lastError}
				</div>
			) : null}
			{showMoveToTrash && onMoveToTrash ? (
				<div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 12px" }}>
					<AgentTerminalReviewActions
						taskId={taskId}
						taskColumnId={taskColumnId}
						onCommit={onCommit}
						onOpenPr={onOpenPr}
						isCommitLoading={isCommitLoading}
						isOpenPrLoading={isOpenPrLoading}
					/>
					{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
						<Button variant="default" fill onClick={onCancelAutomaticAction}>
							{cancelAutomaticActionLabel}
						</Button>
					) : null}
					<Button variant="danger" fill disabled={isMoveToTrashLoading} onClick={onMoveToTrash}>
						{isMoveToTrashLoading ? <Spinner size={14} /> : "Move Card To Done"}
					</Button>
				</div>
			) : null}
		</div>
	);
}

export function AgentTerminalPanel(props: AgentTerminalPanelProps): ReactElement {
	// enabled gates whether this panel should keep a live persistent terminal connection.
	// We disable it for non-active task contexts so backlog and trash views do not keep extra websocket sockets open.
	const sessionControls = usePersistentTerminalSession({
		taskId: props.taskId,
		workspaceId: props.workspaceId,
		enabled: props.terminalEnabled ?? true,
		onSummary: props.onSummary,
		onConnectionReady: props.onConnectionReady,
		autoFocus: props.autoFocus,
		isVisible: props.isVisible,
		sessionStartedAt: props.summary?.startedAt ?? null,
		terminalBackgroundColor: props.terminalBackgroundColor ?? "var(--color-surface-1)",
		cursorColor: props.cursorColor ?? "var(--color-text-primary)",
	});

	return <AgentTerminalPanelLayout {...props} sessionControls={sessionControls} />;
}
