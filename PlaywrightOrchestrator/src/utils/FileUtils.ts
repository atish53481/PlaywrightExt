import * as fs from 'fs';
import * as path from 'path';

export const FileUtils = {
  read(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8');
  },

  write(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  },

  readJson<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  },

  writeJson(filePath: string, data: unknown, indent = 2): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, indent), 'utf8');
  },

  exists(filePath: string): boolean {
    return fs.existsSync(filePath);
  },

  ensureDir(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
  },

  list(dirPath: string, ext?: string): string[] {
    if (!fs.existsSync(dirPath)) return [];
    const files = fs.readdirSync(dirPath);
    return ext ? files.filter(f => f.endsWith(ext)) : files;
  },

  listRecursive(dirPath: string, ext?: string): string[] {
    const results: string[] = [];
    function walk(dir: string) {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (!ext || f.endsWith(ext)) results.push(full);
      }
    }
    if (fs.existsSync(dirPath)) walk(dirPath);
    return results;
  },

  delete(filePath: string): void {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
};
