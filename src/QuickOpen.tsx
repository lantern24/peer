import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ChevronRight, Code2, Search } from "lucide-react";
import { Modal } from "./Modal";
import type { FileEntry } from "./types";
import { SearchText, textMatches } from "./search";
import { matchesShortcut } from "./shortcuts";

export function QuickOpen({
  files,
  onSelect,
  onClose,
}: {
  files: FileEntry[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const activeOption = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(0);
  const results = useMemo(
    () =>
      files
        .filter((file) => !filter || textMatches(file.path, filter).length > 0)
        .slice(0, 100),
    [files, filter],
  );
  const activeIndex = Math.min(index, results.length - 1);
  useEffect(() => {
    activeOption.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results]);

  const select = (id: string) => {
    onSelect(id);
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    const direction = matchesShortcut("quickNext", event)
      ? 1
      : matchesShortcut("quickPrevious", event)
        ? -1
        : 0;
    if (!direction && !matchesShortcut("quickAccept", event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!results.length) return;
    if (direction) {
      setIndex(
        (current) =>
          (Math.min(current, results.length - 1) + direction + results.length) %
          results.length,
      );
    } else {
      select(results[activeIndex].id);
    }
  };

  return (
    <Modal
      title="Go to file"
      onClose={onClose}
      className="quick-open"
      initialFocus={input}
    >
      <label className="filter-input">
        <Search size={16} />
        <input
          ref={input}
          autoFocus
          role="combobox"
          aria-label="Quick open file"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={
            activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
          }
          placeholder="Type a filename…"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      <div
        id={listId}
        className="quick-results"
        role="listbox"
        aria-label="Files"
        onKeyDown={onKeyDown}
      >
        {results.map((file, optionIndex) => (
          <button
            key={file.id}
            id={`${listId}-${optionIndex}`}
            ref={optionIndex === activeIndex ? activeOption : undefined}
            role="option"
            aria-selected={optionIndex === activeIndex}
            tabIndex={-1}
            title={file.path}
            onClick={() => select(file.id)}
          >
            <Code2 size={14} />
            <span>
              <SearchText text={file.path} query={filter} />
            </span>
            <ChevronRight size={13} />
          </button>
        ))}
      </div>
      {!results.length && (
        <p className="quick-empty" role="status">
          No matching files
        </p>
      )}
    </Modal>
  );
}
