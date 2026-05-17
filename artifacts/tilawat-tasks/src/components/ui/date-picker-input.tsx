import * as React from "react";
import { format, parse, isValid } from "date-fns";
import { ar } from "date-fns/locale";
import { CalendarIcon, X } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DatePickerInputProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  optional?: boolean;
}

export function DatePickerInput({
  value,
  onChange,
  placeholder = "اختر تاريخاً",
  optional = false,
}: DatePickerInputProps) {
  const [open, setOpen] = React.useState(false);

  const selected: Date | undefined = value
    ? (() => {
        const d = parse(value, "yyyy-MM-dd", new Date());
        return isValid(d) ? d : undefined;
      })()
    : undefined;

  const handleSelect = (day: Date | undefined) => {
    if (day) {
      onChange?.(format(day, "yyyy-MM-dd"));
    } else {
      onChange?.("");
    }
    setOpen(false);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange?.("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "w-full justify-start text-right font-normal h-9 px-3 gap-2",
            !selected && "text-muted-foreground"
          )}
          dir="rtl"
        >
          <CalendarIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-right truncate">
            {selected
              ? format(selected, "d MMMM yyyy", { locale: ar })
              : placeholder}
          </span>
          {selected && optional && (
            <span
              role="button"
              tabIndex={0}
              onClick={handleClear}
              onKeyDown={(e) => e.key === "Enter" && handleClear(e as any)}
              className="rounded-full hover:bg-muted p-0.5 transition-colors"
            >
              <X className="h-3 w-3" />
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start" dir="rtl">
        <Calendar
          mode="single"
          selected={selected}
          onSelect={handleSelect}
          weekStartsOn={0}
          locale={ar}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}
