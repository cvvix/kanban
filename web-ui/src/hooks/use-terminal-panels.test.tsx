import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTerminalPanels } from "@/hooks/use-terminal-panels";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { CardSelection } from "@/types";

const startShellSessionMutateMock = vi.hoisted(() => vi.fn());
const stopTaskSessionMock = vi.hoisted(() => vi.fn());
const disposePersistentTerminalMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			startShellSession: {
				mutate: startShellSessionMutateMock,
			},
		},
	}),
}));

vi.mock("@/terminal/terminal-geometry-registry", () => ({
	getTerminalGeometry: () => ({ cols: 120, rows: 24 }),
	prepareWaitForTerminalGeometry: () => () => Promise.resolve(),
}));

vi.mock("@/terminal/persistent-terminal-manager", () => ({
	disposePersistentTerminal: disposePersistentTerminalMock,
}));

interface HookSnapshot {
	collapseDetailTerminal: ReturnType<typeof useTerminalPanels>["collapseDetailTerminal"];
	collapseHomeTerminal: ReturnType<typeof useTerminalPanels>["collapseHomeTerminal"];
	detailTerminalPaneHeight: number | undefined;
	detailTerminalTaskId: string | null;
	detailTerminalTabs: ReturnType<typeof useTerminalPanels>["detailTerminalTabs"];
	handleAddDetailTerminalTab: ReturnType<typeof useTerminalPanels>["handleAddDetailTerminalTab"];
	handleAddHomeTerminalTab: ReturnType<typeof useTerminalPanels>["handleAddHomeTerminalTab"];
	handleCloseDetailTerminalTab: ReturnType<typeof useTerminalPanels>["handleCloseDetailTerminalTab"];
	handleCloseHomeTerminalTab: ReturnType<typeof useTerminalPanels>["handleCloseHomeTerminalTab"];
	handleSelectDetailTerminalTab: ReturnType<typeof useTerminalPanels>["handleSelectDetailTerminalTab"];
	handleSelectHomeTerminalTab: ReturnType<typeof useTerminalPanels>["handleSelectHomeTerminalTab"];
	handleToggleDetailTerminal: ReturnType<typeof useTerminalPanels>["handleToggleDetailTerminal"];
	homeTerminalTaskId: string;
	homeTerminalPaneHeight: number | undefined;
	homeTerminalTabs: ReturnType<typeof useTerminalPanels>["homeTerminalTabs"];
	isDetailTerminalOpen: boolean;
	isHomeTerminalOpen: boolean;
	resetBottomTerminalLayoutCustomizations: ReturnType<
		typeof useTerminalPanels
	>["resetBottomTerminalLayoutCustomizations"];
	setDetailTerminalPaneHeight: ReturnType<typeof useTerminalPanels>["setDetailTerminalPaneHeight"];
	setHomeTerminalPaneHeight: ReturnType<typeof useTerminalPanels>["setHomeTerminalPaneHeight"];
}

function createSelection(taskId: string): CardSelection {
	const card = {
		id: taskId,
		title: `Task ${taskId}`,
		prompt: `Task ${taskId}`,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit" as const,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
	const column = {
		id: "in_progress" as const,
		title: "In Progress",
		cards: [card],
	};
	return {
		card,
		column,
		allColumns: [column],
	};
}

function createSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "codex",
		workspacePath: `/tmp/${taskId}`,
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (snapshot === null) {
		throw new Error("Expected a hook snapshot.");
	}
	return snapshot;
}

