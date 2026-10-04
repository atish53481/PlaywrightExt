import { useId, useState, type KeyboardEvent } from 'react';
import { scriptsApi } from '../api/scripts';
import { useDebounced } from '../hooks/useDebounced';
import { useLoad } from '../hooks/useLoad';

const MAX_TAGS = 20;
// The same rule the server enforces.
const TAG_PATTERN = /^[\p{L}\p{M}\p{N} _.@-]{1,40}$/u;

interface Props {
  /** Id of the text box, so a <label htmlFor> can point at it. */
  id: string;
  tags: string[];
  onChange(tags: string[]): void;
}

/** Tags as removable chips plus a text box. Enter or a comma adds the typed tag; existing tags are suggested. */
export function TagInput({ id, tags, onChange }: Props) {
  const listId = useId();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const debounced = useDebounced(text, 200);
  const suggestions = useLoad(() => scriptsApi.tags(debounced), [debounced]);

  function add() {
    const value = text.trim();
    if (!value) return;
    if (!TAG_PATTERN.test(value)) {
      setProblem('A tag is 1 to 40 letters, digits, spaces, or - _ . @');
      return;
    }
    if (tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) {
      setText('');
      setProblem(null);
      return;
    }
    if (tags.length >= MAX_TAGS) {
      setProblem('A script can have at most 20 tags.');
      return;
    }
    onChange([...tags, value]);
    setText('');
    setProblem(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault(); // Enter must not submit the surrounding form
      add();
    } else if (event.key === 'Backspace' && text === '' && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  }

  return (
    <div className="tag-input">
      {tags.map((name) => (
        <span key={name} className="chip">
          {name}
          <button type="button" className="chip-remove" aria-label={`Remove tag ${name}`}
            onClick={() => onChange(tags.filter((tag) => tag !== name))}>
            ×
          </button>
        </span>
      ))}
      <input id={id} list={listId} value={text} placeholder="Add a tag" maxLength={40}
        onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} onBlur={add} />
      <datalist id={listId}>
        {(suggestions.data?.items ?? [])
          .filter((name) => !tags.includes(name))
          .map((name) => <option key={name} value={name} />)}
      </datalist>
      {problem && <p className="error" role="alert">{problem}</p>}
    </div>
  );
}
