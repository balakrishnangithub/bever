import { X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useDialogStore, type ChooseOptions, type ConfirmOptions, type PromptOptions } from '../lib/dialogs';

/** Renders the dialog that is currently requested. Mount once, near the root. */
export function DialogHost() {
  const request = useDialogStore((state) => state.request);
  if (!request) return null;
  if (request.kind === 'choose') {
    return <ChooseDialog key={request.options.title} options={request.options} onResolve={request.resolve} />;
  }
  return request.kind === 'prompt' ? (
    <PromptDialog key={request.options.title} options={request.options} onResolve={request.resolve} />
  ) : (
    <ConfirmDialog options={request.options} onResolve={request.resolve} />
  );
}

/** No more than this many choices are listed at once; typing narrows them down. */
const CHOICES_SHOWN = 200;

function ChooseDialog({
  options,
  onResolve,
}: {
  options: ChooseOptions;
  onResolve: (value: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const wanted = query.trim().toLowerCase();
  const found = wanted
    ? options.choices.filter((choice) => choice.label.toLowerCase().includes(wanted))
    : options.choices;
  return (
    <Frame title={options.title} onCancel={() => onResolve(null)}>
      {options.message && <div className="dialog-message">{options.message}</div>}
      <label>
        {options.label}
        <input
          ref={input}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Enter takes the only choice left.
            if (event.key === 'Enter' && found.length === 1 && found[0]) onResolve(found[0].id);
          }}
        />
      </label>
      <ul className="dialog-choices" aria-label={options.title}>
        {found.slice(0, CHOICES_SHOWN).map((choice) => (
          <li key={choice.id}>
            <button type="button" onClick={() => onResolve(choice.id)}>
              <span>{choice.label}</span>
              {choice.detail && <small>{choice.detail}</small>}
            </button>
          </li>
        ))}
        {found.length === 0 && <li className="dialog-choices-empty">Nothing by that name.</li>}
        {found.length > CHOICES_SHOWN && (
          <li className="dialog-choices-empty">
            {(found.length - CHOICES_SHOWN).toLocaleString()} more; type to narrow them down.
          </li>
        )}
      </ul>
      <div className="dialog-actions">
        <button type="button" className="secondary-action" onClick={() => onResolve(null)}>
          Cancel
        </button>
      </div>
    </Frame>
  );
}

function Frame({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={onCancel}>
      <section
        className="modal small-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onCancel} aria-label="Cancel">
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function PromptDialog({
  options,
  onResolve,
}: {
  options: PromptOptions;
  onResolve: (value: string | null) => void;
}) {
  const [value, setValue] = useState(options.initialValue ?? '');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const submit = () => {
    const trimmed = value.trim();
    const problem = trimmed
      ? (options.validate?.(trimmed) ?? null)
      : (options.emptyMessage ?? 'Enter a name.');
    if (problem) setError(problem);
    else onResolve(trimmed);
  };
  return (
    <Frame title={options.title} onCancel={() => onResolve(null)}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {options.message && <div className="dialog-message">{options.message}</div>}
        <label>
          {options.label}
          <input
            ref={input}
            value={value}
            placeholder={options.placeholder}
            maxLength={255}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
          />
        </label>
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary-action" onClick={() => onResolve(null)}>
            Cancel
          </button>
          <button
            type="submit"
            className={options.danger ? 'primary-action danger-action' : 'primary-action'}
          >
            {options.confirmLabel ?? 'Save'}
          </button>
        </div>
      </form>
    </Frame>
  );
}

function ConfirmDialog({
  options,
  onResolve,
}: {
  options: ConfirmOptions;
  onResolve: (value: boolean) => void;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), []);
  return (
    <Frame title={options.title} onCancel={() => onResolve(false)}>
      <div className="dialog-message">{options.message}</div>
      <div className="dialog-actions">
        <button type="button" className="secondary-action" onClick={() => onResolve(false)}>
          Cancel
        </button>
        <button
          ref={confirm}
          type="button"
          className={options.danger ? 'primary-action danger-action' : 'primary-action'}
          onClick={() => onResolve(true)}
        >
          {options.confirmLabel ?? 'OK'}
        </button>
      </div>
    </Frame>
  );
}