function HookHarness({
	onSnapshot,
	selectedCard,
}: {
	onSnapshot: (snapshot: HookSnapshot) => void;
	selectedCard: CardSelection | null;
}): null {
	const result = useTerminalPanels({
		currentProjectId: "project-1",
		selectedCard,
		workspaceGit: null,
		agentCommand: null,
		upsertSession: () => {},
		sendTaskSessionInput: async () => ({ ok: true }),
		stopTaskSession: async (taskId: string) => {
			stopTaskSessionMock(taskId);
		},
	});

	useEffect(() => {
		onSnapshot({
			collapseDetailTerminal: result.collapseDetailTerminal,
			collapseHomeTerminal: result.collapseHomeTerminal,
			detailTerminalPaneHeight: result.detailTerminalPaneHeight,
			detailTerminalTaskId: result.detailTerminalTaskId,
			detailTerminalTabs: result.detailTerminalTabs,
			handleAddDetailTerminalTab: result.handleAddDetailTerminalTab,
			handleAddHomeTerminalTab: result.handleAddHomeTerminalTab,
			handleCloseDetailTerminalTab: result.handleCloseDetailTerminalTab,
			handleCloseHomeTerminalTab: result.handleCloseHomeTerminalTab,
			handleSelectDetailTerminalTab: result.handleSelectDetailTerminalTab,
			handleSelectHomeTerminalTab: result.handleSelectHomeTerminalTab,
			handleToggleDetailTerminal: result.handleToggleDetailTerminal,
			homeTerminalTaskId: result.homeTerminalTaskId,
			homeTerminalPaneHeight: result.homeTerminalPaneHeight,
			homeTerminalTabs: result.homeTerminalTabs,
			isDetailTerminalOpen: result.isDetailTerminalOpen,
			isHomeTerminalOpen: result.isHomeTerminalOpen,
			resetBottomTerminalLayoutCustomizations: result.resetBottomTerminalLayoutCustomizations,
			setDetailTerminalPaneHeight: result.setDetailTerminalPaneHeight,
			setHomeTerminalPaneHeight: result.setHomeTerminalPaneHeight,
		});
	}, [
		onSnapshot,
		result.collapseDetailTerminal,
		result.collapseHomeTerminal,
		result.detailTerminalPaneHeight,
		result.detailTerminalTaskId,
		result.detailTerminalTabs,
		result.handleAddDetailTerminalTab,
		result.handleAddHomeTerminalTab,
		result.handleCloseDetailTerminalTab,
		result.handleCloseHomeTerminalTab,
		result.handleSelectDetailTerminalTab,
		result.handleSelectHomeTerminalTab,
		result.handleToggleDetailTerminal,
		result.homeTerminalTaskId,
		result.homeTerminalPaneHeight,
		result.homeTerminalTabs,
		result.isDetailTerminalOpen,
		result.isHomeTerminalOpen,
		result.resetBottomTerminalLayoutCustomizations,
		result.setDetailTerminalPaneHeight,
		result.setHomeTerminalPaneHeight,
	]);

	return null;
}

