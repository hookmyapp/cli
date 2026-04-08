export function output(data: unknown, opts: { human?: boolean }): void {
  if (!opts.human) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (typeof data === 'string') {
    console.log(data);
    return;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log('(empty)');
      return;
    }
    const keys = Object.keys(data[0]);
    console.log(keys.join('\t'));
    for (const row of data) {
      console.log(keys.map((k) => (row as Record<string, unknown>)[k] ?? '').join('\t'));
    }
    return;
  }

  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      console.log(`${k}: ${v}`);
    }
    return;
  }

  console.log(String(data));
}
