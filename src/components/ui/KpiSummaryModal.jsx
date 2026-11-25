import Modal from "../modals/Modal";

/**
 * Reusable KPI summary modal — opens when a staff/owner clicks a
 * dashboard revenue/collection tile. Standardizes the "what does this
 * number actually mean" explanation across every surface so the three
 * different revenue bases (stay-based, cash-based, outstanding) don't
 * confuse the reader.
 *
 * Props:
 *   open         — boolean
 *   onClose      — () => void
 *   title        — e.g. "Monthly Revenue"
 *   value        — pre-formatted display string, e.g. "₱284,500.00"
 *   basis        — short badge label: "Stay-based" | "Cash-based" |
 *                  "Outstanding" | "Overdue" | "Collected today"
 *   basisDetail  — one-sentence plain-English explanation of the basis
 *   scope        — e.g. "Bookings arriving Nov 2026"
 *   breakdown    — [{label, amount, hint?}] rows (hint = optional subtext)
 *   note         — optional footer <ReactNode> (e.g. cross-reference to
 *                  a sibling tile with the other basis)
 *   iconClass    — Font Awesome class suffix, e.g. "fa-peso-sign"
 *   accent       — "emerald" | "sky" | "amber" | "rose" | "teal" | "purple"
 *                  — colors the header and basis pill
 */
const ACCENTS = {
  emerald: { bg: "bg-emerald-50",  pill: "bg-emerald-100 text-emerald-700", icon: "bg-emerald-100 text-emerald-600" },
  sky:     { bg: "bg-sky-50",      pill: "bg-sky-100 text-sky-700",         icon: "bg-sky-100 text-sky-600"         },
  amber:   { bg: "bg-amber-50",    pill: "bg-amber-100 text-amber-700",     icon: "bg-amber-100 text-amber-600"     },
  rose:    { bg: "bg-rose-50",     pill: "bg-rose-100 text-rose-700",       icon: "bg-rose-100 text-rose-600"       },
  teal:    { bg: "bg-teal-50",     pill: "bg-teal-100 text-teal-700",       icon: "bg-teal-100 text-teal-600"       },
  purple:  { bg: "bg-purple-50",   pill: "bg-purple-100 text-purple-700",   icon: "bg-purple-100 text-purple-600"   },
};

export default function KpiSummaryModal({
  open,
  onClose,
  title,
  value,
  basis,
  basisDetail,
  scope,
  breakdown = [],
  note = null,
  iconClass = "fa-peso-sign",
  accent = "emerald",
}) {
  const a = ACCENTS[accent] || ACCENTS.emerald;

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-md" title={title}>
      {/* Header */}
      <div className={`${a.bg} rounded-t-xl px-5 py-4 flex items-start justify-between gap-3`}>
        <div className="flex items-start gap-3 min-w-0">
          <div className={`p-2.5 rounded-lg ${a.icon} shrink-0`}>
            <i className={`fas ${iconClass} text-lg`} aria-hidden="true"></i>
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-600">{title}</h3>
            <p className="text-2xl font-extrabold tabular-nums text-slate-900 mt-0.5">{value}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="w-9 h-9 inline-flex items-center justify-center rounded-md text-slate-500 hover:text-slate-800 hover:bg-white/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          aria-label="Close"
        >
          <i className="fas fa-times" aria-hidden="true"></i>
        </button>
      </div>

      {/* Body */}
      <div className="px-5 py-4 space-y-4">
        {/* Basis + scope */}
        <div className="space-y-1.5">
          {basis && (
            <div>
              <span className={`inline-block text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded ${a.pill}`}>
                {basis}
              </span>
            </div>
          )}
          {basisDetail && <p className="text-xs text-slate-600">{basisDetail}</p>}
          {scope && (
            <p className="text-xs text-slate-500">
              <i className="fas fa-calendar-day mr-1 text-slate-400" aria-hidden="true"></i>
              {scope}
            </p>
          )}
        </div>

        {/* Breakdown */}
        {breakdown.length > 0 && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">Breakdown</p>
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
              {breakdown.map((row, i) => (
                <div key={i} className="px-3 py-2 flex items-start justify-between gap-3 bg-white">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-700">{row.label}</p>
                    {row.hint && <p className="text-[11px] text-slate-500 mt-0.5">{row.hint}</p>}
                  </div>
                  <span className="text-sm font-semibold tabular-nums text-slate-900 shrink-0">{row.amount}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Cross-reference / note */}
        {note && (
          <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5 text-xs text-slate-600">
            <i className="fas fa-circle-info mr-1.5 text-slate-400" aria-hidden="true"></i>
            {note}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 rounded-b-xl flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 min-h-9 bg-slate-900 hover:bg-slate-700 text-white rounded-lg text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
        >
          Close
        </button>
      </div>
    </Modal>
  );
}