describe("useTerminalPanels", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		window.localStorage.clear();
		startShellSessionMutateMock.mockReset();
		stopTaskSessionMock.mockReset();
		disposePersistentTerminalMock.mockReset();
		startShellSessionMutateMock.mockImplementation(async ({ taskId }: { taskId: string }) => ({
			ok: true,
			summary: createSummary(taskId),
		}));
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("tracks detail terminal visibility per task selection", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const selectionA = createSelection("task-a");
		const selectionB = createSelection("task-b");

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={selectionA}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushPromises();
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);
		expect(initialSnapshot.isDetailTerminalOpen).toBe(false);
		expect(initialSnapshot.detailTerminalTaskId).toBe("__detail_terminal__:task-a");

		await act(async () => {
			requireSnapshot(latestSnapshot).handleToggleDetailTerminal();
			await flushPromises();
		});

		const openedTaskASnapshot = requireSnapshot(latestSnapshot);
		expect(openedTaskASnapshot.isDetailTerminalOpen).toBe(true);
		expect(startShellSessionMutateMock).toHaveBeenCalledTimes(1);
		expect(startShellSessionMutateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				taskId: "__detail_terminal__:task-a",
				workspaceTaskId: "task-a",
			}),
		);

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={selectionB}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushPromises();
		});

		const taskBSnapshot = requireSnapshot(latestSnapshot);
		expect(taskBSnapshot.isDetailTerminalOpen).toBe(false);
		expect(taskBSnapshot.detailTerminalTaskId).toBe("__detail_terminal__:task-b");
		expect(startShellSessionMutateMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={selectionA}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushPromises();
		});

		const restoredTaskASnapshot = requireSnapshot(latestSnapshot);
		expect(restoredTaskASnapshot.isDetailTerminalOpen).toBe(true);
		expect(restoredTaskASnapshot.detailTerminalTaskId).toBe("__detail_terminal__:task-a");
		expect(startShellSessionMutateMock).toHaveBeenCalledTimes(2);
		expect(startShellSessionMutateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				taskId: "__detail_terminal__:task-a",
				workspaceTaskId: "task-a",
			}),
		);
	});

	it("creates and switches home terminal tabs", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={null}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).homeTerminalTaskId).toBe("__home_terminal__");
		expect(requireSnapshot(latestSnapshot).homeTerminalTabs).toEqual([
			{
				taskId: "__home_terminal__",
				ordinal: 1,
			},
		]);

		await act(async () => {
			requireSnapshot(latestSnapshot).handleAddHomeTerminalTab();
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).homeTerminalTaskId).toBe("__home_terminal__:2");
		expect(requireSnapshot(latestSnapshot).homeTerminalTabs).toHaveLength(2);
		expect(startShellSessionMutateMock).toHaveBeenCalledTimes(1);
		expect(startShellSessionMutateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				taskId: "__home_terminal__:2",
			}),
		);

		await act(async () => {
			requireSnapshot(latestSnapshot).handleSelectHomeTerminalTab("__home_terminal__");
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).homeTerminalTaskId).toBe("__home_terminal__");
		expect(startShellSessionMutateMock).toHaveBeenCalledTimes(2);
		expect(startShellSessionMutateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				taskId: "__home_terminal__",
			}),
		);
	});

	it("closes home terminal tabs and selects an adjacent tab", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={null}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushPromises();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleAddHomeTerminalTab();
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).homeTerminalTaskId).toBe("__home_terminal__:2");
		expect(requireSnapshot(latestSnapshot).isHomeTerminalOpen).toBe(true);

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCloseHomeTerminalTab("__home_terminal__:2");
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).homeTerminalTaskId).toBe("__home_terminal__");
		expect(requireSnapshot(latestSnapshot).homeTerminalTabs).toEqual([
			{
				taskId: "__home_terminal__",
				ordinal: 1,
			},
		]);
		expect(requireSnapshot(latestSnapshot).isHomeTerminalOpen).toBe(true);
		expect(startShellSessionMutateMock).toHaveBeenCalledTimes(2);
		expect(startShellSessionMutateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				taskId: "__home_terminal__",
			}),
		);
		expect(stopTaskSessionMock).toHaveBeenCalledWith("__home_terminal__:2");

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCloseHomeTerminalTab("__home_terminal__");
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).homeTerminalTaskId).toBe("__home_terminal__");
		expect(requireSnapshot(latestSnapshot).homeTerminalTabs).toEqual([
			{
				taskId: "__home_terminal__",
				ordinal: 1,
			},
		]);
		expect(requireSnapshot(latestSnapshot).isHomeTerminalOpen).toBe(false);
		expect(stopTaskSessionMock).toHaveBeenCalledWith("__home_terminal__");
	});

	it("restores home terminal tabs after remounting", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		const renderHarness = async (): Promise<void> => {
			await act(async () => {
				root.render(
					<HookHarness
						selectedCard={null}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
				await flushPromises();
			});
		};

		await renderHarness();

		await act(async () => {
			requireSnapshot(latestSnapshot).handleAddHomeTerminalTab();
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).homeTerminalTaskId).toBe("__home_terminal__:2");
		expect(requireSnapshot(latestSnapshot).homeTerminalTabs).toHaveLength(2);
		expect(requireSnapshot(latestSnapshot).isHomeTerminalOpen).toBe(true);

		await act(async () => {
			root.unmount();
			root = createRoot(container);
			await flushPromises();
		});

		await renderHarness();

		expect(requireSnapshot(latestSnapshot).homeTerminalTaskId).toBe("__home_terminal__:2");
		expect(requireSnapshot(latestSnapshot).homeTerminalTabs).toEqual([
			{
				taskId: "__home_terminal__",
				ordinal: 1,
			},
			{
				taskId: "__home_terminal__:2",
				ordinal: 2,
			},
		]);
		expect(requireSnapshot(latestSnapshot).isHomeTerminalOpen).toBe(true);
	});

	it("creates and switches detail terminal tabs per selected task", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const selection = createSelection("task-a");

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={selection}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).detailTerminalTaskId).toBe("__detail_terminal__:task-a");
		expect(requireSnapshot(latestSnapshot).detailTerminalTabs).toEqual([
			{
				taskId: "__detail_terminal__:task-a",
				ordinal: 1,
			},
		]);

		await act(async () => {
			requireSnapshot(latestSnapshot).handleAddDetailTerminalTab();
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).detailTerminalTaskId).toBe("__detail_terminal__:task-a:2");
		expect(requireSnapshot(latestSnapshot).detailTerminalTabs).toHaveLength(2);
		expect(startShellSessionMutateMock).toHaveBeenCalledTimes(1);
		expect(startShellSessionMutateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				taskId: "__detail_terminal__:task-a:2",
				workspaceTaskId: "task-a",
			}),
		);

		await act(async () => {
			requireSnapshot(latestSnapshot).handleSelectDetailTerminalTab("__detail_terminal__:task-a");
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).detailTerminalTaskId).toBe("__detail_terminal__:task-a");
		expect(startShellSessionMutateMock).toHaveBeenCalledTimes(2);
		expect(startShellSessionMutateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				taskId: "__detail_terminal__:task-a",
				workspaceTaskId: "task-a",
			}),
		);
	});

	it("closes detail terminal tabs and selects an adjacent tab", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const selection = createSelection("task-a");

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={selection}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushPromises();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleAddDetailTerminalTab();
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).detailTerminalTaskId).toBe("__detail_terminal__:task-a:2");
		expect(requireSnapshot(latestSnapshot).isDetailTerminalOpen).toBe(true);

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCloseDetailTerminalTab("__detail_terminal__:task-a:2");
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).detailTerminalTaskId).toBe("__detail_terminal__:task-a");
		expect(requireSnapshot(latestSnapshot).detailTerminalTabs).toEqual([
			{
				taskId: "__detail_terminal__:task-a",
				ordinal: 1,
			},
		]);
		expect(requireSnapshot(latestSnapshot).isDetailTerminalOpen).toBe(true);
		expect(startShellSessionMutateMock).toHaveBeenCalledTimes(2);
		expect(startShellSessionMutateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				taskId: "__detail_terminal__:task-a",
				workspaceTaskId: "task-a",
			}),
		);
		expect(stopTaskSessionMock).toHaveBeenCalledWith("__detail_terminal__:task-a:2");

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCloseDetailTerminalTab("__detail_terminal__:task-a");
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).detailTerminalTaskId).toBe("__detail_terminal__:task-a");
		expect(requireSnapshot(latestSnapshot).detailTerminalTabs).toEqual([
			{
				taskId: "__detail_terminal__:task-a",
				ordinal: 1,
			},
		]);
		expect(requireSnapshot(latestSnapshot).isDetailTerminalOpen).toBe(false);
		expect(stopTaskSessionMock).toHaveBeenCalledWith("__detail_terminal__:task-a");
	});

	it("restores detail terminal tabs after remounting", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const selection = createSelection("task-a");

		const renderHarness = async (): Promise<void> => {
			await act(async () => {
				root.render(
					<HookHarness
						selectedCard={selection}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
				await flushPromises();
			});
		};

		await renderHarness();

		await act(async () => {
			requireSnapshot(latestSnapshot).handleAddDetailTerminalTab();
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).detailTerminalTaskId).toBe("__detail_terminal__:task-a:2");
		expect(requireSnapshot(latestSnapshot).detailTerminalTabs).toHaveLength(2);
		expect(requireSnapshot(latestSnapshot).isDetailTerminalOpen).toBe(true);

		await act(async () => {
			root.unmount();
			root = createRoot(container);
			await flushPromises();
		});

		await renderHarness();

		expect(requireSnapshot(latestSnapshot).detailTerminalTaskId).toBe("__detail_terminal__:task-a:2");
		expect(requireSnapshot(latestSnapshot).detailTerminalTabs).toEqual([
			{
				taskId: "__detail_terminal__:task-a",
				ordinal: 1,
			},
			{
				taskId: "__detail_terminal__:task-a:2",
				ordinal: 2,
			},
		]);
		expect(requireSnapshot(latestSnapshot).isDetailTerminalOpen).toBe(true);
	});

	it("shares the last resized bottom terminal height across home and detail panes", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const selectionA = createSelection("task-a");
		const selectionB = createSelection("task-b");

		const renderHarness = async (selectedCard: CardSelection | null): Promise<void> => {
			await act(async () => {
				root.render(
					<HookHarness
						selectedCard={selectedCard}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
				await flushPromises();
			});
		};

		await renderHarness(selectionA);
		expect(requireSnapshot(latestSnapshot).homeTerminalPaneHeight).toBeUndefined();
		expect(requireSnapshot(latestSnapshot).detailTerminalPaneHeight).toBeUndefined();

		await act(async () => {
			requireSnapshot(latestSnapshot).setDetailTerminalPaneHeight(320);
			await flushPromises();
		});

		const detailResizedSnapshot = requireSnapshot(latestSnapshot);
		expect(detailResizedSnapshot.detailTerminalPaneHeight).toBe(320);
		expect(detailResizedSnapshot.homeTerminalPaneHeight).toBe(320);
		expect(window.localStorage.getItem(LocalStorageKey.BottomTerminalPaneHeight)).toBe("320");

		await renderHarness(selectionB);
		expect(requireSnapshot(latestSnapshot).detailTerminalPaneHeight).toBe(320);
		expect(requireSnapshot(latestSnapshot).homeTerminalPaneHeight).toBe(320);

		await act(async () => {
			requireSnapshot(latestSnapshot).setHomeTerminalPaneHeight(410);
			await flushPromises();
		});

		const homeResizedSnapshot = requireSnapshot(latestSnapshot);
		expect(homeResizedSnapshot.homeTerminalPaneHeight).toBe(410);
		expect(homeResizedSnapshot.detailTerminalPaneHeight).toBe(410);
		expect(window.localStorage.getItem(LocalStorageKey.BottomTerminalPaneHeight)).toBe("410");

		await act(async () => {
			root.unmount();
			root = createRoot(container);
			await flushPromises();
		});

		await renderHarness(selectionA);
		expect(requireSnapshot(latestSnapshot).homeTerminalPaneHeight).toBe(410);
		expect(requireSnapshot(latestSnapshot).detailTerminalPaneHeight).toBe(410);
	});

	it("resets the shared bottom terminal height when collapsed", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const selection = createSelection("task-a");

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={selection}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushPromises();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleToggleDetailTerminal();
			await flushPromises();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setDetailTerminalPaneHeight(320);
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).detailTerminalPaneHeight).toBe(320);
		expect(window.localStorage.getItem(LocalStorageKey.BottomTerminalPaneHeight)).toBe("320");
		expect(requireSnapshot(latestSnapshot).isDetailTerminalOpen).toBe(true);

		await act(async () => {
			requireSnapshot(latestSnapshot).collapseDetailTerminal();
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).detailTerminalPaneHeight).toBeUndefined();
		expect(requireSnapshot(latestSnapshot).homeTerminalPaneHeight).toBeUndefined();
		expect(requireSnapshot(latestSnapshot).isDetailTerminalOpen).toBe(false);
		expect(window.localStorage.getItem(LocalStorageKey.BottomTerminalPaneHeight)).toBeNull();
	});

	it("resets the shared bottom terminal height without closing the current pane", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={null}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await flushPromises();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setHomeTerminalPaneHeight(420);
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).homeTerminalPaneHeight).toBe(420);
		expect(window.localStorage.getItem(LocalStorageKey.BottomTerminalPaneHeight)).toBe("420");

		await act(async () => {
			requireSnapshot(latestSnapshot).resetBottomTerminalLayoutCustomizations();
			await flushPromises();
		});

		expect(requireSnapshot(latestSnapshot).homeTerminalPaneHeight).toBeUndefined();
		expect(window.localStorage.getItem(LocalStorageKey.BottomTerminalPaneHeight)).toBeNull();
	});
});
