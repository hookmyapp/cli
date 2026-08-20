/**
 * The workspace resolved for THIS invocation, published by
 * getDefaultWorkspaceId() once it has applied the precedence rules
 * (--workspace > HOOKMYAPP_WORKSPACE_ID > persisted config).
 *
 * A leaf module with no imports: both the API client (which sends
 * X-Workspace-Id) and telemetry (which tags events) need it, and neither can
 * import the other without a cycle. Whoever reads this gets the workspace the
 * request actually targeted, not a guess reconstructed from config.
 */
let resolvedWorkspaceId: string | null = null;

export function setWorkspaceContext(ctx: { workspaceId: string | null }): void {
  resolvedWorkspaceId = ctx.workspaceId;
}

export function getWorkspaceContext(): string | null {
  return resolvedWorkspaceId;
}
