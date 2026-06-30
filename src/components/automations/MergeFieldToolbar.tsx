import { Button } from "@/components/ui/button";
import { fieldsForChannel } from "@/lib/mergeFields";

interface Props {
  channel: string;
  onInsert: (token: string) => void;
}

/**
 * Chip row above an editable touch body. Clicking a chip inserts the token at
 * the active field's caret. Reps can also type `{{` to trigger the autocomplete
 * popover — both paths use the same canonical token list from mergeFields.ts.
 */
export function MergeFieldToolbar({ channel, onInsert }: Props) {
  const fields = fieldsForChannel(channel);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        {fields.map((f) => (
          <Button
            key={f.token}
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs font-normal"
            onMouseDown={(e) => {
              // Don't steal focus from the active textarea before insert runs.
              e.preventDefault();
            }}
            onClick={() => onInsert(f.token)}
          >
            {f.label}
          </Button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Fields fill in automatically when each message sends. You can also type{" "}
        <code className="rounded bg-muted px-1">{"{{"}</code> to pick one.
      </p>
    </div>
  );
}
