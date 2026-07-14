export type WorkspaceKind = 'team' | 'customer';

export interface Workspace {
  id: string;
  name: string;
  role: 'admin' | 'member';
  createdAt: string;
  kind: WorkspaceKind;
}
