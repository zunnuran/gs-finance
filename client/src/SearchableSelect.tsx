import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { sortRows } from "./tableSort";

export type SelectOption = {
  value: string | number;
  label: string;
  disabled?: boolean;
  searchText?: string;
};

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "Select an option",
  required = false,
  disabled = false,
  id,
  className = "",
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  value: string | number | null | undefined;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const generatedId = useId();
  const inputId = id || `select-${generatedId}`;
  const listId = `${inputId}-list`;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  const currentValue = String(value ?? "");
  const sortedOptions = useMemo(
    () => [
      ...options.filter((option) => String(option.value) === ""),
      ...sortRows(
        options.filter((option) => String(option.value) !== ""),
        (option) => option.label,
        "asc",
      ),
    ],
    [options],
  );
  const selectedOption = sortedOptions.find(
    (option) => String(option.value) === currentValue,
  );
  const selectedLabel = selectedOption?.label || "";
  const normalizedQuery = searching ? query.trim().toLocaleLowerCase() : "";
  const filtered = sortedOptions.filter((option) =>
    `${option.label} ${option.searchText || ""}`
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
  const enabledOptions = filtered.filter((option) => !option.disabled);
  const activeOption =
    enabledOptions.find((option) => String(option.value) === activeValue) ||
    enabledOptions[0];
  const activeIndex = activeOption ? filtered.indexOf(activeOption) : -1;
  const optionKey = JSON.stringify(
    filtered.map((option) => [option.value, option.label, option.disabled]),
  );

  const isDisabled = () => disabled || !!inputRef.current?.matches(":disabled");
  const close = () => {
    setOpen(false);
    setSearching(false);
    setQuery("");
  };
  const show = () => {
    if (isDisabled()) return;
    setPortalTarget(
      inputRef.current?.closest<HTMLElement>('[role="dialog"]') ||
        document.body,
    );
    setQuery(selectedLabel);
    setSearching(false);
    setActiveValue(currentValue);
    setOpen(true);
  };
  const choose = (option: SelectOption) => {
    if (isDisabled() || option.disabled) return;
    onChange(String(option.value));
    close();
  };

  useLayoutEffect(() => {
    const validChoice = !!selectedOption && !selectedOption.disabled;
    const invalid =
      (required && !currentValue) || (!!currentValue && !validChoice);
    inputRef.current?.setCustomValidity(
      invalid ? "Select an available option from the list." : "",
    );
  }, [currentValue, required, selectedOption]);

  useEffect(() => {
    close();
  }, [currentValue, disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const input = inputRef.current;
    if (!input) return;
    const updatePosition = () => {
      if (input.matches(":disabled")) {
        close();
        return;
      }
      const rect = input.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop || 0;
      const viewportBottom =
        viewportTop + (viewport?.height || window.innerHeight);
      const viewportWidth = document.documentElement.clientWidth;
      if (rect.bottom < viewportTop || rect.top > viewportBottom) {
        close();
        return;
      }
      const below = viewportBottom - rect.bottom - 8;
      const above = rect.top - viewportTop - 8;
      const upward = below < 180 && above > below;
      const width = Math.min(Math.max(rect.width, 220), viewportWidth - 16);
      const next: CSSProperties = {
        position: "fixed",
        left: Math.max(8, Math.min(rect.left, viewportWidth - width - 8)),
        top: upward ? rect.top - 4 : rect.bottom + 4,
        width,
        maxHeight: Math.max(60, Math.min(320, upward ? above : below)),
        transform: upward ? "translateY(-100%)" : undefined,
      };
      setPosition((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    const observer = new MutationObserver(updatePosition);
    for (
      let parent = input.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      if (parent.tagName === "FIELDSET")
        observer.observe(parent, {
          attributes: true,
          attributeFilter: ["disabled"],
        });
    }
    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
      observer.disconnect();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !wrapperRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      )
        close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  useLayoutEffect(() => {
    if (open && activeIndex >= 0)
      document
        .getElementById(`${listId}-option-${activeIndex}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, optionKey, listId]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (!open) {
        show();
        return;
      }
      if (!enabledOptions.length) return;
      const currentIndex = enabledOptions.indexOf(activeOption);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (currentIndex + step + enabledOptions.length) % enabledOptions.length;
      setActiveValue(String(enabledOptions[nextIndex].value));
    } else if (open && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      const option =
        event.key === "Home" ? enabledOptions[0] : enabledOptions.at(-1);
      if (option) setActiveValue(String(option.value));
    } else if (open && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (activeOption) choose(activeOption);
    } else if (open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      close();
    }
  };

  return (
    <div ref={wrapperRef} className={`searchable-select ${className}`.trim()}>
      <input
        ref={inputRef}
        id={inputId}
        className="searchable-select-input"
        role="combobox"
        type="text"
        value={open ? query : selectedLabel}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && activeIndex >= 0
            ? `${listId}-option-${activeIndex}`
            : undefined
        }
        onFocus={(event) => {
          show();
          event.currentTarget.select();
        }}
        onClick={(event) => {
          if (!open) show();
          // Clicking an existing choice starts a new search without appending
          // the typed text to its label. Once searching, normal caret edits work.
          if (!searching) event.currentTarget.select();
        }}
        onBlur={close}
        onKeyDown={onKeyDown}
        onChange={(event) => {
          if (isDisabled()) return;
          setPortalTarget(
            inputRef.current?.closest<HTMLElement>('[role="dialog"]') ||
              document.body,
          );
          setQuery(event.target.value);
          setSearching(true);
          setActiveValue(null);
          setOpen(true);
        }}
      />
      <ChevronDown
        size={15}
        className="searchable-select-chevron"
        aria-hidden="true"
      />
      {open &&
        portalTarget &&
        createPortal(
          <div
            ref={menuRef}
            className="searchable-select-menu"
            style={position}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              id={listId}
              role="listbox"
              aria-label={ariaLabel || "Available options"}
              aria-labelledby={ariaLabelledBy}
            >
              {filtered.map((option, index) => (
                <div
                  key={`${String(option.value)}-${index}`}
                  id={`${listId}-option-${index}`}
                  role="option"
                  aria-selected={String(option.value) === currentValue}
                  aria-disabled={option.disabled || undefined}
                  className={`searchable-select-option${index === activeIndex ? " is-active" : ""}${String(option.value) === currentValue ? " is-selected" : ""}`}
                  onMouseEnter={() => {
                    if (!option.disabled) setActiveValue(String(option.value));
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    choose(option);
                  }}
                >
                  <span>{option.label}</span>
                  {String(option.value) === currentValue && (
                    <Check size={14} aria-hidden="true" />
                  )}
                </div>
              ))}
            </div>
            {!filtered.length && (
              <div className="searchable-select-empty" role="status">
                No matching options
              </div>
            )}
            <div className="searchable-select-count" aria-live="polite">
              {filtered.length} option{filtered.length === 1 ? "" : "s"} · Type
              to search
            </div>
          </div>,
          portalTarget,
        )}
    </div>
  );
}
