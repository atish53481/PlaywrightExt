import { useEffect, useRef } from 'react';
import { javascript } from '@codemirror/lang-javascript';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import type { ScriptLanguage } from '../api/types';

interface Props {
  /** Accessible name of the text area. */
  label: string;
  value: string;
  language: ScriptLanguage;
  readOnly?: boolean;
  onChange?(value: string): void;
}

const syntax = (language: ScriptLanguage): Extension => javascript({ typescript: language === 'TypeScript' });
const access = (readOnly: boolean): Extension => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly),
];

/** A code editor. Pages use this component and never touch CodeMirror themselves. */
export function CodeEditor({ label, value, language, readOnly = false, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const compartments = useRef({ syntax: new Compartment(), access: new Compartment() });
  // The change listener is installed once, so it reaches the current callback through a ref.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          oneDark,
          compartments.current.syntax.of(syntax(language)),
          compartments.current.access.of(access(readOnly)),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Built once. Later changes to value, language, and readOnly are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A value that did not come from typing (a load, a reload, a reset) replaces the document.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value) editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.syntax.reconfigure(syntax(language)) });
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.access.reconfigure(access(readOnly)) });
  }, [readOnly]);

  return <div className="code-editor" ref={host} />;
}
