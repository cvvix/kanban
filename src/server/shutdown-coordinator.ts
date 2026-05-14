import type { WorkspaceRegistry } from "./workspace-registry";

export interface RuntimeShutdownCoordinatorDependencies {
	workspaceRegistry: Pick<WorkspaceRegistry, "listManagedWorkspaces">;
	closeRuntimeServer: () => Promise<void>;
}

export async function shutdownRuntimeServer(deps: RuntimeShutdownCoordinatorDependencies): Promise<void> {
	for (const { terminalManager } of deps.workspaceRegistry.listManagedWorkspaces()) {
		terminalManager.markInterruptedAndStopAll();
	}
	await deps.closeRuntimeServer();
}
