export type WorkspaceKind = 'team' | 'customer';

export interface Workspace {
  id: string;
  name: string;
  role: 'admin' | 'member';
  createdAt: string;
  kind: WorkspaceKind;
}

/**
 * AIT-182 rollout skew: an older backend may still include the internal
 * workosOrganizationId on workspace rows. Drop it at the output boundary so
 * the CLI never prints it regardless of backend version.
 */
export function dropWorkosOrgId<T extends object>(row: T): T {
  const { workosOrganizationId: _drop, ...rest } = row as T & {
    workosOrganizationId?: unknown;
  };
  return rest as T;
}
