import { useCallback, useEffect, useRef, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import {
	clampAtLeast,
	readOptionalPersistedResizeNumber,
	writePersistedResizeNumber,
} from "@/resize/resize-persistence";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	LocalStorageKey,
	readLocalStorageItem,
	removeLocalStorageItem,
	writeLocalStorageItem,
} from "@/storage/local-storage-store";
import { disposePersistentTerminal } from "@/terminal/persistent-terminal-manager";
import { getTerminalGeometry, prepareWaitForTerminalGeometry } from "@/terminal/terminal-geometry-registry";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardCard, CardSelection } from "@/types";

const HOME_TERMINAL_TASK_ID = "__home_terminal__";
const HOME_TERMINAL_ROWS = 16;
const DETAIL_TERMINAL_TASK_PREFIX = "__detail_terminal__:";
const APPROX_TERMINAL_CELL_WIDTH_PX = 8;
const MIN_TERMINAL_COLS = 40;
const MIN_BOTTOM_TERMINAL_PANE_HEIGHT = 200;
const EXPANDED_TERMINAL_PANE_HEIGHT = 99999;

function estimateShellTerminalCols(): number {
	if (typeof window === "undefined") {
		return 120;
	}
	return Math.max(MIN_TERMINAL_COLS, Math.floor(Math.max(0, window.innerWidth - 96) / APPROX_TERMINAL_CELL_WIDTH_PX));
}

function loadBottomTerminalPaneHeight(): number | undefined {
	return readOptionalPersistedResizeNumber({
		key: LocalStorageKey.BottomTerminalPaneHeight,
		normalize: (value) => clampAtLeast(value, MIN_BOTTOM_TERMINAL_PANE_HEIGHT),
	});
}

export function getDetailTerminalTaskId(taskId: string): string {
	return `${DETAIL_TERMINAL_TASK_PREFIX}${taskId}`;
}

function getHomeTerminalTaskId(ordinal: number): string {
	return ordinal === 1 ? HOME_TERMINAL_TASK_ID : `${HOME_TERMINAL_TASK_ID}:${ordinal}`;
}

function getDetailTerminalTabTaskId(taskId: string, ordinal: number): string {
	return ordinal === 1 ? getDetailTerminalTaskId(taskId) : `${getDetailTerminalTaskId(taskId)}:${ordinal}`;
}

function getNextTerminalTabOrdinal(tabs: TerminalPanelTab[]): number {
	return Math.max(0, ...tabs.map((tab) => tab.ordinal)) + 1;
}

function getNextActiveTerminalTabId(
	tabs: TerminalPanelTab[],
	closedTaskId: string,
	currentActiveTaskId: string,
): string | null {
	if (currentActiveTaskId !== closedTaskId) {
		return currentActiveTaskId;
	}
	const closedIndex = tabs.findIndex((tab) => tab.taskId === closedTaskId);
	const remainingTabs = tabs.filter((tab) => tab.taskId !== closedTaskId);
	if (remainingTabs.length === 0) {
		return null;
	}
	return remainingTabs[Math.min(Math.max(0, closedIndex), remainingTabs.length - 1)]?.taskId ?? null;
}

function createHomeTerminalTab(ordinal: number): TerminalPanelTab {
	return {
		taskId: getHomeTerminalTaskId(ordinal),
		ordinal,
	};
}

function createDetailTerminalTab(taskId: string, ordinal: number): TerminalPanelTab {
	return {
		taskId: getDetailTerminalTabTaskId(taskId, ordinal),
		ordinal,
	};
}

function createDefaultDetailTerminalPanelState(taskId: string): DetailTerminalPanelState {
	const tab = createDetailTerminalTab(taskId, 1);
	return {
		isExpanded: false,
		isOpen: false,
		activeTaskId: tab.taskId,
		tabs: [tab],
	};
}

function createDefaultHomeTerminalPanelState(): HomeTerminalPanelState {
	const tab = createHomeTerminalTab(1);
	return {
		isExpanded: false,
		isOpen: false,
		activeTaskId: tab.taskId,
		nextOrdinal: 2,
		tabs: [tab],
	};
}

function createDefaultProjectTerminalPanelsState(): ProjectTerminalPanelsState {
	return {
		detailByCardId: {},
		home: createDefaultHomeTerminalPanelState(),
	};
}

