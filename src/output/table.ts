import Table from 'cli-table3';

// renderTable formats an array of flat records as a cli-table3 box-drawn
// table. Colours are NOT applied here — callers style via color.ts wrappers
// before handing rows in, keeping this renderer pure for easy snapshotting.
export function renderTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(none)';
  const head = Object.keys(rows[0]);
  const table = new Table({
    head,
    style: { head: [], border: [] },
  });
  for (const row of rows) {
    table.push(head.map((k) => String(row[k] ?? '')));
  }
  return table.toString();
}
