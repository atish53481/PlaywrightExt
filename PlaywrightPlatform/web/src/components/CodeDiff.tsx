import { useEffect, useRef } from 'react';
import { javascript } from '@codemirror/lang-javascript';
import { MergeView } from '@codemirror/merge';
import { EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import type { ScriptLanguage } from '../api/types';

interface Props {
  left: string;
  right: string;
  /** Accessible names of the two panes. */
  leftLabel: string;
  rightLabel: string;
  language: ScriptLanguage;
}

/** A read-only, side-by-side comparison of two texts with the differences highlighted. */
export function CodeDiff({ left, right, leftLabel, rightLabel, language }: Props) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pane = (label: string): Extension => [
      basicSetup,
      oneDark,
      javascript({ typescript: language === 'TypeScript' }),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ 'aria-label': label }),
    ];
    const merge = new MergeView({
      parent: host.current!,
      a: { doc: left, extensions: pane(leftLabel) },
      b: { doc: right, extensions: pane(rightLabel) },
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    return () => merge.destroy();
  }, [left, right, leftLabel, rightLabel, language]);

  return <div className="code-diff" ref={host} />;
}
