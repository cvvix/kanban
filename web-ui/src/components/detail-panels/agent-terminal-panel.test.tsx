import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { TooltipProvider } from "@/components/ui/tooltip";

const sessionMocks = vi.hoisted(() => ({
	clearTerminal: vi.fn(),
	stopTerminal: vi.fn(async () => {}),
}));

vi.mock("@/terminal/use-persistent-terminal-session", () => ({
	usePersistentTerminalSession: () => ({
		clearTerminal: sessionMocks.clearTerminal,
		containerRef: { current: null },
		isStopping: false,
		lastError: null,
		stopTerminal: sessionMocks.stopTerminal,
	}),
}));

function getRequiredElement<T extends Element>(container: ParentNode, selector: string): T {
	const element = container.querySelector(selector);
	expect(element).not.toBeNull();
	if (!element) {
		throw new Error(`Expected element for selector ${selector}.`);
	}
	return element as T;
}

describe("AgentTerminalPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let previousScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;
	let scrollIntoViewMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		previousScrollIntoView = HTMLElement.prototype.scrollIntoView;
		scrollIntoViewMock = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoViewMock,
		});
		vi.clearAllMocks();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		if (previousScrollIntoView) {
			Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
				configurable: true,
				value: previousScrollIntoView,
			});
		} else {
			delete (HTMLElement.prototype as Partial<Pick<HTMLElement, "scrollIntoView">>).scrollIntoView;
		}
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function renderPanel(onAddTerminalTab: () => void): void {
		root.render(
			<TooltipProvider>
				<AgentTerminalPanel
					taskId="__home_terminal__"
					workspaceId="project-1"
					summary={null}
					showSessionToolbar={false}
					onClose={() => {}}
					terminalTabs={[
						{
							id: "__home_terminal__",
							title: "kanban(1)",
							fullTitle: "Terminal /Users/carr/.codex/worktrees/e1a8/kanban",
						},
					]}
					activeTerminalTabId="__home_terminal__"
					onSelectTerminalTab={() => {}}
					onAddTerminalTab={onAddTerminalTab}
				/>
			</TooltipProvider>,
		);
	}

	it("creates a terminal panel with Meta+Backslash inside the terminal panel", async () => {
		const onAddTerminalTab = vi.fn();

		await act(async () => {
			renderPanel(onAddTerminalTab);
			await Promise.resolve();
		});

		const terminalContainer = getRequiredElement<HTMLDivElement>(container, ".kb-terminal-container");
		const event = new KeyboardEvent("keydown", {
			key: "\\",
			code: "Backslash",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});

		act(() => {
			terminalContainer.dispatchEvent(event);
		});

		expect(onAddTerminalTab).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it("ignores Meta+Backslash outside the terminal panel", async () => {
		const onAddTerminalTab = vi.fn();
		const outsideElement = document.createElement("button");
		document.body.appendChild(outsideElement);

		try {
			await act(async () => {
				renderPanel(onAddTerminalTab);
				await Promise.resolve();
			});

			const event = new KeyboardEvent("keydown", {
				key: "\\",
				code: "Backslash",
				metaKey: true,
				bubbles: true,
				cancelable: true,
			});

			act(() => {
				outsideElement.dispatchEvent(event);
			});

			expect(onAddTerminalTab).not.toHaveBeenCalled();
			expect(event.defaultPrevented).toBe(false);
		} finally {
			outsideElement.remove();
		}
	});
});
