export const DateUtils = {
  now(): Date { return new Date(); },

  format(date: Date, pattern = 'YYYY-MM-DD HH:mm:ss'): string {
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return pattern
      .replace('YYYY', String(y))
      .replace('MM', mo)
      .replace('DD', d)
      .replace('HH', h)
      .replace('mm', mi)
      .replace('ss', s);
  },

  slug(date = new Date()): string {
    return DateUtils.format(date, 'YYYY-MM-DD-HH-mm-ss');
  },

  duration(startMs: number): string {
    const ms = Date.now() - startMs;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  },

  durationMs(startMs: number): number {
    return Date.now() - startMs;
  },
};
