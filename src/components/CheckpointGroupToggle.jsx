/*
Tujuan: Tombol buka/tutup daftar sub checkpoint di bawah main checkpoint.
Caller: ShipCheckpointsTab (admin, menu Armada) dan PatrolPage (petugas).
*/

import React from 'react';
import { ChevronDown } from 'lucide-react';

export default function CheckpointGroupToggle({ expanded, onToggle, subCount, summary, summaryTone = 'muted', controlsId }) {
  const toneClass = {
    muted: 'text-cyan-500',
    good: 'text-emerald-300',
    warning: 'text-amber-300',
  }[summaryTone] || 'text-cyan-500';

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={controlsId}
      className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-sky-300 hover:bg-sky-500/10 transition-colors"
    >
      <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-left">
        <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`} />
        {expanded ? 'Sembunyikan' : 'Lihat'} {subCount} sub
      </span>
      {summary && <span className={`shrink-0 text-[11px] font-semibold ${toneClass}`}>{summary}</span>}
    </button>
  );
}

// State buka/tutup per main checkpoint. Default terbuka; yang ditutup disimpan di Set.
export function useCollapsedGroups() {
  const [collapsedIds, setCollapsedIds] = React.useState(() => new Set());
  const isExpanded = React.useCallback((id) => !collapsedIds.has(id), [collapsedIds]);
  const toggle = React.useCallback((id) => {
    setCollapsedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const expand = React.useCallback((id) => {
    setCollapsedIds((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }, []);
  const setAll = React.useCallback((ids, collapsed) => {
    setCollapsedIds(collapsed ? new Set(ids) : new Set());
  }, []);
  return { isExpanded, toggle, expand, setAll, collapsedCount: collapsedIds.size };
}
