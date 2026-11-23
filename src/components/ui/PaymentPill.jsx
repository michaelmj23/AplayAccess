import { fmtMoney } from '../../lib/format';

// Fallback entrance-fee rates matching Setting::pricing() defaults —
// used when the caller doesn't (or can't) pass live rates through.
// '24hr-pm' is kept for legacy bookings created before the flexible
// 24hr start-hour; priced the same as '24hr'.
const FALLBACK_RATES = { day: 50, night: 80, '24hr': 100, '24hr-pm': 100 };

// Uses the backend-persisted entranceFee when it's non-zero (set at
// check-in), otherwise computes guests × per-head rate so
// Pending / Confirmed rows don't silently render at ₱0. Mirrors the
// calcEntrance used inside Billing.jsx and Bookings.jsx so the pill
// matches whatever the parent table would show.
function calcEntrance(b, rates = FALLBACK_RATES) {
  if (b?.entranceFee != null && Number(b.entranceFee) > 0) return Number(b.entranceFee);
  const rate = rates[b?.bookingType ?? 'day'] ?? 50;
  return Number(b?.guests ?? 1) * rate;
}

// ─── PaymentPill ─────────────────────────────────────────────────────────────
// Stacked, multi-line payment summary so staff can read "how much is
// owed", "against what total", and "how much has landed" in a single
// glance without opening the detail drawer.
//
// States:
//   Paid ₱X                        — fully paid (emerald, single line)
//   Collected ₱X                   — Completed checkout (emerald)
//   Due ₱X                         — outstanding balance (amber when nothing
//     of ₱Y total                    paid, sky when partial paid)
//     ₱Z paid
//   Forfeited ₱X                   — cancelled with money kept (rose)
//   Unpaid                         — cancelled with nothing collected (slate)
//   Awaiting payment               — Pending (amber, pre-clearance)
//
// grand includes stay extensions (`extensionsTotal`). Missing this
// was a bug that under-reported outstanding on extended Day→Night
// bookings and marked them "Paid" when ₱X was still owed.
export default function PaymentPill({ booking, entranceRates }) {
  const paid       = Number(booking?.paidAmount ?? 0);
  const extensions = Number(booking?.extensionsTotal ?? 0);
  const grand      = Number(booking?.total ?? 0) + extensions + calcEntrance(booking, entranceRates);

  // Derive "fully paid" from math, not from the backend flag. There was a
  // bug where checkIn updated entrance_fee without re-deriving
  // booking.fully_paid, leaving flag=true while paid_amount < grand total.
  // The pill then rendered "Paid ₱<room-only>" because it trusted the
  // stale flag. Computing from paid vs grand keeps the display honest
  // even if some future mutation re-introduces the drift.
  // 0.01 tolerance handles float noise (matches Booking::computeFullyPaid).
  const isFullyPaid = paid + 0.01 >= grand && grand > 0;

  if (booking?.status === 'Pending') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
        <i className="fas fa-hourglass-half text-[10px]" aria-hidden="true"></i>
        Awaiting payment
      </span>
    );
  }

  if (booking?.status === 'Completed') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
        <i className="fas fa-check-double text-[10px]" aria-hidden="true"></i>
        Collected {fmtMoney(paid)}
      </span>
    );
  }

  if (booking?.status === 'Cancelled') {
    // Two flavors: the guest actually paid something before cancelling
    // (forfeited revenue — rose) vs they abandoned before any money
    // cleared (neutral — slate). Using reservation_fee as the amount
    // here was a bug: that column is the quoted upfront charge, not
    // proof of collection, so it mis-labeled abandoned cancellations
    // as forfeited-paid at the quoted 20%.
    if (paid > 0) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-rose-50 text-rose-800 border border-rose-200">
          <i className="fas fa-ban text-[10px]" aria-hidden="true"></i>
          Forfeited {fmtMoney(paid)}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-slate-50 text-slate-500 border border-slate-200">
        Unpaid
      </span>
    );
  }

  if (isFullyPaid) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
        <i className="fas fa-check text-[10px]" aria-hidden="true"></i>
        Paid {fmtMoney(paid)}
      </span>
    );
  }

  // Due path — stacked. Amber when nothing has been paid at all
  // (first-collect urgency), sky when a partial has landed and
  // you're chasing the remainder.
  const due = Math.max(0, grand - paid);
  const tone = paid > 0 ? 'sky' : 'amber';
  const toneCls = tone === 'sky'
    ? 'bg-sky-50 text-sky-900 border-sky-200'
    : 'bg-amber-50 text-amber-900 border-amber-200';
  const dueTextCls = tone === 'sky' ? 'text-sky-800' : 'text-amber-800';
  const mutedCls   = tone === 'sky' ? 'text-sky-700/70' : 'text-amber-700/80';
  return (
    <div className={`inline-flex flex-col items-start px-2.5 py-1 rounded-md border ${toneCls}`}>
      <span className={`text-xs font-bold leading-tight ${dueTextCls}`}>
        Due {fmtMoney(due)}
      </span>
      <span className={`text-[10px] leading-tight ${mutedCls}`}>
        of {fmtMoney(grand)} total
      </span>
      {paid > 0 && (
        <span className={`text-[10px] leading-tight ${mutedCls}`}>
          {fmtMoney(paid)} paid
        </span>
      )}
    </div>
  );
}
