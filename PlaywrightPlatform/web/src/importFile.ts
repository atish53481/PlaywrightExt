import type { ScriptLanguage } from './api/types';

export interface ImportedScript {
  name: string;
  content: string;
  language: ScriptLanguage;
}

const MAX_BYTES = 1024 * 1024;

const LANGUAGE_BY_EXTENSION: Record<string, ScriptLanguage | undefined> = {
  ts: 'TypeScript',
  js: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
};

/**
 * Reads a script file the user chose. Throws an Error whose message can be shown to the
 * user when the file is not a .ts, .js, .mjs, or .cjs file of at most 1 MB.
 */
export async function readScriptFile(file: File): Promise<ImportedScript> {
  const dot = file.name.lastIndexOf('.');
  const language = dot > 0 ? LANGUAGE_BY_EXTENSION[file.name.slice(dot + 1).toLowerCase()] : undefined;
  if (!language) throw new Error('Choose a .ts, .js, .mjs, or .cjs file.');
  if (file.size > MAX_BYTES) throw new Error('That file is larger than 1 MB.');
  if (file.size === 0) throw new Error('That file is empty.');

  // The server stores \n line endings; converting here keeps the editor from showing a change.
  const content = (await file.text()).replace(/\r\n?/g, '\n');
  // "login.spec.ts" becomes "login".
  const name = file.name.replace(/(\.(spec|test))?\.[^.]+$/i, '').slice(0, 200) || 'Imported script';
  return { name, content, language };
}
