// Minimal ambient types for update-notifier v7 (ships no .d.ts; the
// @types/update-notifier package targets v6/CJS). Only the surface the CLI
// uses in src/update-check.ts.
declare module 'update-notifier' {
  export interface UpdateNotifierUpdate {
    current: string;
    latest: string;
    type: string;
    name: string;
  }
  export interface UpdateNotifierInstance {
    update?: UpdateNotifierUpdate;
  }
  export default function updateNotifier(options: {
    pkg: { name: string; version: string };
    updateCheckInterval?: number;
  }): UpdateNotifierInstance;
}
