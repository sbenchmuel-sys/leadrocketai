import { forwardRef, useImperativeHandle, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fieldsForChannel, insertAtCursor, detectMergeTrigger, type MergeField } from "@/lib/mergeFields";

export interface MergeFieldEditorHandle {
  /** Insert a token at the active caret (used by toolbar chips). */
  insert: (token: string) => void;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  channel: string;
  /** Render as a single-line input (e.g. subject). Default: textarea. */
  asInput?: boolean;
  rows?: number;
  placeholder?: string;
  className?: string;
}

/**
 * Textarea/Input that supports `{{` autocomplete for campaign merge fields.
 * The parent owns the value; this component just intercepts keystrokes to show
 * a small suggestion menu and lets the toolbar call `insert(token)` via ref.
 */
export const MergeFieldEditor = forwardRef<MergeFieldEditorHandle, Props>(function MergeFieldEditor(
  { value, onChange, channel, asInput, rows, placeholder, className },
  ref,
) {
  const elRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [menu, setMenu] = useState<{ start: number; query: string } | null>(null);
  const [highlight, setHighlight] = useState(0);

  const fields = fieldsForChannel(channel);
  const suggestions: MergeField[] = menu
    ? fields.filter((f) =>
        f.label.toLowerCase().includes(menu.query.toLowerCase()) ||
        f.token.toLowerCase().slice(1).includes(menu.query.toLowerCase()),
      )
    : [];

  useImperativeHandle(ref, () => ({
    insert(token: string) {
      const el = elRef.current;
      if (!el) {
        onChange(value + token);
        return;
      }
      const { value: next, caret } = insertAtCursor(el, token);
      onChange(next);
      // Restore caret after React rerender.
      requestAnimationFrame(() => {
        el.focus();
        try {
          el.setSelectionRange(caret, caret);
        } catch {
          /* ignore */
        }
      });
      setMenu(null);
    },
  }));

  const handleChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const next = e.target.value;
    onChange(next);
    const caret = e.target.selectionStart ?? next.length;
    const trig = detectMergeTrigger(next, caret);
    if (trig) {
      setMenu(trig);
      setHighlight(0);
    } else {
      setMenu(null);
    }
  };

  const applySuggestion = (f: MergeField) => {
    const el = elRef.current;
    if (!el || !menu) return;
    // Replace the `{{<query>` span with the canonical token.
    const before = value.slice(0, menu.start);
    const caret = el.selectionStart ?? value.length;
    const after = value.slice(caret);
    const nextValue = before + f.token + after;
    const nextCaret = before.length + f.token.length;
    onChange(nextValue);
    requestAnimationFrame(() => {
      el.focus();
      try {
        el.setSelectionRange(nextCaret, nextCaret);
      } catch {
        /* ignore */
      }
    });
    setMenu(null);
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!menu || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      applySuggestion(suggestions[highlight]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setMenu(null);
    }
  };

  const sharedProps = {
    value,
    onChange: handleChange,
    onKeyDown: handleKey,
    onBlur: () => setTimeout(() => setMenu(null), 120),
    placeholder,
    className,
  };

  return (
    <div className="relative">
      {asInput ? (
        <Input ref={elRef as React.RefObject<HTMLInputElement>} {...sharedProps} />
      ) : (
        <Textarea
          ref={elRef as React.RefObject<HTMLTextAreaElement>}
          rows={rows}
          {...sharedProps}
        />
      )}
      {menu && suggestions.length > 0 && (
        <div className="absolute z-50 mt-1 max-h-56 w-56 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md">
          {suggestions.map((f, i) => (
            <button
              key={f.token}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                applySuggestion(f);
              }}
              className={
                "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs " +
                (i === highlight ? "bg-accent text-accent-foreground" : "hover:bg-muted")
              }
            >
              <span>{f.label}</span>
              <code className="text-[10px] text-muted-foreground">{f.token}</code>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