function createDetailTerminalSelectionKey(card: BoardCard, terminalTaskId: string): string {
	return `${card.id}:${card.baseRef}:${terminalTaskId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBoolean(value: unknown): boolean {
	return typeof value === "boolean" ? value : false;
}

function normalizeHomeTerminalTabs(value: unknown): TerminalPanelTab[] {
	if (!Array.isArray(value)) {
		return [createHomeTerminalTab(1)];
	}
	const tabs = value
		.map((item) => {
			const ordinal = isRecord(item) ? Number(item.ordinal) : 0;
			if (!Number.isInteger(ordinal) || ordinal < 1) {
				return null;
			}
			const expectedTaskId = getHomeTerminalTaskId(ordinal);
			return item.taskId === expectedTaskId ? { taskId: expectedTaskId, ordinal } : null;
		})
		.filter((tab): tab is TerminalPanelTab => tab !== null);
	return tabs.length > 0 ? tabs : [createHomeTerminalTab(1)];
}

function normalizeDetailTerminalTabs(cardId: string, value: unknown): TerminalPanelTab[] {
	if (!Array.isArray(value)) {
		return [createDetailTerminalTab(cardId, 1)];
	}
	const tabs = value
		.map((item) => {
			const ordinal = isRecord(item) ? Number(item.ordinal) : 0;
			if (!Number.isInteger(ordinal) || ordinal < 1) {
				return null;
			}
			const expectedTaskId = getDetailTerminalTabTaskId(cardId, ordinal);
			return item.taskId === expectedTaskId ? { taskId: expectedTaskId, ordinal } : null;
		})
		.filter((tab): tab is TerminalPanelTab => tab !== null);
	return tabs.length > 0 ? tabs : [createDetailTerminalTab(cardId, 1)];
}

function normalizeHomeTerminalPanelState(value: unknown): HomeTerminalPanelState {
	if (!isRecord(value)) {
		return createDefaultHomeTerminalPanelState();
	}
	const tabs = normalizeHomeTerminalTabs(value.tabs);
	const activeTaskId =
		typeof value.activeTaskId === "string" && tabs.some((tab) => tab.taskId === value.activeTaskId)
			? value.activeTaskId
			: (tabs[0]?.taskId ?? HOME_TERMINAL_TASK_ID);
	const persistedNextOrdinal = Number(value.nextOrdinal);
	const nextOrdinal =
		Number.isInteger(persistedNextOrdinal) && persistedNextOrdinal > 1
			? Math.max(persistedNextOrdinal, getNextTerminalTabOrdinal(tabs))
			: getNextTerminalTabOrdinal(tabs);
	return {
		activeTaskId,
		isExpanded: normalizeBoolean(value.isExpanded),
		isOpen: normalizeBoolean(value.isOpen),
		nextOrdinal,
		tabs,
	};
}

function normalizeDetailTerminalPanelState(cardId: string, value: unknown): DetailTerminalPanelState {
	if (!isRecord(value)) {
		return createDefaultDetailTerminalPanelState(cardId);
	}
	const tabs = normalizeDetailTerminalTabs(cardId, value.tabs);
	const activeTaskId =
		typeof value.activeTaskId === "string" && tabs.some((tab) => tab.taskId === value.activeTaskId)
			? value.activeTaskId
			: (tabs[0]?.taskId ?? getDetailTerminalTaskId(cardId));
	return {
		activeTaskId,
		isExpanded: normalizeBoolean(value.isExpanded),
		isOpen: normalizeBoolean(value.isOpen),
		tabs,
	};
}

function normalizeProjectTerminalPanelsState(value: unknown): ProjectTerminalPanelsState {
	if (!isRecord(value)) {
		return createDefaultProjectTerminalPanelsState();
	}
	const detailByCardId: Record<string, DetailTerminalPanelState> = {};
	if (isRecord(value.detailByCardId)) {
		for (const [cardId, panelState] of Object.entries(value.detailByCardId)) {
			detailByCardId[cardId] = normalizeDetailTerminalPanelState(cardId, panelState);
		}
	}
	return {
		detailByCardId,
		home: normalizeHomeTerminalPanelState(value.home),
	};
}

function readPersistedTerminalPanelsState(): Record<string, ProjectTerminalPanelsState> {
	const raw = readLocalStorageItem(LocalStorageKey.TerminalPanelsState);
	if (!raw) {
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.projects)) {
			return {};
		}
		const projects: Record<string, ProjectTerminalPanelsState> = {};
		for (const [projectId, projectState] of Object.entries(parsed.projects)) {
			projects[projectId] = normalizeProjectTerminalPanelsState(projectState);
		}
		return projects;
	} catch {
		return {};
	}
}

function readProjectTerminalPanelsState(projectId: string | null): ProjectTerminalPanelsState {
	if (!projectId) {
		return createDefaultProjectTerminalPanelsState();
	}
	return readPersistedTerminalPanelsState()[projectId] ?? createDefaultProjectTerminalPanelsState();
}

function writeProjectTerminalPanelsState(projectId: string, state: ProjectTerminalPanelsState): void {
	const projects = readPersistedTerminalPanelsState();
	projects[projectId] = normalizeProjectTerminalPanelsState(state);
	writeLocalStorageItem(
		LocalStorageKey.TerminalPanelsState,
		JSON.stringify({
			version: 1,
			projects,
		}),
	);
}

async function resolveShellTerminalGeometry(taskId: string): Promise<{ cols: number; rows: number }> {
	const existingGeometry = getTerminalGeometry(taskId);
	if (existingGeometry) {
		return existingGeometry;
	}
	await prepareWaitForTerminalGeometry(taskId)();
	return (
		getTerminalGeometry(taskId) ?? {
			cols: estimateShellTerminalCols(),
			rows: HOME_TERMINAL_ROWS,
		}
	);
}

interface StartDetailTerminalOptions {
	showLoading?: boolean;
	taskId?: string;
}

interface UseTerminalPanelsInput {
	currentProjectId: string | null;
	selectedCard: CardSelection | null;
	workspaceGit: RuntimeGitRepositoryInfo | null;
	agentCommand: string | null;
	upsertSession: (summary: RuntimeTaskSessionSummary) => void;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options?: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
	stopTaskSession: (taskId: string) => Promise<void>;
}

interface PrepareTerminalForShortcutInput {
	prepareWaitForTerminalConnectionReady: (taskId: string) => () => Promise<void>;
}

interface PrepareTerminalForShortcutResult {
	hadExistingOpenTerminal?: boolean;
	ok: boolean;
	targetTaskId?: string;
	message?: string;
}

interface DetailTerminalPanelState {
	activeTaskId: string;
	isExpanded: boolean;
	isOpen: boolean;
	tabs: TerminalPanelTab[];
}

interface HomeTerminalPanelState {
	activeTaskId: string;
	isExpanded: boolean;
	isOpen: boolean;
	nextOrdinal: number;
	tabs: TerminalPanelTab[];
}

interface ProjectTerminalPanelsState {
	detailByCardId: Record<string, DetailTerminalPanelState>;
	home: HomeTerminalPanelState;
}

export interface TerminalPanelTab {
	taskId: string;
	ordinal: number;
}

export interface UseTerminalPanelsResult {
	homeTerminalTaskId: string;
	homeTerminalTabs: TerminalPanelTab[];
	isHomeTerminalOpen: boolean;
	isHomeTerminalStarting: boolean;
	homeTerminalShellBinary: string | null;
	homeTerminalPaneHeight: number | undefined;
	isDetailTerminalOpen: boolean;
	detailTerminalTaskId: string | null;
	detailTerminalTabs: TerminalPanelTab[];
	isDetailTerminalStarting: boolean;
	detailTerminalPaneHeight: number | undefined;
	isHomeTerminalExpanded: boolean;
	isDetailTerminalExpanded: boolean;
	setHomeTerminalPaneHeight: (height: number | undefined) => void;
	setDetailTerminalPaneHeight: (height: number | undefined) => void;
	handleToggleExpandHomeTerminal: () => void;
	handleToggleExpandDetailTerminal: () => void;
	handleToggleHomeTerminal: () => void;
	handleToggleDetailTerminal: () => void;
	handleSelectHomeTerminalTab: (taskId: string) => void;
	handleSelectDetailTerminalTab: (taskId: string) => void;
	handleAddHomeTerminalTab: () => void;
	handleAddDetailTerminalTab: () => void;
	handleCloseHomeTerminalTab: (taskId: string) => void;
	handleCloseDetailTerminalTab: (taskId: string) => void;
	handleSendAgentCommandToHomeTerminal: () => void;
	handleSendAgentCommandToDetailTerminal: () => void;
	prepareTerminalForShortcut: (input: PrepareTerminalForShortcutInput) => Promise<PrepareTerminalForShortcutResult>;
	resetBottomTerminalLayoutCustomizations: () => void;
	collapseHomeTerminal: () => void;
	collapseDetailTerminal: () => void;
	closeHomeTerminal: () => void;
	closeDetailTerminal: () => void;
	resetTerminalPanelsState: () => void;
}

export function useTerminalPanels({
	currentProjectId,
	selectedCard,
	workspaceGit,
	agentCommand,
	upsertSession,
	sendTaskSessionInput,
	stopTaskSession,
}: UseTerminalPanelsInput): UseTerminalPanelsResult {
	const initialProjectTerminalPanelsStateRef = useRef<{
		projectId: string | null;
		state: ProjectTerminalPanelsState;
	} | null>(null);
	if (initialProjectTerminalPanelsStateRef.current === null) {
		initialProjectTerminalPanelsStateRef.current = {
			projectId: currentProjectId,
			state: readProjectTerminalPanelsState(currentProjectId),
		};
	}
	const initialProjectTerminalPanelsState = initialProjectTerminalPanelsStateRef.current.state;
	const homeTerminalProjectIdRef = useRef<string | null>(null);
	const detailTerminalSelectionKeyRef = useRef<string | null>(null);
	const hydratedTerminalPanelsProjectIdRef = useRef(initialProjectTerminalPanelsStateRef.current.projectId);
	const nextHomeTerminalTabOrdinalRef = useRef(initialProjectTerminalPanelsState.home.nextOrdinal);
	const [isHomeTerminalOpen, setIsHomeTerminalOpen] = useState(initialProjectTerminalPanelsState.home.isOpen);
	const [isHomeTerminalStarting, setIsHomeTerminalStarting] = useState(false);
	const [homeTerminalShellBinary, setHomeTerminalShellBinary] = useState<string | null>(null);
	const [homeTerminalTabs, setHomeTerminalTabs] = useState<TerminalPanelTab[]>(
		initialProjectTerminalPanelsState.home.tabs,
	);
	const [activeHomeTerminalTaskId, setActiveHomeTerminalTaskId] = useState(
		initialProjectTerminalPanelsState.home.activeTaskId,
	);
	const [lastBottomTerminalPaneHeight, setLastBottomTerminalPaneHeight] = useState<number | undefined>(
		loadBottomTerminalPaneHeight,
	);
	const [detailTerminalPanelStateByCardId, setDetailTerminalPanelStateByCardId] = useState<
		Record<string, DetailTerminalPanelState>
	>(initialProjectTerminalPanelsState.detailByCardId);
	const [isDetailTerminalStarting, setIsDetailTerminalStarting] = useState(false);
	const [isHomeTerminalExpanded, setIsHomeTerminalExpanded] = useState(
		initialProjectTerminalPanelsState.home.isExpanded,
	);
	const homeTerminalTaskId =
		homeTerminalTabs.find((tab) => tab.taskId === activeHomeTerminalTaskId)?.taskId ?? HOME_TERMINAL_TASK_ID;
	const selectedCardId = selectedCard?.card.id ?? null;
	const currentDetailTerminalPanelState = selectedCardId
		? (detailTerminalPanelStateByCardId[selectedCardId] ?? createDefaultDetailTerminalPanelState(selectedCardId))
		: null;
	const detailTerminalTaskId = currentDetailTerminalPanelState?.activeTaskId ?? null;
	const detailTerminalTabs = currentDetailTerminalPanelState?.tabs ?? [];
	const isDetailTerminalOpen = currentDetailTerminalPanelState?.isOpen ?? false;
	const isDetailTerminalExpanded = currentDetailTerminalPanelState?.isExpanded ?? false;
	const homeTerminalPaneHeight = isHomeTerminalExpanded ? EXPANDED_TERMINAL_PANE_HEIGHT : lastBottomTerminalPaneHeight;
	const detailTerminalPaneHeight = isDetailTerminalExpanded
		? EXPANDED_TERMINAL_PANE_HEIGHT
		: lastBottomTerminalPaneHeight;

	const updateDetailTerminalPanelState = useCallback(
		(cardId: string, updater: (previous: DetailTerminalPanelState) => DetailTerminalPanelState) => {
			setDetailTerminalPanelStateByCardId((previous) => ({
				...previous,
				[cardId]: updater(previous[cardId] ?? createDefaultDetailTerminalPanelState(cardId)),
			}));
		},
		[],
	);

	const stopTerminalTabSession = useCallback(
		(taskId: string) => {
			void stopTaskSession(taskId);
			if (currentProjectId) {
				disposePersistentTerminal(currentProjectId, taskId);
			}
		},
		[currentProjectId, stopTaskSession],
	);

	const applyProjectTerminalPanelsState = useCallback(
		(projectId: string | null, state: ProjectTerminalPanelsState) => {
			hydratedTerminalPanelsProjectIdRef.current = projectId;
			setIsHomeTerminalOpen(state.home.isOpen);
			setIsHomeTerminalExpanded(state.home.isExpanded);
			setHomeTerminalTabs(state.home.tabs);
			setActiveHomeTerminalTaskId(state.home.activeTaskId);
			nextHomeTerminalTabOrdinalRef.current = state.home.nextOrdinal;
			setDetailTerminalPanelStateByCardId(state.detailByCardId);
			detailTerminalSelectionKeyRef.current = null;
		},
		[],
	);

	useEffect(() => {
		if (!currentProjectId || hydratedTerminalPanelsProjectIdRef.current !== currentProjectId) {
			return;
		}
		writeProjectTerminalPanelsState(currentProjectId, {
			detailByCardId: detailTerminalPanelStateByCardId,
			home: {
				activeTaskId: activeHomeTerminalTaskId,
				isExpanded: isHomeTerminalExpanded,
				isOpen: isHomeTerminalOpen,
				nextOrdinal: nextHomeTerminalTabOrdinalRef.current,
				tabs: homeTerminalTabs,
			},
		});
	}, [
		activeHomeTerminalTaskId,
		currentProjectId,
		detailTerminalPanelStateByCardId,
		homeTerminalTabs,
		isHomeTerminalExpanded,
		isHomeTerminalOpen,
	]);

	const persistBottomTerminalPaneHeight = useCallback((height: number | undefined) => {
		if (typeof height !== "number" || !Number.isFinite(height)) {
			return;
		}
		const normalizedHeight = writePersistedResizeNumber({
			key: LocalStorageKey.BottomTerminalPaneHeight,
			value: height,
			normalize: (value) => clampAtLeast(value, MIN_BOTTOM_TERMINAL_PANE_HEIGHT),
		});
		setLastBottomTerminalPaneHeight(normalizedHeight);
	}, []);

	const resetBottomTerminalPaneHeight = useCallback(() => {
		setLastBottomTerminalPaneHeight(undefined);
		removeLocalStorageItem(LocalStorageKey.BottomTerminalPaneHeight);
	}, []);

	const resetBottomTerminalLayoutCustomizations = useCallback(() => {
		resetBottomTerminalPaneHeight();
		setIsHomeTerminalExpanded(false);
		setDetailTerminalPanelStateByCardId((previous) =>
			Object.fromEntries(
				Object.entries(previous).map(([cardId, panelState]) => [
					cardId,
					{
						...panelState,
						isExpanded: false,
					},
				]),
			),
		);
	}, [resetBottomTerminalPaneHeight]);

	const closeHomeTerminal = useCallback(() => {
		setIsHomeTerminalOpen(false);
		setIsHomeTerminalExpanded(false);
		homeTerminalProjectIdRef.current = null;
	}, []);

	const closeDetailTerminal = useCallback(() => {
		if (selectedCardId) {
			updateDetailTerminalPanelState(selectedCardId, (previous) => ({
				...previous,
				isExpanded: false,
				isOpen: false,
			}));
		}
		detailTerminalSelectionKeyRef.current = null;
	}, [selectedCardId, updateDetailTerminalPanelState]);

	const collapseHomeTerminal = useCallback(() => {
		resetBottomTerminalPaneHeight();
		closeHomeTerminal();
	}, [closeHomeTerminal, resetBottomTerminalPaneHeight]);

	const collapseDetailTerminal = useCallback(() => {
		resetBottomTerminalPaneHeight();
		closeDetailTerminal();
	}, [closeDetailTerminal, resetBottomTerminalPaneHeight]);

	const setHomeTerminalPaneHeight = useCallback(
		(height: number | undefined) => {
			if (isHomeTerminalExpanded) {
				return;
			}
			persistBottomTerminalPaneHeight(height);
		},
		[isHomeTerminalExpanded, persistBottomTerminalPaneHeight],
	);

	const setDetailTerminalPaneHeight = useCallback(
		(height: number | undefined) => {
			if (isDetailTerminalExpanded) {
				return;
			}
			persistBottomTerminalPaneHeight(height);
		},
		[isDetailTerminalExpanded, persistBottomTerminalPaneHeight],
	);

	const handleToggleExpandHomeTerminal = useCallback(() => {
		setIsHomeTerminalExpanded((previous) => !previous);
	}, []);

	const handleToggleExpandDetailTerminal = useCallback(() => {
		if (!selectedCardId) {
			return;
		}
		updateDetailTerminalPanelState(selectedCardId, (previous) => ({
			...previous,
			isExpanded: !previous.isExpanded,
		}));
	}, [selectedCardId, updateDetailTerminalPanelState]);

	const startHomeTerminalSession = useCallback(
		async (taskId: string): Promise<boolean> => {
			if (!currentProjectId) {
				return false;
			}
			setIsHomeTerminalStarting(true);
			try {
				const geometry = await resolveShellTerminalGeometry(taskId);
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.runtime.startShellSession.mutate({
					taskId,
					cols: geometry.cols,
					rows: geometry.rows,
					baseRef: workspaceGit?.currentBranch ?? workspaceGit?.defaultBranch ?? "HEAD",
				});
				if (!payload.ok || !payload.summary) {
					throw new Error(payload.error ?? "Could not start terminal session.");
				}
				upsertSession(payload.summary);
				setHomeTerminalShellBinary(
					typeof payload.shellBinary === "string" && payload.shellBinary.trim() ? payload.shellBinary : null,
				);
				return true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notifyError(message);
				return false;
			} finally {
				setIsHomeTerminalStarting(false);
			}
		},
		[currentProjectId, upsertSession, workspaceGit?.currentBranch, workspaceGit?.defaultBranch],
	);

	const handleToggleHomeTerminal = useCallback(() => {
		if (isHomeTerminalOpen) {
			closeHomeTerminal();
			return;
		}
		if (!currentProjectId) {
			return;
		}
		homeTerminalProjectIdRef.current = currentProjectId;
		setIsHomeTerminalOpen(true);
		void startHomeTerminalSession(homeTerminalTaskId);
	}, [closeHomeTerminal, currentProjectId, homeTerminalTaskId, isHomeTerminalOpen, startHomeTerminalSession]);

	const startDetailTerminalForCard = useCallback(
		async (card: BoardCard, options?: StartDetailTerminalOptions): Promise<boolean> => {
			if (!currentProjectId) {
				return false;
			}
			const showLoading = options?.showLoading ?? false;
			if (showLoading) {
				setIsDetailTerminalStarting(true);
			}
			try {
				const targetTaskId = options?.taskId ?? getDetailTerminalTaskId(card.id);
				const geometry = await resolveShellTerminalGeometry(targetTaskId);
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.runtime.startShellSession.mutate({
					taskId: targetTaskId,
					cols: geometry.cols,
					rows: geometry.rows,
					workspaceTaskId: card.id,
					baseRef: card.baseRef,
				});
				if (!payload.ok || !payload.summary) {
					throw new Error(payload.error ?? "Could not start detail terminal session.");
				}
				upsertSession(payload.summary);
				return true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notifyError(message);
				return false;
			} finally {
				if (showLoading) {
					setIsDetailTerminalStarting(false);
				}
			}
		},
		[currentProjectId, upsertSession],
	);

	const handleToggleDetailTerminal = useCallback(() => {
		if (!selectedCard || !detailTerminalTaskId) {
			return;
		}
		if (isDetailTerminalOpen) {
			closeDetailTerminal();
			return;
		}
		updateDetailTerminalPanelState(selectedCard.card.id, (previous) => ({
			...previous,
			isOpen: true,
		}));
		void (async () => {
			const selectionKey = createDetailTerminalSelectionKey(selectedCard.card, detailTerminalTaskId);
			detailTerminalSelectionKeyRef.current = selectionKey;
			const started = await startDetailTerminalForCard(selectedCard.card, {
				showLoading: true,
				taskId: detailTerminalTaskId,
			});
			if (!started && detailTerminalSelectionKeyRef.current === selectionKey) {
				detailTerminalSelectionKeyRef.current = null;
			}
		})();
	}, [
		closeDetailTerminal,
		detailTerminalTaskId,
		isDetailTerminalOpen,
		selectedCard,
		startDetailTerminalForCard,
		updateDetailTerminalPanelState,
	]);

	useEffect(() => {
		if (!isDetailTerminalOpen || !selectedCard || !detailTerminalTaskId) {
			detailTerminalSelectionKeyRef.current = null;
			return;
		}
		const selectionKey = createDetailTerminalSelectionKey(selectedCard.card, detailTerminalTaskId);
		if (detailTerminalSelectionKeyRef.current === selectionKey) {
			return;
		}
		detailTerminalSelectionKeyRef.current = selectionKey;
		void startDetailTerminalForCard(selectedCard.card, { taskId: detailTerminalTaskId });
	}, [
		detailTerminalTaskId,
		isDetailTerminalOpen,
		selectedCard?.card.baseRef,
		selectedCard?.card.id,
		startDetailTerminalForCard,
	]);

	useEffect(() => {
		if (!isHomeTerminalOpen) {
			homeTerminalProjectIdRef.current = null;
			return;
		}
		if (!currentProjectId || homeTerminalProjectIdRef.current === currentProjectId) {
			return;
		}
		homeTerminalProjectIdRef.current = currentProjectId;
		void (async () => {
			const started = await startHomeTerminalSession(homeTerminalTaskId);
			if (!started) {
				closeHomeTerminal();
			}
		})();
	}, [closeHomeTerminal, currentProjectId, homeTerminalTaskId, isHomeTerminalOpen, startHomeTerminalSession]);

	const handleSelectHomeTerminalTab = useCallback(
		(taskId: string) => {
			if (!homeTerminalTabs.some((tab) => tab.taskId === taskId)) {
				return;
			}
			setActiveHomeTerminalTaskId(taskId);
			if (!currentProjectId) {
				return;
			}
			homeTerminalProjectIdRef.current = currentProjectId;
			setIsHomeTerminalOpen(true);
			void startHomeTerminalSession(taskId);
		},
		[currentProjectId, homeTerminalTabs, startHomeTerminalSession],
	);

	const handleAddHomeTerminalTab = useCallback(() => {
		if (!currentProjectId) {
			return;
		}
		const tab = createHomeTerminalTab(nextHomeTerminalTabOrdinalRef.current);
		nextHomeTerminalTabOrdinalRef.current += 1;
		setHomeTerminalTabs((previous) => [...previous, tab]);
		setActiveHomeTerminalTaskId(tab.taskId);
		homeTerminalProjectIdRef.current = currentProjectId;
		setIsHomeTerminalOpen(true);
		void startHomeTerminalSession(tab.taskId);
	}, [currentProjectId, startHomeTerminalSession]);

	const handleCloseHomeTerminalTab = useCallback(
		(taskId: string) => {
			if (!homeTerminalTabs.some((tab) => tab.taskId === taskId)) {
				return;
			}
			stopTerminalTabSession(taskId);
			const remainingTabs = homeTerminalTabs.filter((tab) => tab.taskId !== taskId);
			if (remainingTabs.length === 0) {
				closeHomeTerminal();
				setHomeTerminalTabs([createHomeTerminalTab(1)]);
				setActiveHomeTerminalTaskId(HOME_TERMINAL_TASK_ID);
				nextHomeTerminalTabOrdinalRef.current = 2;
				return;
			}
			const nextActiveTaskId = getNextActiveTerminalTabId(homeTerminalTabs, taskId, activeHomeTerminalTaskId);
			setHomeTerminalTabs(remainingTabs);
			if (activeHomeTerminalTaskId !== taskId || !nextActiveTaskId) {
				return;
			}
			setActiveHomeTerminalTaskId(nextActiveTaskId);
			if (!currentProjectId || !isHomeTerminalOpen) {
				return;
			}
			homeTerminalProjectIdRef.current = currentProjectId;
			void startHomeTerminalSession(nextActiveTaskId);
		},
		[
			activeHomeTerminalTaskId,
			closeHomeTerminal,
			currentProjectId,
			homeTerminalTabs,
			isHomeTerminalOpen,
			startHomeTerminalSession,
			stopTerminalTabSession,
		],
	);

	const handleSelectDetailTerminalTab = useCallback(
		(taskId: string) => {
			if (!selectedCard) {
				return;
			}
			const panelState =
				detailTerminalPanelStateByCardId[selectedCard.card.id] ??
				createDefaultDetailTerminalPanelState(selectedCard.card.id);
			if (!panelState.tabs.some((tab) => tab.taskId === taskId)) {
				return;
			}
			const selectionKey = createDetailTerminalSelectionKey(selectedCard.card, taskId);
			detailTerminalSelectionKeyRef.current = selectionKey;
			updateDetailTerminalPanelState(selectedCard.card.id, (previous) => ({
				...previous,
				activeTaskId: taskId,
				isOpen: true,
			}));
			void startDetailTerminalForCard(selectedCard.card, {
				showLoading: true,
				taskId,
			});
		},
		[detailTerminalPanelStateByCardId, selectedCard, startDetailTerminalForCard, updateDetailTerminalPanelState],
	);

	const handleAddDetailTerminalTab = useCallback(() => {
		if (!selectedCard) {
			return;
		}
		const panelState =
			detailTerminalPanelStateByCardId[selectedCard.card.id] ??
			createDefaultDetailTerminalPanelState(selectedCard.card.id);
		const tab = createDetailTerminalTab(selectedCard.card.id, getNextTerminalTabOrdinal(panelState.tabs));
		const selectionKey = createDetailTerminalSelectionKey(selectedCard.card, tab.taskId);
		detailTerminalSelectionKeyRef.current = selectionKey;
		updateDetailTerminalPanelState(selectedCard.card.id, (previous) => ({
			...previous,
			activeTaskId: tab.taskId,
			isOpen: true,
			tabs: previous.tabs.some((existingTab) => existingTab.taskId === tab.taskId)
				? previous.tabs
				: [...previous.tabs, tab],
		}));
		void startDetailTerminalForCard(selectedCard.card, {
			showLoading: true,
			taskId: tab.taskId,
		});
	}, [detailTerminalPanelStateByCardId, selectedCard, startDetailTerminalForCard, updateDetailTerminalPanelState]);

	const handleCloseDetailTerminalTab = useCallback(
		(taskId: string) => {
			if (!selectedCard) {
				return;
			}
			const panelState =
				detailTerminalPanelStateByCardId[selectedCard.card.id] ??
				createDefaultDetailTerminalPanelState(selectedCard.card.id);
			if (!panelState.tabs.some((tab) => tab.taskId === taskId)) {
				return;
			}
			stopTerminalTabSession(taskId);
			const remainingTabs = panelState.tabs.filter((tab) => tab.taskId !== taskId);
			if (remainingTabs.length === 0) {
				updateDetailTerminalPanelState(selectedCard.card.id, () =>
					createDefaultDetailTerminalPanelState(selectedCard.card.id),
				);
				detailTerminalSelectionKeyRef.current = null;
				return;
			}
			const nextActiveTaskId = getNextActiveTerminalTabId(panelState.tabs, taskId, panelState.activeTaskId);
			updateDetailTerminalPanelState(selectedCard.card.id, (previous) => ({
				...previous,
				activeTaskId: nextActiveTaskId ?? previous.activeTaskId,
				tabs: previous.tabs.filter((tab) => tab.taskId !== taskId),
			}));
			if (panelState.activeTaskId !== taskId || !nextActiveTaskId || !panelState.isOpen) {
				return;
			}
			const selectionKey = createDetailTerminalSelectionKey(selectedCard.card, nextActiveTaskId);
			detailTerminalSelectionKeyRef.current = selectionKey;
			void startDetailTerminalForCard(selectedCard.card, {
				showLoading: true,
				taskId: nextActiveTaskId,
			});
		},
		[
			detailTerminalPanelStateByCardId,
			selectedCard,
			startDetailTerminalForCard,
			stopTerminalTabSession,
			updateDetailTerminalPanelState,
		],
	);

	const handleSendAgentCommandToHomeTerminal = useCallback(() => {
		if (!agentCommand) {
			return;
		}
		void sendTaskSessionInput(homeTerminalTaskId, agentCommand, { appendNewline: true });
	}, [agentCommand, homeTerminalTaskId, sendTaskSessionInput]);

	const handleSendAgentCommandToDetailTerminal = useCallback(() => {
		if (!agentCommand || !detailTerminalTaskId) {
			return;
		}
		void sendTaskSessionInput(detailTerminalTaskId, agentCommand, { appendNewline: true });
	}, [agentCommand, detailTerminalTaskId, sendTaskSessionInput]);

	const prepareTerminalForShortcut = useCallback(
		async ({ prepareWaitForTerminalConnectionReady }: PrepareTerminalForShortcutInput) => {
			let targetTaskId = homeTerminalTaskId;
			let hadExistingOpenTerminal = false;
			let shouldWaitForConnection = false;
			let waitForTerminalConnectionReady: (() => Promise<void>) | null = null;
			const activeSelection = selectedCard;
			if (activeSelection) {
				const panelState =
					detailTerminalPanelStateByCardId[activeSelection.card.id] ??
					createDefaultDetailTerminalPanelState(activeSelection.card.id);
				targetTaskId = panelState.activeTaskId;
				const selectionKey = createDetailTerminalSelectionKey(activeSelection.card, targetTaskId);
				const detailWasAlreadyOpenForSelection =
					panelState.isOpen && detailTerminalSelectionKeyRef.current === selectionKey;
				hadExistingOpenTerminal = detailWasAlreadyOpenForSelection;
				shouldWaitForConnection = !detailWasAlreadyOpenForSelection;
				if (shouldWaitForConnection) {
					waitForTerminalConnectionReady = prepareWaitForTerminalConnectionReady(targetTaskId);
				}
				detailTerminalSelectionKeyRef.current = selectionKey;
				updateDetailTerminalPanelState(activeSelection.card.id, (previous) => ({
					...previous,
					activeTaskId: targetTaskId,
					isOpen: true,
				}));
				const started = await startDetailTerminalForCard(activeSelection.card, {
					showLoading: true,
					taskId: targetTaskId,
				});
				if (!started) {
					if (detailTerminalSelectionKeyRef.current === selectionKey) {
						detailTerminalSelectionKeyRef.current = null;
					}
					return {
						ok: false,
						message: "Could not open detail terminal.",
					} satisfies PrepareTerminalForShortcutResult;
				}
			} else {
				const homeWasAlreadyOpenForProject =
					isHomeTerminalOpen && homeTerminalProjectIdRef.current === currentProjectId;
				hadExistingOpenTerminal = homeWasAlreadyOpenForProject;
				shouldWaitForConnection = !homeWasAlreadyOpenForProject;
				if (shouldWaitForConnection) {
					waitForTerminalConnectionReady = prepareWaitForTerminalConnectionReady(targetTaskId);
				}
				homeTerminalProjectIdRef.current = currentProjectId;
				setIsHomeTerminalOpen(true);
				const started = await startHomeTerminalSession(targetTaskId);
				if (!started) {
					closeHomeTerminal();
					return {
						ok: false,
						message: "Could not open terminal.",
					} satisfies PrepareTerminalForShortcutResult;
				}
			}

			if (shouldWaitForConnection && waitForTerminalConnectionReady) {
				await waitForTerminalConnectionReady();
			}

			return {
				hadExistingOpenTerminal,
				ok: true,
				targetTaskId,
			} satisfies PrepareTerminalForShortcutResult;
		},
		[
			closeHomeTerminal,
			currentProjectId,
			detailTerminalPanelStateByCardId,
			homeTerminalTaskId,
			isHomeTerminalOpen,
			selectedCard,
			startDetailTerminalForCard,
			startHomeTerminalSession,
			updateDetailTerminalPanelState,
		],
	);

	const resetTerminalPanelsState = useCallback(() => {
		homeTerminalProjectIdRef.current = null;
		setIsHomeTerminalStarting(false);
		setHomeTerminalShellBinary(null);
		applyProjectTerminalPanelsState(currentProjectId, readProjectTerminalPanelsState(currentProjectId));
		setIsDetailTerminalStarting(false);
	}, [applyProjectTerminalPanelsState, currentProjectId]);

	return {
		homeTerminalTaskId,
		homeTerminalTabs,
		isHomeTerminalOpen,
		isHomeTerminalStarting,
		homeTerminalShellBinary,
		homeTerminalPaneHeight,
		isDetailTerminalOpen,
		detailTerminalTaskId,
		detailTerminalTabs,
		isDetailTerminalStarting,
		detailTerminalPaneHeight,
		isHomeTerminalExpanded,
		isDetailTerminalExpanded,
		setHomeTerminalPaneHeight,
		setDetailTerminalPaneHeight,
		handleToggleExpandHomeTerminal,
		handleToggleExpandDetailTerminal,
		handleToggleHomeTerminal,
		handleToggleDetailTerminal,
		handleSelectHomeTerminalTab,
		handleSelectDetailTerminalTab,
		handleAddHomeTerminalTab,
		handleAddDetailTerminalTab,
		handleCloseHomeTerminalTab,
		handleCloseDetailTerminalTab,
		handleSendAgentCommandToHomeTerminal,
		handleSendAgentCommandToDetailTerminal,
		prepareTerminalForShortcut,
		resetBottomTerminalLayoutCustomizations,
		collapseHomeTerminal,
		collapseDetailTerminal,
		closeHomeTerminal,
		closeDetailTerminal,
		resetTerminalPanelsState,
	};
}
