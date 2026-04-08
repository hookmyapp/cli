export interface Workspace {
  id: string;
  name: string;
  workosOrganizationId: string;
  role: 'admin' | 'member';
  createdAt: string;
}
