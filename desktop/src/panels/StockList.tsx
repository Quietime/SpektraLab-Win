// StockList.tsx — the film and paper lists: group headers, a rounded white
// selection, the orange CINE pill, a cover where the catalogue has one.

export interface StockRow {
  id: string;
  name: string;
  header?: boolean;
  cine?: boolean;
  cover?: string | null;
  disabled?: boolean;
  reason?: string | null;
}

export function StockList({ rows, selected, onSelect, testId, label }: { rows: StockRow[]; selected: string; onSelect: (id: string) => void; testId?: string; label?: string }) {
  // Keyboard: the list takes focus as one stop; Up/Down/Home/End move the
  // selection over enabled rows. The keys stop here so the window's ←/→
  // frame shortcuts and ↑/↓ handlers never see them (keys.ts listens on
  // window in the bubble phase).
  const choices = rows.filter((r) => !r.header && !r.disabled);
  const optionId = (id: string) => `${testId ?? 'stock'}-opt-${id}`;
  return (
    <div
      role="listbox"
      data-testid={testId}
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={rows.some((r) => r.id === selected && !r.header) ? optionId(selected) : undefined}
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || !choices.length) return;
        const at = choices.findIndex((r) => r.id === selected);
        const next =
          e.key === 'ArrowDown' ? Math.min(choices.length - 1, at + 1) :
          e.key === 'ArrowUp' ? Math.max(0, at < 0 ? 0 : at - 1) :
          e.key === 'Home' ? 0 :
          e.key === 'End' ? choices.length - 1 : null;
        const row = next === null ? undefined : choices[next];
        if (!row) return;
        e.preventDefault();
        e.stopPropagation();
        if (next !== at) onSelect(row.id);
        document.getElementById(optionId(row.id))?.scrollIntoView({ block: 'nearest' });
      }}
    >
      {rows.map((r) =>
        r.header ? (
          <div key={r.id} className="stock-group" role="presentation">
            {r.name}
          </div>
        ) : (
          <div
            key={r.id}
            id={optionId(r.id)}
            role="option"
            aria-selected={r.id === selected}
            aria-disabled={r.disabled}
            className={'stock-row' + (r.id === selected ? ' selected' : '') + (r.disabled ? ' disabled' : '')}
            title={r.disabled ? (r.reason ?? undefined) : r.name}
            onClick={() => !r.disabled && onSelect(r.id)}
            data-stock={r.id}
          >
            <span className="name">{r.name}</span>
            {r.cover && <img className="cover" src={r.cover} alt="" />}
            {r.cine && <span className="cine-pill">CINE</span>}
          </div>
        ),
      )}
    </div>
  );
}
