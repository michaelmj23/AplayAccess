import { useState, useEffect, useMemo, Fragment } from 'react';
import { Helmet } from 'react-helmet-async';
import Sidebar from './Layout/Sidebar';
import Modal from '../../components/modals/Modal.jsx';
import ConfirmDialog from '../../components/ui/ConfirmDialog.jsx';
import useFocusTrap from '../../hooks/useFocusTrap.js';
import { getFdBookings, collectPayment, collectReservationPayment, downloadStaffReceipt } from '../../lib/frontdeskApi';
import { api } from '../../lib/api';
import Toast, { useToast } from '../../components/ui/Toast';
import PaymentCell from '../../components/ui/PaymentPill';
import { fmtMoney, fmtDate, fmtDateTime, localDateStr } from '../../lib/format';
import { usePagination, PaginationBar } from '../../lib/pagination.jsx';


// ─── helpers ──────────────────────────────────────────────────────────────────
// '24hr-pm' is kept for legacy bookings created before the flexible 24hr
// start-hour; new bookings only use '24hr'. Priced the same as '24hr'.
const FALLBACK_RATES = { day: 50, night: 80, '24hr': 100, '24hr-pm': 100 };

function calcEntrance(b, entranceRates = FALLBACK_RATES) {
  // Use stored value if available (after check-in), otherwise compute from guests × rate
  if (b.entranceFee != null && Number(b.entranceFee) > 0) return Number(b.entranceFee);
  const rate = entranceRates[b.bookingType ?? 'day'] ?? 50;
  return (b.guests ?? 1) * rate;
}

const todayStr = () => localDateStr();


function PayIcon({ method }) {
  const m = (method || '').toLowerCase();
  if (m === 'cash')
    return <span className="inline-flex items-center gap-1"><i className="fas fa-money-bill-wave text-emerald-600"></i> Cash</span>;
  if (m === 'gcash')
    return <span className="inline-flex items-center gap-1"><i className="fas fa-mobile-alt text-sky-500"></i> GCash</span>;
  if (m === 'maya' || m === 'paymaya')
    return <span className="inline-flex items-center gap-1"><i className="fas fa-mobile-alt text-emerald-500"></i> Maya</span>;
  return <span className="capitalize">{method || '—'}</span>;
}

function isExpiredPending(b) {
  if (b.status !== 'Pending') return false;
  if (b.fullyPaid) return false;
  // A booking with an active PayMongo checkout link is still being paid
  // for — the guest may still be on the PayMongo page. Don't label those
  // as Expired even after five minutes; the webhook / polling / stale-
  // pending job will clear them correctly. Mirrors the same guard in
  // Reservation and BookingDetailModal.
  if (b.paymongoLinkId) return false;
  const created = new Date(b.createdAt);
  return Date.now() - created.getTime() > 5 * 60 * 1000;
}

function StatusBadge({ status, booking }) {
  if (status === 'Pending' && booking && isExpiredPending(booking)) {
    return (
      <span className="px-2 py-1 rounded text-xs font-medium bg-rose-100 text-rose-700 flex items-center gap-1 w-fit">
        <i className="fas fa-times-circle text-[10px]"></i>Expired
      </span>
    );
  }
  const cls = {
    Confirmed:    'bg-sky-100 text-sky-800',
    Completed:    'bg-emerald-100 text-emerald-800',
    Cancelled:    'bg-rose-100 text-rose-800',
    Pending:      'bg-amber-100 text-amber-800',
    'Checked In': 'bg-violet-100 text-violet-800',
  };
  return (
    <span className={`px-2 py-1 rounded text-xs font-medium ${cls[status] ?? 'bg-slate-100 text-slate-800'}`}>
      {status}
    </span>
  );
}

// Display-name resolution for walk-in bookings. specialRequests is
// user-editable on online bookings, so only trust the "Walk-in: <name>"
// prefix when the backend-attributed `source` confirms it's a walk-in —
// otherwise fall back to b.guest. Matches the Bookings page behavior.
function walkInName(b) {
  if (b?.source === 'walk-in' && b.specialRequests?.startsWith('Walk-in:')) {
    const m = b.specialRequests.match(/^Walk-in:\s*([^,]+)/);
    if (m) return m[1].trim();
  }
  return b?.guest || 'Guest';
}

// PaymentCell moved to components/ui/PaymentPill.jsx (imported at
// top as PaymentCell alias) so Bookings can reuse the same pill shape.

// ─── detail drawer ────────────────────────────────────────────────────────────
function BillingDetailDrawer({ booking: b, onClose, onCollect, onDownloadReceipt, downloading, entranceRates }) {
  if (!b) return null;

  // Grand total = room total + extensions sum + current entrance fee.
  // extensionsTotal comes from the backend (Booking::extensionsTotal()
  // — sum of booking_extensions.total for every chained stay extension).
  // Without it, an extended Day→Night stay reports only the Day portion
  // and falsely shows "Fully Paid" after the counter settles the Day.
  const entranceNow    = calcEntrance(b, entranceRates);
  const extensionsSum  = Number(b.extensionsTotal ?? 0);
  const grandTotal     = Number(b.total ?? 0) + extensionsSum + entranceNow;
  const paidSoFar      = Number(b.paidAmount ?? 0);
  const outstanding    = Math.max(0, grandTotal - paidSoFar);
  const balanceDue     = outstanding; // legacy alias, kept so downstream JSX reads naturally

  return (
    // Slide-in from the right edge — was instant pop-in before, which
    // felt janky. Keyframe defined in src/index.css under
    // .animate-slide-in-right (transform + opacity only, no layout).
    <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-2xl flex flex-col overflow-y-auto z-40 border-l border-slate-200 animate-slide-in-right">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h3 className="text-lg font-bold text-slate-800">Billing Detail</h3>
            <p className="text-xs text-slate-400">{b.id}</p>
          </div>
          <button onClick={onClose} type="button" className="w-11 h-11 inline-flex items-center justify-center rounded-md text-slate-500 hover:text-slate-700 hover:bg-slate-100 text-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" aria-label="Close">
            <i className="fas fa-times"></i>
          </button>
        </div>

        <div className="flex-1 p-6 space-y-5">

          {/* Status */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">Status</span>
            <StatusBadge status={b.status} booking={b} />
          </div>

          {/* Guest info */}
          <div className="bg-slate-50 rounded-lg p-4 space-y-1 text-sm">
            <p className="font-semibold text-slate-800 text-base">{walkInName(b)}</p>
            <p className="text-slate-500">{b.roomType} · {b.guests} pax</p>
            <p className="text-slate-400 text-xs mt-1">
              {fmtDateTime(b.checkIn)} → {fmtDateTime(b.checkOut)}
            </p>
          </div>

          {/* Payment method */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-500">Payment Method</span>
            <PayIcon method={b.paymentMethod} />
          </div>

          {/* Bill breakdown */}
          {(() => {
            const amenityTotal = (b.amenities ?? []).reduce((s, a) => s + Number(a.total ?? (a.unitPrice * a.qty) ?? 0), 0);
            const discount     = Number(b.discount ?? 0);
            const roomRate     = Number(b.total ?? 0) + discount - amenityTotal;
            const hasExtras    = amenityTotal > 0 || discount > 0;

            return (
              <div className="border rounded-lg overflow-hidden text-sm">
                {/* Room rate */}
                <div className="flex justify-between px-4 py-3 border-b bg-slate-50">
                  <span className="text-slate-500">Room Rate</span>
                  <span className="font-medium">{fmtMoney(roomRate)}</span>
                </div>

                {/* Add-ons */}
                {b.amenities?.length > 0 && b.amenities.map((a, i) => (
                  <div key={i} className="flex justify-between px-4 py-2.5 border-b text-slate-600">
                    <span className="flex items-center gap-1.5">
                      <i className="fas fa-plus-circle text-xs text-slate-400"></i>
                      {a.name} × {a.qty}
                    </span>
                    <span>{fmtMoney(a.total ?? (a.unitPrice * a.qty))}</span>
                  </div>
                ))}

                {/* Stay extensions — per-row listing so staff can see
                    what grew the bill (Day guest extended into Night,
                    etc.). Hidden when the booking was never extended. */}
                {Array.isArray(b.extensions) && b.extensions.length > 0 && b.extensions.map((e, i) => (
                  <div key={`ext-${i}`} className="flex justify-between px-4 py-2.5 border-b text-violet-700 bg-violet-50/50">
                    <span className="flex items-center gap-1.5">
                      <i className="fas fa-clock-rotate-left text-xs"></i>
                      Extension — {e.type === 'night' ? 'Night' : e.type === 'day' ? 'Day' : '24hr'}
                      {Number(e.nights) > 1 ? ` × ${e.nights} nights` : ''}
                    </span>
                    <span>+ {fmtMoney(e.total)}</span>
                  </div>
                ))}

                {/* Promo discount */}
                {discount > 0 && (
                  <div className="flex justify-between px-4 py-2.5 border-b text-emerald-700">
                    <span className="flex items-center gap-1.5">
                      <i className="fas fa-tag text-xs"></i>
                      Promo{b.promoCode ? ` (${b.promoCode})` : ''}
                    </span>
                    <span>− {fmtMoney(discount)}</span>
                  </div>
                )}

                {/* Subtotal — only show when there are extras */}
                {hasExtras && (
                  <div className="flex justify-between px-4 py-3 border-b bg-slate-50 font-semibold text-slate-800">
                    <span>Total</span>
                    <span>{fmtMoney(b.total)}</span>
                  </div>
                )}

                {/* Reservation fee paid — only when paid_amount covers it.
                    reservation_fee is the QUOTED 20% upfront charge set
                    at booking creation; it's > 0 on every online booking,
                    whether or not money has actually cleared. Gating on
                    paidAmount >= reservationFee prevents the bill from
                    saying "Paid" when the guest closed PayMongo without
                    paying. */}
                {Number(b.reservationFee ?? 0) > 0 && Number(b.paidAmount ?? 0) >= Number(b.reservationFee ?? 0) && (
                  <div className="flex justify-between px-4 py-2.5 border-b text-emerald-700">
                    <span>Reservation Fee Paid</span>
                    <span>− {fmtMoney(b.reservationFee)}</span>
                  </div>
                )}

                {/* Entrance fee line (calculated from guests × rate; stored value takes precedence after check-in) */}
                {(() => {
                  const rate = entranceRates[b.bookingType ?? 'day'] ?? 50;
                  return entranceNow > 0 && (
                    <div className="flex justify-between px-4 py-2.5 border-t border-amber-100 bg-amber-50 text-amber-800 text-xs">
                      <span className="flex items-center gap-1.5">
                        <i className="fas fa-ticket-alt"></i>
                        Entrance Fee ({b.guests} pax × ₱{rate})
                      </span>
                      <span className="font-semibold">{fmtMoney(entranceNow)}</span>
                    </div>
                  );
                })()}

                {/* Grand total */}
                <div className="flex justify-between px-4 py-3 bg-slate-800 text-white font-bold text-base">
                  <span>Grand Total</span>
                  <span>{fmtMoney(grandTotal)}</span>
                </div>

                {/* Paid so far / outstanding — status line.
                    Cancelled branch shows forfeited = paid_amount (what
                    was actually kept), not reservation_fee (the quoted
                    upfront). When the guest never paid, paid_amount is
                    0 and we render a neutral "No payment received"
                    line instead of claiming money was forfeited. */}
                {b.status === 'Cancelled' ? (
                  paidSoFar > 0 ? (
                    <div className="flex justify-between px-4 py-3 bg-rose-50 text-rose-700 font-semibold">
                      <span>Forfeited (Non-refundable)</span>
                      <span>{fmtMoney(paidSoFar)}</span>
                    </div>
                  ) : (
                    <div className="flex justify-between px-4 py-3 bg-slate-50 text-slate-500 font-medium">
                      <span>No payment received</span>
                      <span>—</span>
                    </div>
                  )
                ) : (
                  <>
                    {paidSoFar > 0 && (
                      <div className="flex justify-between px-4 py-2.5 border-t text-emerald-700">
                        <span>Paid so far</span>
                        <span>− {fmtMoney(paidSoFar)}</span>
                      </div>
                    )}
                    {outstanding > 0 ? (
                      <div className="flex justify-between px-4 py-3 bg-sky-50 text-sky-800 font-bold text-base">
                        <span>Outstanding Balance</span>
                        <span>{fmtMoney(outstanding)}</span>
                      </div>
                    ) : (
                      <div className="flex justify-between px-4 py-3 bg-emerald-50 text-emerald-700 font-semibold">
                        <span>{b.status === 'Completed' ? 'Total Collected' : 'Fully Paid'}</span>
                        <span>{fmtMoney(paidSoFar)}</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })()}

          {/* Special requests */}
          {b.specialRequests && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase mb-1">Special Requests</p>
              <p className="text-sm text-slate-700 bg-amber-50 border border-amber-100 rounded p-3">
                {b.specialRequests}
              </p>
            </div>
          )}
        </div>

        {/* Action footer */}
        <div className="px-6 py-4 border-t bg-slate-50 flex gap-3">
          {b.status === 'Confirmed' && !b.fullyPaid && (
            <button
              type="button"
              onClick={() => onCollect(b)}
              className="flex-1 inline-flex items-center justify-center min-h-11 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
            >
              <i className="fas fa-hand-holding-usd mr-2" aria-hidden="true"></i>Collect Payment
            </button>
          )}
          {b.status === 'Confirmed' && b.fullyPaid && (
            <div className="flex-1 py-2.5 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-lg text-sm font-medium text-center">
              <i className="fas fa-check-circle mr-2"></i>Fully Paid Online
            </div>
          )}
          {/* Receipt — available for any booking with collected money
              (Confirmed / Checked In / Completed, or Cancelled WITH
              paid_amount > 0 so there's a forfeit worth documenting).
              Hidden for unpaid cancellations: no money moved, nothing
              to receipt. Backend ReceiptController mirrors this gate
              and returns 422 if called directly. */}
          {b.status !== 'Pending' && !(b.status === 'Cancelled' && paidSoFar <= 0) && (
            <button
              type="button"
              onClick={() => onDownloadReceipt(b.bookingId)}
              disabled={downloading === b.bookingId}
              className={`inline-flex items-center justify-center min-h-11 py-2.5 ${b.status === 'Completed' ? 'flex-1' : 'px-4'} bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700 disabled:opacity-60 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2`}
              title="Download booking confirmation (PDF)"
            >
              <i className={`fas ${downloading === b.bookingId ? 'fa-spinner fa-spin' : 'fa-file-pdf'} mr-2`} aria-hidden="true"></i>
              {downloading === b.bookingId
                ? 'Preparing...'
                : b.status === 'Completed' ? 'Download Confirmation' : 'Confirmation'}
            </button>
          )}
          {b.status === 'Cancelled' && (
            <p className="flex-1 text-center text-sm text-rose-600 py-2">
              <i className="fas fa-ban mr-1"></i>
              {paidSoFar > 0 ? 'Reservation fee forfeited' : 'Cancelled — no payment received'}
            </p>
          )}
          {b.status === 'Pending' && (
            <p className="flex-1 text-center text-sm text-amber-700 py-2">
              <i className="fas fa-clock mr-1"></i>Awaiting guest payment confirmation
            </p>
          )}
          <button type="button" onClick={onClose}
            className="inline-flex items-center justify-center min-h-11 px-4 py-2.5 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-100 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
            Close
          </button>
        </div>
    </div>
  );
}

// ─── component ────────────────────────────────────────────────────────────────
// `embedded` prop: see Bookings.jsx for the rationale — when true,
// the front-desk Sidebar + top bar are skipped so an outer shell
// (AdminShell) can wrap the page body instead.
export default function Billing({ embedded = false }) {
  const Shell = embedded ? Fragment : Sidebar;
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');

  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy,  setSortBy]  = useState('Time Slot');
  const [sortDir, setSortDir] = useState('asc');
  const [selected, setSelected] = useState(null);   // booking shown in detail drawer
  const [billing, setBilling]   = useState(null);   // booking in collect-payment modal
  const [payMethod, setPayMethod] = useState('Cash');
  const [paying, setPaying]     = useState(false);
  // Partial-payment amount input. Empty string = "collect full
  // outstanding" (the common case — staff just hits Collect). A number
  // overrides to that amount; backend clamps to (0, outstanding].
  const [amountInput, setAmountInput] = useState('');
  // GCash reference number. Required only when payMethod === 'GCash'.
  // Not sent to backend for Cash. Backend persists to paymongo_payment_id
  // so the receipt's "GCash Ref" row keeps working.
  const [gcashRef, setGcashRef] = useState('');
  // Two-step confirm so a misclick on Collect doesn't post a payment
  // to the DB and auto-check-in the guest.
  const [confirmCollectOpen, setConfirmCollectOpen] = useState(false);
  // Future-dated bookings with outstanding balance are hidden from the
  // "today's queue" by default (billing isn't actionable until the guest
  // is here), but staff still needs to find them when a guest arrives
  // early or asks to pre-settle. Collapsed by default.
  const [upcomingOpen, setUpcomingOpen] = useState(false);
  const [downloading, setDownloading] = useState(null); // bookingId being downloaded

  const [toast, showToast, clearToast, toastType] = useToast();
  const [entranceRates, setEntranceRates] = useState(FALLBACK_RATES);

  // Dedicated search side panel — fetches on demand, no auto-refresh.
  // Lets staff reach bookings older than the 7-day poll window (e.g. to
  // reprint a receipt from 6 months ago) without bloating every 20s poll.
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [pastQuery, setPastQuery] = useState('');
  const [pastResults, setPastResults] = useState([]);
  const [pastLoading, setPastLoading] = useState(false);
  const [pastSearched, setPastSearched] = useState(false);
  const [pastDownloading, setPastDownloading] = useState(null);

  // Esc-to-close for the search-past side panel. The Collect Payment
  // modal now uses the shared <Modal> component which handles Escape
  // internally — only the side panel still needs this wiring.
  useEffect(() => {
    if (!searchPanelOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setSearchPanelOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [searchPanelOpen]);

  // Focus trap for the search-past side panel. Side panels are
  // dialogs structurally (modal=true, blocks page interaction via
  // backdrop), so they need the same Tab containment as a centered
  // Modal. Modal would force-center the panel and break the
  // slide-out design, so the trap is wired directly here.
  const searchPanelRef = useFocusTrap(searchPanelOpen);

  async function runPastSearch(e) {
    if (e) e.preventDefault();
    const q = pastQuery.trim();
    if (!q) return;
    setPastLoading(true);
    setPastSearched(true);
    try {
      const data = await getFdBookings({ search: q });
      setPastResults(data);
    } catch {
      showToast('Search failed. Please try again.', 'error');
    } finally {
      setPastLoading(false);
    }
  }

  async function downloadPastReceipt(bookingId, resId) {
    setPastDownloading(bookingId);
    try {
      const blob = await downloadStaffReceipt(bookingId);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `${resId}-booking-confirmation.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      showToast('Failed to download confirmation.', 'error');
    } finally {
      setPastDownloading(null);
    }
  }

  useEffect(() => {
    // 7-day window for the Billing page's polling — covers today + the
    // last week of check-ins, plus any booking that is currently Checked
    // In regardless of when it started (backend adds that OR-clause). Old
    // bookings are reachable via the Search Past panel.
    const from = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      return localDateStr(d);
    })();

    function loadBookings(initial = false) {
      getFdBookings({ from })
        .then(data => { setBookings(data); setError(''); })
        .catch(() => setError('Failed to load billing data.'))
        .finally(() => { if (initial) setLoading(false); });
    }
    loadBookings(true);
    // Poll every 20s so guest-count / amenity edits from Reservation or
    // WalkIn pages reflect here without the user reopening the drawer.
    const id = setInterval(() => loadBookings(false), 20_000);


    api.get('/api/pricing')
      .then(r => {
        const d = r.data?.data;
        if (d) setEntranceRates({
          day:      Number(d.entrance_fee_day   ?? 50),
          night:    Number(d.entrance_fee_night  ?? 80),
          '24hr':   Number(d.entrance_fee_24hr   ?? 100),
          '24hr-pm': Number(d.entrance_fee_24hr  ?? 100),
        });
      })
      .catch(() => {});
    return () => clearInterval(id);
  }, []);

  // Keep the open detail drawer / payment modal in sync with the polled
  // bookings list — if guest count or amenities change elsewhere, the
  // currently-open booking should reflect the new amounts immediately.
  useEffect(() => {
    setSelected(prev => prev ? (bookings.find(b => b.bookingId === prev.bookingId) ?? null) : prev);
    setBilling(prev  => prev ? (bookings.find(b => b.bookingId === prev.bookingId) ?? null) : prev);
  }, [bookings]);

  const today = todayStr();

  // Which bookings count as "today's billing"?
  //   - Any booking with a check-in date of today (past, present, or future that day)
  //   - Any Checked-In booking regardless of when it started — the guest is
  //     still here, balance may still be outstanding, and staff needs it
  //     visible past midnight (a 24hr stay that started at 11:50 PM yesterday
  //     shouldn't disappear from billing at 12:01 AM).
  //   - Confirmed bookings whose check-out window is still open (similar
  //     reasoning — active reservations shouldn't fall off overnight).
  //   - Bookings that completed or were cancelled today (recent history).
  const todayAll = useMemo(() => bookings.filter(b => {
    if (b.checkIn?.slice(0, 10) === today) return true;
    if (b.status === 'Checked In') return true;
    if (b.status === 'Confirmed' && b.checkOut) {
      const co = new Date(String(b.checkOut).replace(' ', 'T'));
      if (!isNaN(co.getTime()) && co > new Date()) return true;
    }
    if (b.status === 'Completed' && b.checkedOutAt?.slice(0, 10) === today) return true;
    if (b.status === 'Cancelled' && b.updatedAt?.slice(0, 10) === today) return true;
    return false;
  }), [bookings, today]);

  // Inline search narrows today's view. To find a booking older than the
  // 7-day poll window, staff opens the "Search past" side panel which
  // hits the backend on demand.
  const isSearching = searchTerm.trim().length > 0;
  const searchedTodayAll = useMemo(() => {
    if (!isSearching) return todayAll;
    const term = searchTerm.trim().toLowerCase();
    return todayAll.filter(b =>
      // walkInName resolves to the staff-entered name for walk-ins and
      // falls back to b.guest for online bookings, so a single search
      // matches both the "Walk-in: Juan" prefix and the canonical guest.
      walkInName(b).toLowerCase().includes(term)
        || (b.guest ?? '').toLowerCase().includes(term)
        || (b.id ?? '').toLowerCase().includes(term)
        || (b.roomType ?? '').toLowerCase().includes(term)
        || (b.guestEmail ?? '').toLowerCase().includes(term)
        || (b.guestPhone ?? '').includes(term.replace(/\s/g, ''))
    );
  }, [todayAll, searchTerm, isSearching]);

  // Overdue checkout = Checked In booking whose scheduled checkOut
  // has already passed. Same definition the mobile card render uses
  // (search "overdue" further down). Lifted here so the sort
  // comparator can use it as the primary tier — overdue rows always
  // float to the top regardless of which column the user picks.
  // Within the overdue group AND within the non-overdue group, the
  // column sort still applies.
  const isOverdue = (b) => b.status === 'Checked In'
    && b.checkOut
    && new Date(String(b.checkOut).replace(' ', 'T')) < new Date();

  const sortedTodayAll = useMemo(() => [...searchedTodayAll].sort((a, b) => {
    // Primary tier — overdue first. A staff member sweeping the list
    // for "who's still here past their checkout" should never have
    // to dig past Confirmed bookings to find them.
    const ao = isOverdue(a), bo = isOverdue(b);
    if (ao !== bo) return ao ? -1 : 1;

    let aVal, bVal;
    if (sortBy === 'Booking ID') { aVal = a.id ?? '';             bVal = b.id ?? ''; }
    else if (sortBy === 'Guest')      { aVal = walkInName(a).toLowerCase();        bVal = walkInName(b).toLowerCase(); }
    else if (sortBy === 'Room')       { aVal = (a.roomType ?? '').toLowerCase();   bVal = (b.roomType ?? '').toLowerCase(); }
    else if (sortBy === 'Booking Total') { aVal = Number(a.total ?? 0);            bVal = Number(b.total ?? 0); }
    else if (sortBy === 'To Collect') {
      // Paid rows sort as 0 (nothing to collect); unpaid rows sort by
      // outstanding (room + entrance − already-paid). Cancelled rows
      // carry the forfeited reservation-fee amount so they group with
      // zero-collect rows, not at the top.
      const outstanding = (x) => {
        if (x.status === 'Completed' || x.status === 'Cancelled' || x.fullyPaid) return 0;
        return Math.max(0, Number(x.total ?? 0) + Number(x.extensionsTotal ?? 0) + calcEntrance(x, entranceRates) - Number(x.paidAmount ?? 0));
      };
      aVal = outstanding(a); bVal = outstanding(b);
    }
    else if (sortBy === 'Status')     { aVal = a.status ?? '';                     bVal = b.status ?? ''; }
    else { aVal = a.checkIn ?? ''; bVal = b.checkIn ?? ''; }
    if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDir === 'asc' ?  1 : -1;
    return 0;
  }), [searchedTodayAll, sortBy, sortDir, entranceRates]);

  // Collapse multi-room reservations to one aggregated row before
  // pagination — same shape as Bookings.jsx (see 5b2a620). A
  // multi-room group now shows ONE billing row carrying the group's
  // aggregated total / paidAmount / entranceFee / outstanding.
  // Single-room reservations pass through unchanged.
  const collapsedTodayAll = useMemo(() => {
    const byRes = new Map();
    const order = [];
    for (const b of sortedTodayAll) {
      const isGroupMember = b.reservationId && Number(b.groupSize ?? 1) > 1;
      const key = isGroupMember ? `res:${b.reservationId}` : `solo:${b.bookingId}`;
      if (!byRes.has(key)) {
        byRes.set(key, []);
        order.push(key);
      }
      byRes.get(key).push(b);
    }
    const priority = {
      'Checked In': 1, 'Confirmed': 2, 'Pending': 3,
      'No-Show': 4, 'Completed': 5, 'Cancelled': 6,
    };
    return order.map(key => {
      const items = byRes.get(key);
      if (items.length === 1 && key.startsWith('solo:')) return items[0];
      const sorted = [...items].sort((a, b) => a.bookingId - b.bookingId);
      const lead = sorted[0];
      const total       = sorted.reduce((s, x) => s + Number(x.total || 0), 0);
      const extensionsTotal = sorted.reduce((s, x) => s + Number(x.extensionsTotal || 0), 0);
      const paidAmount  = sorted.reduce((s, x) => s + Number(x.paidAmount || 0), 0);
      // Entrance fee is on the lead row only for multi-room — sum
      // picks up whichever row carries it, which is correct.
      const entranceFee = sorted.reduce((s, x) => s + Number(x.entranceFee || 0), 0);
      const outstanding = Math.max(0, total + extensionsTotal + entranceFee - paidAmount);
      const fullyPaid   = sorted.every(x => x.fullyPaid);
      const names = sorted.map(x => x.roomType).filter(Boolean);
      const roomDisplay = names.length <= 2
        ? names.join(' + ')
        : `${names[0]} +${names.length - 1} more`;
      const topStatus = sorted
        .map(x => x.status)
        .sort((a, b) => (priority[a] || 99) - (priority[b] || 99))[0];
      return {
        ...lead,
        isGroup: true,
        groupRows: sorted,
        roomType: roomDisplay,
        total, extensionsTotal, paidAmount, entranceFee, outstanding, fullyPaid,
        status: topStatus,
      };
    });
  }, [sortedTodayAll]);

  // Pagination — same 25/page cap as Bookings. Page resets to 1 on
  // search/sort change so a narrowed list snaps back to the top
  // instead of stranding the user on a now-empty page.
  const { setPage, paginated, totalPages, safePage, info } = usePagination(collapsedTodayAll, 25);
  useEffect(() => { setPage(1); }, [searchTerm, sortBy, sortDir, setPage]);

  // Bookings awaiting balance collection: Confirmed/Checked In with any
  // outstanding balance. Using outstanding (derived from paidAmount) means
  // a booking that was fully paid, then had extra guests added, correctly
  // shows up here again.
  //
  // Sort: overdue rows first (a Checked-In whose checkOut already
  // passed is the most urgent collect — guest is physically still
  // there past their slot). Same isOverdue rule the main-table sort
  // uses (fb69c53), kept here so both surfaces agree on what counts
  // as overdue.
  const { todayConfirmed, todayCompleted, todayCancelled, revenueToday } = useMemo(() => {
    const outstandingFor = b =>
      Math.max(0, Number(b.total ?? 0) + Number(b.extensionsTotal ?? 0) + calcEntrance(b, entranceRates) - Number(b.paidAmount ?? 0));
    // "Awaiting payment collection" is strictly what the counter can
    // settle TODAY — a guest paid their online reservation fee for next
    // week has an outstanding balance, but there's nobody at the desk
    // to collect from. We require the arrival date to be today or
    // earlier. Checked-In rows are always billable (guest is here
    // regardless of their original arrival date). Confirmed rows must
    // have arrived today or earlier.
    const billableToday = (b) => {
      if (b.status === 'Checked In') return true;
      if (b.status !== 'Confirmed') return false;
      const arrival = b.checkIn?.slice(0, 10);
      return arrival && arrival <= today;
    };
    const todayConfirmed  = todayAll
      .filter(b => billableToday(b) && outstandingFor(b) > 0)
      .sort((a, b) => {
        const ao = isOverdue(a), bo = isOverdue(b);
        if (ao !== bo) return ao ? -1 : 1;
        return 0; // stable within tier
      });
    const todayCompleted  = todayAll.filter(b => b.status === 'Completed');
    const todayCancelled  = todayAll.filter(b => b.status === 'Cancelled');
    // Revenue = paid_amount (backend-maintained single source of truth).
    const revenueToday = todayAll.reduce((s, b) => s + Number(b.paidAmount ?? 0), 0);
    return { todayConfirmed, todayCompleted, todayCancelled, revenueToday };
  }, [todayAll, entranceRates, today]);

  // Future-arrival bookings that already have an outstanding balance.
  // Not shown in the primary "Awaiting Collection" queue — those are
  // what the counter can act on today — but staff needs a way to find
  // and pre-collect when a guest arrives early or asks to pay ahead.
  // Scoped to the next 14 days so the list stays useful; an older
  // future booking (rare) is still reachable via "Search past".
  const upcomingOutstanding = useMemo(() => {
    const outstandingFor = b =>
      Math.max(0, Number(b.total ?? 0) + Number(b.extensionsTotal ?? 0) + calcEntrance(b, entranceRates) - Number(b.paidAmount ?? 0));
    const horizon = new Date(today);
    horizon.setDate(horizon.getDate() + 14);
    return bookings
      .filter(b => {
        if (b.status !== 'Confirmed') return false;
        const arrival = b.checkIn?.slice(0, 10);
        if (!arrival || arrival <= today) return false;
        if (arrival > horizon.toISOString().slice(0, 10)) return false;
        return outstandingFor(b) > 0;
      })
      .sort((a, b) => (a.checkIn ?? '').localeCompare(b.checkIn ?? ''));
  }, [bookings, entranceRates, today]);

  // Click handler on the main Collect button. Validates then opens
  // the confirmation dialog — the actual API call lives in doCollect().
  function requestCollect() {
    if (!billing) return;
    const parsedAmount = amountInput.trim() === '' ? null : Number(amountInput);
    if (parsedAmount == null) {
      showToast('Enter the amount to collect.', 'error');
      return;
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      showToast('Enter a valid amount greater than 0.', 'error');
      return;
    }
    if (parsedAmount > billingOutstanding + 0.009) {
      showToast(`Amount cannot exceed outstanding balance (${fmtMoney(billingOutstanding)}).`, 'error');
      return;
    }
    if (payMethod === 'GCash' && gcashRef.trim().length < 1) {
      showToast('Enter the GCash reference number before collecting.', 'error');
      return;
    }
    setConfirmCollectOpen(true);
  }

  async function handleCollect() {
    if (!billing) return;
    // Re-parse — the dialog was shown against the current state, and
    // nothing else can mutate it while the dialog is open.
    const parsedAmount = amountInput.trim() === '' ? null : Number(amountInput);
    setConfirmCollectOpen(false);
    setPaying(true);
    try {
      const ef = calcEntrance(billing, entranceRates);
      const opts = {};
      if (parsedAmount != null) opts.amount = parsedAmount;
      if (payMethod === 'GCash') opts.gcashRef = gcashRef.trim();

      if (billing.isGroup) {
        const res = await collectReservationPayment(
          billing.reservationId,
          payMethod,
          Number(billing.entranceFee || 0) <= 0 ? ef : undefined,
          opts
        );
        // Partial path: the next /bookings poll gives us authoritative
        // paid_amount per sibling (proportional shares). Avoid guessing
        // here — just refetch from the response summary + clear the
        // modal. The row's own paidAmount in the list updates on the
        // next pull in ~20s. For FULL collect we keep the optimistic
        // flip so staff see the result immediately.
        if (parsedAmount == null) {
          const groupIds = new Set((billing.groupRows || []).map(r => r.bookingId));
          setBookings(prev =>
            prev.map(b => groupIds.has(b.bookingId)
              ? {
                  ...b,
                  fullyPaid:     true,
                  paymentMethod: payMethod,
                  paidAmount:    Number(b.total ?? 0) + Number(b.extensionsTotal ?? 0) + Number(b.entranceFee ?? 0),
                  status:        b.status === 'Confirmed' ? 'Checked In' : b.status,
                }
              : b)
          );
        } else {
          // Trigger a background refresh so the Billing list reflects
          // the proportional partial collect without the staff having
          // to wait for the next poll tick.
          getFdBookings().then(setBookings).catch(() => {});
        }
        setBilling(null);
        setSelected(null);
        showToast(res?.message || 'Payment collected.', 'success');
      } else {
        const res = await collectPayment(billing.bookingId, payMethod, ef, opts);
        const autoCheckedIn = !!res?.auto_checkedin;
        const fullyPaid     = res?.fully_paid !== false; // default true for legacy
        if (fullyPaid) {
          setBookings(prev =>
            prev.map(b => b.bookingId === billing.bookingId
              ? {
                  ...b,
                  fullyPaid:     true,
                  paymentMethod: payMethod,
                  entranceFee:   ef,
                  paidAmount:    Number(b.total ?? 0) + Number(b.extensionsTotal ?? 0) + ef,
                  status:        autoCheckedIn ? 'Checked In' : b.status,
                }
              : b)
          );
        } else {
          // Partial: trust backend's authoritative paid_amount via
          // next poll — but splash a quick optimistic paidAmount bump
          // so the row's "₱X paid" chip isn't stale for 20s.
          const newPaid = Number(res?.paid_amount ?? 0);
          setBookings(prev =>
            prev.map(b => b.bookingId === billing.bookingId
              ? {
                  ...b,
                  paymentMethod: payMethod,
                  entranceFee:   ef,
                  paidAmount:    newPaid > 0 ? newPaid : Number(b.paidAmount ?? 0) + parsedAmount,
                }
              : b)
          );
          getFdBookings().then(setBookings).catch(() => {});
        }
        setBilling(null);
        setSelected(null);
        showToast(res?.message || 'Payment collected successfully!', 'success');
      }
    } catch (err) {
      const msg = err?.response?.data?.message || 'Failed to collect payment. Please try again.';
      showToast(msg, 'error');
    } finally {
      setPaying(false);
    }
  }

  async function handleDownloadReceipt(bookingId, resId) {
    setDownloading(bookingId);
    try {
      const blob = await downloadStaffReceipt(bookingId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${resId ?? bookingId}-booking-confirmation.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      showToast('Failed to download confirmation. Please try again.', 'error');
    } finally {
      setDownloading(null);
    }
  }

  function openCollect(b) {
    setSelected(null);
    setBilling(b);
    setPayMethod('Cash');
    setAmountInput('');
    setGcashRef('');
  }

  // Outstanding for the collect-payment modal = grand total - paid_amount.
  // Uses backend-maintained paidAmount so it correctly reflects staged
  // collections (reservation fee online, then balance + entrance at the
  // counter, then deltas when fees change post-payment).
  const billingEntrance    = billing ? calcEntrance(billing, entranceRates) : 0;
  const billingExtensions  = billing ? Number(billing.extensionsTotal ?? 0) : 0;
  const billingGrandTotal  = billing ? Number(billing.total ?? 0) + billingExtensions + billingEntrance : 0;
  const billingPaidSoFar   = billing ? Number(billing.paidAmount ?? 0) : 0;
  const billingOutstanding = Math.max(0, billingGrandTotal - billingPaidSoFar);

  // ─── render ───────────────────────────────────────────────────────────────────
  return (
    <Shell>
      <Helmet><title>Billing — Frontdesk</title></Helmet>
      <Toast message={toast} type={toastType} onClose={clearToast} />

      {/* ── Detail Drawer ── */}
      <BillingDetailDrawer
        booking={selected}
        onClose={() => setSelected(null)}
        onCollect={openCollect}
        onDownloadReceipt={(id) => handleDownloadReceipt(id, selected?.id)}
        downloading={downloading}
        entranceRates={entranceRates}
      />

      {/* ── Payment Collection Modal ── */}
      <Modal open={!!billing} onClose={() => setBilling(null)} maxWidth="max-w-md" labelledBy="collect-title">
        {billing && (
          <div className="p-6">
              <div className="flex justify-between items-center mb-4">
                <h3 id="collect-title" className="text-lg font-semibold">Collect Payment — {billing.id}</h3>
                <button
                  onClick={() => setBilling(null)}
                  className="inline-flex w-11 h-11 items-center justify-center rounded text-slate-600 hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                  aria-label="Close collect payment dialog"
                >
                  <i className="fas fa-times" aria-hidden="true"></i>
                </button>
              </div>

              {/* Guest summary */}
              <div className="p-4 bg-slate-50 rounded mb-4 text-sm">
                <p className="font-medium text-slate-800">{billing.guest}</p>
                <p className="text-slate-600">{billing.roomType} · {billing.guests} pax</p>
                <p className="text-slate-500 text-xs mt-1">
                  {fmtDateTime(billing.checkIn)} → {fmtDateTime(billing.checkOut)}
                </p>
              </div>

              {/* Bill breakdown */}
              {(() => {
                const bAmenityTotal = (billing.amenities ?? []).reduce((s, a) => s + Number(a.total ?? (a.unitPrice * a.qty) ?? 0), 0);
                const bDiscount     = Number(billing.discount ?? 0);
                const bRoomRate     = Number(billing.total ?? 0) + bDiscount - bAmenityTotal;
                return (
                  <div className="border rounded mb-4 text-sm overflow-hidden">
                    <div className="flex justify-between px-4 py-2.5 border-b">
                      <span className="text-slate-600">Room Rate</span>
                      <span>{fmtMoney(bRoomRate)}</span>
                    </div>
                    {billing.amenities?.length > 0 && billing.amenities.map((a, i) => (
                      <div key={i} className="flex justify-between px-4 py-2 border-b text-slate-600">
                        <span>{a.name} × {a.qty}</span>
                        <span>{fmtMoney(a.total ?? (a.unitPrice * a.qty))}</span>
                      </div>
                    ))}
                    {bDiscount > 0 && (
                      <div className="flex justify-between px-4 py-2 border-b text-emerald-700">
                        <span><i className="fas fa-tag mr-1 text-xs"></i>Promo{billing.promoCode ? ` (${billing.promoCode})` : ''}</span>
                        <span>− {fmtMoney(bDiscount)}</span>
                      </div>
                    )}
                    {billingEntrance > 0 && (
                      <div className="flex justify-between px-4 py-2.5 border-b bg-amber-50 text-amber-800 text-xs">
                        <span className="flex items-center gap-1.5">
                          <i className="fas fa-ticket-alt"></i>
                          Entrance Fee ({billing.guests} pax × ₱{entranceRates[billing.bookingType ?? 'day'] ?? 50})
                        </span>
                        <span className="font-semibold">{fmtMoney(billingEntrance)}</span>
                      </div>
                    )}
                    <div className="flex justify-between px-4 py-3 bg-slate-800 text-white font-bold text-base">
                      <span>Grand Total</span>
                      <span>{fmtMoney(billingGrandTotal)}</span>
                    </div>
                    {billingPaidSoFar > 0 && (
                      <div className="flex justify-between px-4 py-2.5 border-t text-emerald-700">
                        <span>Paid so far</span>
                        <span>− {fmtMoney(billingPaidSoFar)}</span>
                      </div>
                    )}
                    {(() => {
                      const parsedAmt = amountInput.trim() === '' ? null : Number(amountInput);
                      const hasAmt = Number.isFinite(parsedAmt) && parsedAmt > 0;
                      return (
                        <div className="flex justify-between px-4 py-3 bg-sky-600 text-white font-bold text-base">
                          <span>Collect Now</span>
                          <span>{hasAmt ? fmtMoney(Math.min(parsedAmt, billingOutstanding)) : '—'}</span>
                        </div>
                      );
                    })()}
                  </div>
                );
              })()}

              {/* Payment amount — partial payments allowed. Blank
                  defaults to full outstanding (the common case).
                  A typed value must be > 0 and ≤ outstanding. */}
              <div className="mb-4">
                <div className="flex items-baseline justify-between mb-1">
                  <label htmlFor="collect-amount" className="block text-sm font-medium text-slate-700">
                    Amount to Collect
                  </label>
                  <button
                    type="button"
                    onClick={() => setAmountInput(String(billingOutstanding.toFixed(2)))}
                    className="text-xs text-sky-600 hover:text-sky-700 underline underline-offset-2"
                  >
                    Full balance ({fmtMoney(billingOutstanding)})
                  </button>
                </div>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm pointer-events-none">₱</span>
                  <input
                    id="collect-amount"
                    type="number"
                    inputMode="decimal"
                    min="0.01"
                    step="0.01"
                    max={billingOutstanding}
                    placeholder={`${billingOutstanding.toFixed(2)} (leave blank for full balance)`}
                    value={amountInput}
                    onChange={(e) => setAmountInput(e.target.value)}
                    className="w-full pl-7 pr-3 py-2.5 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
                  />
                </div>
                {amountInput.trim() !== '' && Number(amountInput) > 0 && Number(amountInput) < billingOutstanding - 0.009 && (
                  <p className="mt-1 text-xs text-amber-700">
                    <i className="fas fa-info-circle mr-1"></i>
                    Partial payment — remaining balance of {fmtMoney(billingOutstanding - Number(amountInput))} stays due.
                  </p>
                )}
              </div>

              {/* Payment method */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-700 mb-1">Payment Method</label>
                <div className="flex gap-2">
                  {[
                    { value: 'Cash',  icon: 'fa-money-bill-wave', color: 'text-emerald-600' },
                    { value: 'GCash', icon: 'fa-mobile-alt',      color: 'text-sky-500'  },
                  ].map(opt => (
                    <button key={opt.value} type="button"
                      onClick={() => { setPayMethod(opt.value); if (opt.value !== 'GCash') setGcashRef(''); }}
                      className={`flex-1 flex items-center justify-center gap-2 py-2 border rounded text-sm font-medium transition-colors ${
                        payMethod === opt.value
                          ? 'border-sky-500 bg-sky-50 text-sky-700'
                          : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <i className={`fas ${opt.icon} ${payMethod === opt.value ? '' : opt.color}`}></i>
                      {opt.value}
                    </button>
                  ))}
                </div>
              </div>

              {/* GCash reference — required when GCash is chosen.
                  Guest scans the resort's QR on their own phone, so
                  PayMongo isn't in the loop; staff types the ref they
                  see on the guest's confirmation screen. */}
              {payMethod === 'GCash' && (
                <div className="mb-6">
                  <label htmlFor="collect-gcash-ref" className="block text-sm font-medium text-slate-700 mb-1">
                    GCash Reference Number <span className="text-rose-600">*</span>
                  </label>
                  <input
                    id="collect-gcash-ref"
                    type="text"
                    placeholder="e.g. 1234 567 8901"
                    value={gcashRef}
                    onChange={(e) => setGcashRef(e.target.value)}
                    className="w-full px-3 py-2.5 border border-slate-300 rounded text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
                    autoComplete="off"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    <i className="fas fa-mobile-alt mr-1 text-sky-500"></i>
                    From the guest's GCash confirmation screen. Saved to the receipt.
                  </p>
                </div>
              )}
              {payMethod !== 'GCash' && <div className="mb-6"></div>}

              {(() => {
                const parsed = amountInput.trim() === '' ? null : Number(amountInput);
                const hasAmt = parsed != null && Number.isFinite(parsed) && parsed > 0;
                const invalidAmt = parsed != null && (!Number.isFinite(parsed) || parsed <= 0 || parsed > billingOutstanding + 0.009);
                const missingRef = payMethod === 'GCash' && gcashRef.trim().length < 1;
                const disabled = paying || !hasAmt || invalidAmt || missingRef;
                return (
                  <div className="flex justify-end gap-3">
                    <button onClick={() => setBilling(null)}
                      type="button"
                      className="min-h-11 px-4 py-2.5 border border-slate-200 rounded text-sm text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1">
                      Cancel
                    </button>
                    <button onClick={requestCollect} disabled={disabled}
                      type="button"
                      className="inline-flex items-center gap-1 min-h-11 px-4 py-2.5 bg-emerald-600 text-white rounded text-sm font-semibold hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1">
                      <i className="fas fa-check" aria-hidden="true"></i>
                      {paying ? 'Processing...' : hasAmt ? `Collect ${fmtMoney(parsed)}` : 'Collect'}
                    </button>
                  </div>
                );
              })()}
          </div>
        )}
      </Modal>

      {/* Two-step confirm for the collect action. Variant depends on
          whether this is a partial (warning — the booking stays open
          with a remaining balance) or a full settle (info — the booking
          closes out and Confirmed rows auto-check-in). */}
      {billing && (() => {
        const parsed  = Number(amountInput);
        const hasAmt  = Number.isFinite(parsed) && parsed > 0;
        const amount  = hasAmt ? Math.min(parsed, billingOutstanding) : 0;
        const isFull  = hasAmt && amount >= billingOutstanding - 0.009;
        const remain  = Math.max(0, billingOutstanding - amount);
        const willAutoCheckIn = isFull && !billing.isGroup && billing.status === 'Confirmed';
        const parts = [];
        parts.push(`Collect ${fmtMoney(amount)} from ${billing.guest}`);
        parts.push(`for ${billing.id} via ${payMethod}${payMethod === 'GCash' ? ` (ref ${gcashRef.trim()})` : ''}.`);
        if (!isFull) parts.push(`Remaining balance: ${fmtMoney(remain)}.`);
        if (willAutoCheckIn) parts.push('Guest will be checked in automatically.');
        parts.push('This cannot be undone.');
        return (
          <ConfirmDialog
            open={confirmCollectOpen}
            variant={isFull ? 'info' : 'warning'}
            title={isFull ? 'Confirm Payment Collection' : 'Confirm Partial Payment'}
            message={parts.join(' ')}
            confirmLabel={`Collect ${fmtMoney(amount)}`}
            cancelLabel="Go back"
            onConfirm={handleCollect}
            onCancel={() => setConfirmCollectOpen(false)}
          />
        );
      })()}

      {/* ── Main ── */}
      <main className="p-6">
        {/* Summary cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-lg shadow p-5 flex items-center">
            <div className="p-3 rounded-full bg-sky-100 text-sky-600 mr-4">
              <i className="fas fa-file-invoice-dollar text-xl"></i>
            </div>
            <div>
              <p className="text-slate-500 text-sm">Awaiting Collection</p>
              <h3 className="text-2xl font-bold">{loading ? '—' : todayConfirmed.length}</h3>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-5 flex items-center">
            <div className="p-3 rounded-full bg-emerald-100 text-emerald-600 mr-4">
              <i className="fas fa-check-circle text-xl"></i>
            </div>
            <div>
              <p className="text-slate-500 text-sm">Completed Today</p>
              <h3 className="text-2xl font-bold">{loading ? '—' : todayCompleted.length}</h3>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-5 flex items-center">
            <div className="p-3 rounded-full bg-purple-100 text-purple-600 mr-4">
              <i className="fas fa-peso-sign text-xl"></i>
            </div>
            <div>
              <p className="text-slate-500 text-sm">Revenue Today</p>
              <h3 className="text-xl font-bold">
                {loading ? '—' : fmtMoney(revenueToday)}
              </h3>
            </div>
          </div>
        </div>

        {error && (
          <div role="alert" aria-live="assertive" className="mb-4 p-3 bg-rose-50 text-rose-700 rounded text-sm">
            <i className="fas fa-exclamation-circle mr-2" aria-hidden="true"></i>{error}
          </div>
        )}

        {/* Awaiting payment */}
        {!loading && todayConfirmed.length > 0 && (
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-lg font-semibold mb-4 text-sky-700">
              <i className="fas fa-exclamation-circle mr-2" aria-hidden="true"></i>
              Awaiting Payment Collection ({todayConfirmed.length})
            </h2>
            <ul className="space-y-3">
              {todayConfirmed.map(b => {
                const paid       = Number(b.paidAmount ?? 0);
                const grand      = Number(b.total ?? 0) + Number(b.extensionsTotal ?? 0) + calcEntrance(b, entranceRates);
                const toCollect  = Math.max(0, grand - paid);
                const guestLabel = walkInName(b);
                const openDetail = () => setSelected(b);
                // Overdue = checked-in and scheduled checkout has already
                // passed. Parallel to the Bookings / Dashboard definition.
                // Confirmed bookings can't be overdue (haven't arrived yet),
                // so this is effectively only meaningful for Checked In.
                const overdue = b.status === 'Checked In' && b.checkOut
                  && new Date(String(b.checkOut).replace(' ', 'T')) < new Date();
                const cardCls = overdue
                  ? 'flex items-center gap-3 p-4 border border-rose-300 rounded-lg bg-rose-50 cursor-pointer hover:bg-rose-100 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-1'
                  : 'flex items-center gap-3 p-4 border rounded-lg bg-sky-50 cursor-pointer hover:bg-sky-100 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1';
                return (
                  <li key={b.bookingId}>
                    {/* role="button" + keydown handler turns the card into
                        a keyboard-activatable region. The nested Collect
                        button uses stopPropagation so Enter on it won't
                        also open the detail modal. Rose styling takes over
                        when the checked-in guest's scheduled checkout has
                        already passed — staff should chase the room. */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={openDetail}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(); } }}
                      aria-label={`View billing detail for ${b.id}, ${guestLabel}${overdue ? ' — overdue checkout' : ''}`}
                      className={cardCls}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium">{guestLabel}</p>
                          {overdue && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500 text-white">
                              <i className="fas fa-triangle-exclamation text-[9px]" aria-hidden="true"></i>OVERDUE
                            </span>
                          )}
                          {/* Booking ID shown as quiet mono text so staff can
                              reference it verbally ("APL-…0003") when
                              confirming the room with a guest, without the
                              ID pulling visual weight from the guest name. */}
                          <span className="text-[11px] font-mono text-slate-500">{b.id}</span>
                        </div>
                        <p className="text-sm text-slate-600">{b.roomType} · {b.guests} pax</p>
                        <p className={`text-xs ${overdue ? 'text-rose-600 font-medium' : 'text-slate-500'}`}>
                          {fmtDateTime(b.checkIn)} → {fmtDateTime(b.checkOut)}
                          {overdue && ' (past checkout)'}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-slate-500">Total to Collect</p>
                        <p className={`font-bold text-lg ${overdue ? 'text-rose-700' : 'text-sky-700'}`}>
                          {fmtMoney(toCollect)}
                        </p>
                        {paid > 0 && (
                          <p className="text-[11px] text-slate-500">
                            ({fmtMoney(paid)} paid)
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); openCollect(b); }}
                          onKeyDown={(e) => e.stopPropagation()}
                          aria-label={`Collect ${fmtMoney(toCollect)} for ${b.id}`}
                          className="mt-2 inline-flex items-center gap-1 min-h-11 px-4 py-1.5 bg-emerald-600 text-white rounded text-sm font-semibold hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1"
                        >
                          <i className="fas fa-hand-holding-usd" aria-hidden="true"></i>Collect
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Upcoming prepayments — collapsible. Shown when at least one
            future-arrival booking has an outstanding balance. Collapsed
            by default so the today-queue view stays uncluttered; one
            click to expand when a guest shows up early. */}
        {!loading && upcomingOutstanding.length > 0 && (
          <div className="bg-white rounded-lg shadow mb-6 overflow-hidden">
            <button
              type="button"
              onClick={() => setUpcomingOpen(o => !o)}
              className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-inset"
              aria-expanded={upcomingOpen}
              aria-controls="upcoming-outstanding-list"
            >
              <div className="flex items-center gap-3 min-w-0">
                <i className="fas fa-calendar-plus text-slate-400" aria-hidden="true"></i>
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-slate-700">
                    Upcoming Prepayments
                    <span className="ml-2 inline-flex items-center justify-center rounded-full bg-slate-100 text-slate-700 text-xs font-medium px-2 py-0.5">
                      {upcomingOutstanding.length}
                    </span>
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Future bookings with an outstanding balance. Settle early only if the guest is here.
                  </p>
                </div>
              </div>
              <i className={`fas ${upcomingOpen ? 'fa-chevron-up' : 'fa-chevron-down'} text-slate-400 shrink-0`} aria-hidden="true"></i>
            </button>
            {upcomingOpen && (
              <ul id="upcoming-outstanding-list" className="border-t border-slate-100 divide-y divide-slate-100">
                {upcomingOutstanding.map(b => {
                  const paid       = Number(b.paidAmount ?? 0);
                  const grand      = Number(b.total ?? 0) + Number(b.extensionsTotal ?? 0) + calcEntrance(b, entranceRates);
                  const toCollect  = Math.max(0, grand - paid);
                  const guestLabel = walkInName(b);
                  const openDetail = () => setSelected(b);
                  return (
                    <li
                      key={b.bookingId}
                      role="button"
                      tabIndex={0}
                      onClick={openDetail}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(); } }}
                      aria-label={`View billing detail for ${b.id}, ${guestLabel}, arriving ${fmtDate(b.checkIn)}`}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-inset"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium text-slate-800">{guestLabel}</p>
                          <span className="text-[11px] font-mono text-slate-500">{b.id}</span>
                        </div>
                        <p className="text-sm text-slate-600">{b.roomType} · {b.guests} pax</p>
                        <p className="text-xs text-slate-500">
                          Arrives {fmtDateTime(b.checkIn)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-slate-500">Outstanding</p>
                        <p className="font-bold text-slate-700">{fmtMoney(toCollect)}</p>
                        {paid > 0 && (
                          <p className="text-[11px] text-slate-500">
                            ({fmtMoney(paid)} paid)
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); openCollect(b); }}
                          onKeyDown={(e) => e.stopPropagation()}
                          aria-label={`Collect ${fmtMoney(toCollect)} for ${b.id}`}
                          className="mt-2 inline-flex items-center gap-1 min-h-11 px-3 py-1.5 border border-emerald-600 text-emerald-700 bg-white rounded text-sm font-semibold hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1"
                        >
                          <i className="fas fa-hand-holding-usd" aria-hidden="true"></i>Collect Early
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {/* Today's table — recent 7 days + in-progress stays */}
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex flex-wrap gap-3 mb-4 items-center">
            <div>
              <h2 className="text-lg font-semibold">Today's Billing Summary</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Last 7 days + in-progress stays. Looking for something older? Use <strong>Search past</strong>.
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <div className="relative">
                <input type="text" aria-label="Filter this list" placeholder="Filter this list…"
                  value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                  className="border border-slate-200 rounded-lg pl-9 pr-3 py-2 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-sky-400" />
                <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
              </div>
              <button type="button" onClick={() => setSearchPanelOpen(true)}
                className="px-3 py-2 text-sm rounded-lg border border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100 flex items-center gap-1.5"
                title="Search bookings older than 7 days">
                <i className="fas fa-clock-rotate-left text-xs"></i>
                Search past
              </button>
            </div>
          </div>

          {loading ? (
            <div className="py-10 text-center text-slate-400">
              <i className="fas fa-spinner fa-spin text-2xl mb-2 block"></i>Loading...
            </div>
          ) : isSearching && searchedTodayAll.length === 0 ? (
            <div className="py-10 text-center text-slate-400">
              <i className="fas fa-search text-2xl mb-2 block opacity-50"></i>
              <p>No matches in the last 7 days for "<strong>{searchTerm}</strong>".</p>
              <button type="button" onClick={() => { setSearchTerm(''); setPastQuery(searchTerm); setSearchPanelOpen(true); runPastSearch(); }}
                className="mt-2 text-sky-600 hover:underline text-sm">
                Search older bookings instead →
              </button>
            </div>
          ) : !isSearching && todayAll.length === 0 ? (
            <p className="text-slate-400 text-center py-6">No bookings for today.</p>
          ) : (
          <>
            {/* Desktop table — same shape as before, wrapped so that the
                mobile card list below is the only one visible <md. The
                eight-column grid crushes badly on phones; the cards
                preserve the same fields without horizontal scrolling.
                Action column has multiple states (Collect / Paid /
                Awaiting / Confirmation / Cancelled) — those move into
                the card footer in the mobile view, with stopPropagation
                so they don't also trigger the row's setSelected. */}
            <div className="hidden md:block overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    {/* Sortable headers with aria-sort + descriptive
                        aria-label so screen readers announce "Sort by
                        Guest, currently ascending" etc. Non-sorted columns
                        just say "Sort by Guest" — "currently none" reads
                        awkwardly. */}
                    {[['Booking ID','Booking ID'],['Guest','Guest'],['Room','Room'],['Time Slot','Time Slot'],['Booking Total','Booking Total'],['Payment','To Collect'],['Status','Status']].map(([label,key]) => {
                      const isSorted = sortBy === key;
                      const ariaSort = isSorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
                      return (
                        <th
                          key={key}
                          scope="col"
                          aria-sort={ariaSort}
                          className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase"
                        >
                          <button
                            onClick={() => { if(sortBy===key) setSortDir(d=>d==='asc'?'desc':'asc'); else{setSortBy(key);setSortDir('asc');} }}
                            aria-label={isSorted ? `Sort by ${label}, currently ${ariaSort}` : `Sort by ${label}`}
                            className="flex items-center gap-1 hover:text-sky-700 transition-colors group focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded"
                          >
                            {label}
                            <span className="text-slate-400 group-hover:text-sky-400" aria-hidden="true">
                              {isSorted ? <i className={`fas fa-arrow-${sortDir==='asc'?'up':'down'} text-sky-500`}></i> : <i className="fas fa-sort opacity-40"></i>}
                            </span>
                          </button>
                        </th>
                      );
                    })}
                    <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {paginated.map(b => {
                    const guestLabel = walkInName(b);
                    return (
                      <tr key={b.bookingId}
                        className="hover:bg-slate-50 cursor-pointer"
                        onClick={() => setSelected(b)}
                      >
                        <td className="px-4 py-3 text-xs whitespace-nowrap">
                          {/* Native button = keyboard-activatable primary
                              action for opening the detail modal. Matches
                              the Bookings page pattern. */}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setSelected(b); }}
                            className="font-mono text-slate-700 hover:text-sky-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded px-1"
                            aria-label={`View billing detail for ${b.id}, guest ${guestLabel}`}
                          >
                            {b.isGroup ? (b.reservationResId || b.id) : b.id}
                          </button>
                          {Number(b.groupSize ?? 1) > 1 && (
                            <div
                              className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-800 text-[10px] font-semibold"
                              title={`Reservation with ${b.groupSize} rooms — collect clears the whole group`}
                            >
                              <i className="fas fa-layer-group text-[9px]" aria-hidden="true"></i>
                              Group of {b.groupSize}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm font-medium">{guestLabel}</td>
                        <td className="px-4 py-3 text-sm text-slate-600">{b.roomType}</td>
                        <td className="px-4 py-3 text-xs text-slate-600 whitespace-nowrap">
                          {fmtDateTime(b.checkIn)}<br />
                          <span className="text-slate-400">→ {fmtDateTime(b.checkOut)}</span>
                        </td>
                        <td className="px-4 py-3 text-sm">{fmtMoney(b.total)}</td>
                        <td className="px-4 py-3">
                          <PaymentCell booking={b} entranceRates={entranceRates} />
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={b.status} /></td>
                        <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                          {/* Pills use min-h-11 so tap targets clear
                              the WCAG 2.5.8 AA floor (24px) with comfortable
                              margin for tablet/phone use. aria-labels name the
                              booking so title tooltips aren't the only
                              affordance for assistive tech. */}
                          <div className="flex items-center gap-2 flex-wrap">
                            {b.status === 'Confirmed' && !b.fullyPaid && (
                              <button
                                onClick={() => openCollect(b)}
                                aria-label={`Collect payment for ${b.id}`}
                                className="inline-flex items-center gap-1 min-h-11 px-3 py-1.5 bg-emerald-600 text-white rounded text-xs font-semibold hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                              >
                                <i className="fas fa-coins text-[11px]" aria-hidden="true"></i>Collect
                              </button>
                            )}
                            {b.status === 'Confirmed' && b.fullyPaid && (
                              <span className="inline-flex items-center gap-1 min-h-11 px-3 py-1.5 text-xs text-emerald-700 font-medium">
                                <i className="fas fa-check-circle" aria-hidden="true"></i>Paid — awaiting check-in
                              </span>
                            )}
                            {b.status === 'Pending' && (
                              <span
                                aria-label="Awaiting payment clearance"
                                className="inline-flex items-center gap-1 min-h-11 px-3 py-1.5 text-xs text-amber-700 bg-amber-50 rounded font-medium"
                              >
                                <i className="fas fa-hourglass-half text-[11px]" aria-hidden="true"></i>Awaiting payment
                              </span>
                            )}
                            {b.status !== 'Pending' && !(b.status === 'Cancelled' && Number(b.paidAmount ?? 0) <= 0) && (
                              <button
                                onClick={() => handleDownloadReceipt(b.bookingId, b.id)}
                                disabled={downloading === b.bookingId}
                                aria-label={`Download booking confirmation PDF for ${b.id}`}
                                className="inline-flex items-center gap-1 min-h-11 px-3 py-2 bg-sky-600 text-white rounded text-xs font-semibold hover:bg-sky-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1"
                                title="Download booking confirmation (PDF)"
                              >
                                <i className={`fas ${downloading === b.bookingId ? 'fa-spinner fa-spin' : 'fa-file-pdf'} text-[11px]`} aria-hidden="true"></i>
                                Confirmation
                              </button>
                            )}
                            {b.status === 'Cancelled' && (
                              <span className="inline-flex items-center gap-1 min-h-11 px-3 py-1.5 text-xs text-rose-600">
                                <i className="fas fa-ban" aria-hidden="true"></i>Cancelled
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-slate-50 text-sm font-semibold">
                  <tr>
                    <td colSpan={4} className="px-4 py-3 text-right text-slate-600">
                      <span className="inline-flex items-center gap-1.5">
                        Billed
                        <i
                          className="fas fa-circle-info text-slate-400 text-[11px] cursor-help"
                          title="Excludes cancelled and pending bookings. Entrance fees are collected at the gate and tracked separately."
                          aria-label="Excludes cancelled and pending bookings. Entrance fees are collected at the gate and tracked separately."
                        ></i>
                        :
                      </span>
                    </td>
                    {/* Sum just b.total so the footer matches the visible
                        column cells (which also show b.total). */}
                    <td className="px-4 py-3">
                      {fmtMoney(todayAll.filter(b => !['Cancelled', 'Pending'].includes(b.status)).reduce((s, b) => s + Number(b.total || 0), 0))}
                    </td>
                    <td className="px-4 py-3 text-emerald-700">
                      {fmtMoney(revenueToday)} earned
                    </td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Mobile card list — same booking set, card layout. Action
                buttons stay inline (Collect is the primary daily counter
                action, so hiding it behind a modal would slow staff
                down). Whole-card click opens the detail drawer; the
                action button cluster stops propagation. */}
            <ul className="md:hidden space-y-3">
              {paginated.map(b => {
                const guestLabel = walkInName(b);
                const isResolved = b.status === 'Cancelled' || b.status === 'Completed' || b.status === 'No-Show';
                const cardCls = [
                  'rounded-xl border bg-white shadow-sm transition cursor-pointer',
                  b.status === 'Confirmed' && !b.fullyPaid
                    ? 'border-l-4 border-l-emerald-400 border-emerald-100 hover:bg-emerald-50/40'
                    : b.status === 'Pending'
                      ? 'border-l-4 border-l-amber-400 border-amber-100 hover:bg-amber-50/40'
                      : 'border-slate-200 hover:bg-slate-50',
                  isResolved ? 'opacity-70' : '',
                ].filter(Boolean).join(' ');
                return (
                  <li key={b.bookingId}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelected(b)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(b); } }}
                      className={cardCls + ' p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500'}
                      aria-label={`View billing detail for ${b.id}, guest ${guestLabel}`}
                    >
                      {/* Top — guest + total */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-base font-semibold text-slate-900 truncate">{guestLabel}</p>
                          <p className="text-xs font-mono text-slate-500 mt-0.5 truncate">
                            {b.isGroup ? (b.reservationResId || b.id) : b.id}
                          </p>
                          {Number(b.groupSize ?? 1) > 1 && (
                            <span className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-800 text-[10px] font-semibold">
                              <i className="fas fa-layer-group text-[9px]" aria-hidden="true"></i>
                              Group of {b.groupSize}
                            </span>
                          )}
                        </div>
                        <div className="shrink-0 flex flex-col items-end gap-1.5">
                          <p className="text-sm font-semibold text-slate-800">{fmtMoney(b.total)}</p>
                          <StatusBadge status={b.status} />
                        </div>
                      </div>

                      {/* Body — Room / Time Slot */}
                      <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-slate-100">
                        <div className="min-w-0">
                          <p className="text-[10px] uppercase font-semibold text-slate-400 tracking-wide">Room</p>
                          <p className="text-sm text-slate-700 mt-0.5 truncate">{b.roomType}</p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[10px] uppercase font-semibold text-slate-400 tracking-wide">Time</p>
                          <p className="text-sm text-slate-700 mt-0.5">
                            {fmtDateTime(b.checkIn)}
                            <span className="block text-xs text-slate-400">→ {fmtDateTime(b.checkOut)}</span>
                          </p>
                        </div>
                        <div className="col-span-2">
                          <p className="text-[10px] uppercase font-semibold text-slate-400 tracking-wide mb-1">Payment</p>
                          <PaymentCell booking={b} entranceRates={entranceRates} />
                        </div>
                      </div>

                      {/* Action cluster — mirrors the desktop Action
                          column. stopPropagation so tapping a button
                          doesn't also open the detail drawer. */}
                      <div
                        className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2 flex-wrap"
                        onClick={e => e.stopPropagation()}
                      >
                        {b.status === 'Confirmed' && !b.fullyPaid && (
                          <button
                            onClick={() => openCollect(b)}
                            aria-label={`Collect payment for ${b.id}`}
                            className="inline-flex items-center gap-1 min-h-11 px-3 py-1.5 bg-emerald-600 text-white rounded text-xs font-semibold hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                          >
                            <i className="fas fa-coins text-[11px]" aria-hidden="true"></i>Collect
                          </button>
                        )}
                        {b.status === 'Confirmed' && b.fullyPaid && (
                          <span className="inline-flex items-center gap-1 min-h-11 px-3 py-1.5 text-xs text-emerald-700 font-medium">
                            <i className="fas fa-check-circle" aria-hidden="true"></i>Paid — awaiting check-in
                          </span>
                        )}
                        {b.status === 'Pending' && (
                          <span
                            aria-label="Awaiting payment clearance"
                            className="inline-flex items-center gap-1 min-h-11 px-3 py-1.5 text-xs text-amber-700 bg-amber-50 rounded font-medium"
                          >
                            <i className="fas fa-hourglass-half text-[11px]" aria-hidden="true"></i>Awaiting payment
                          </span>
                        )}
                        {b.status !== 'Pending' && !(b.status === 'Cancelled' && Number(b.paidAmount ?? 0) <= 0) && (
                          <button
                            onClick={() => handleDownloadReceipt(b.bookingId, b.id)}
                            disabled={downloading === b.bookingId}
                            aria-label={`Download booking confirmation PDF for ${b.id}`}
                            className="inline-flex items-center gap-1 min-h-11 px-3 py-2 bg-sky-600 text-white rounded text-xs font-semibold hover:bg-sky-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1"
                            title="Download booking confirmation (PDF)"
                          >
                            <i className={`fas ${downloading === b.bookingId ? 'fa-spinner fa-spin' : 'fa-file-pdf'} text-[11px]`} aria-hidden="true"></i>
                            Confirmation
                          </button>
                        )}
                        {b.status === 'Cancelled' && (
                          <span className="inline-flex items-center gap-1 min-h-11 px-3 py-1.5 text-xs text-rose-600">
                            <i className="fas fa-ban" aria-hidden="true"></i>Cancelled
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* Mobile summary — replaces the desktop <tfoot>. Sums the
                same set: excludes Cancelled + Pending, matching the
                visible "Booking Total" column. "earned" tracks
                revenueToday so the two figures stay in sync with
                desktop. */}
            <div className="md:hidden mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-600 inline-flex items-center gap-1.5 font-medium">
                  Billed
                  <i
                    className="fas fa-circle-info text-slate-400 text-[11px]"
                    title="Excludes cancelled and pending bookings. Entrance fees are collected at the gate and tracked separately."
                    aria-label="Excludes cancelled and pending bookings. Entrance fees are collected at the gate and tracked separately."
                  ></i>
                </span>
                <span className="font-semibold text-slate-800">
                  {fmtMoney(todayAll.filter(b => !['Cancelled', 'Pending'].includes(b.status)).reduce((s, b) => s + Number(b.total || 0), 0))}
                </span>
              </div>
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-200">
                <span className="text-slate-600 font-medium">Earned</span>
                <span className="font-semibold text-emerald-700">{fmtMoney(revenueToday)}</span>
              </div>
            </div>

            {/* Pagination — sits below both desktop table + mobile
                cards so it controls the slice on every viewport. The
                Billed/Earned summary above always reflects the FULL
                day (not just the current page) — those totals are
                computed from todayAll, not the paginated subset. */}
            <PaginationBar
              safePage={safePage}
              totalPages={totalPages}
              onPageChange={setPage}
              info={info}
            />
          </>
          )}
        </div>
      </main>

      {/* ── Search past billings — side panel (no auto-refresh) ─────── */}
      {searchPanelOpen && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setSearchPanelOpen(false)} />
          <aside
            ref={searchPanelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="past-search-title"
            tabIndex={-1}
            className="fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-2xl flex flex-col z-50 border-l border-slate-200 focus:outline-none"
          >
            <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3 bg-slate-50">
              <div className="flex-1">
                <h3 id="past-search-title" className="font-semibold text-slate-800 flex items-center gap-2">
                  <i className="fas fa-clock-rotate-left text-sky-600" aria-hidden="true"></i>
                  Search Past Billings
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Finds any booking — past or present. No auto-refresh.
                </p>
              </div>
              <button
                onClick={() => setSearchPanelOpen(false)}
                className="inline-flex w-11 h-11 items-center justify-center rounded text-slate-600 hover:bg-slate-200 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                aria-label="Close search past billings panel"
              >
                <i className="fas fa-times" aria-hidden="true"></i>
              </button>
            </div>

            <form onSubmit={runPastSearch} className="px-5 py-3 border-b border-slate-100">
              <div className="relative">
                <input
                  type="text"
                  autoFocus
                  placeholder="Guest name, booking ID, email, phone, room…"
                  value={pastQuery}
                  onChange={e => setPastQuery(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg pl-9 pr-24 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
                />
                <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
                <button type="submit" disabled={!pastQuery.trim() || pastLoading}
                  className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center min-h-11 px-4 py-2 bg-sky-600 text-white rounded-md text-xs font-medium hover:bg-sky-700 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1">
                  {pastLoading ? <i className="fas fa-spinner fa-spin" aria-hidden="true"></i> : 'Search'}
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-2">
                Enter at least part of the guest name, booking ID (e.g. APL-20260417-0001), or contact info.
              </p>
            </form>

            <div className="flex-1 overflow-y-auto px-5 py-3">
              {!pastSearched && !pastLoading && (
                <div className="text-center text-slate-400 py-12">
                  <i className="fas fa-magnifying-glass text-3xl mb-2 block opacity-40"></i>
                  <p className="text-sm">Type a query above and press Search.</p>
                </div>
              )}
              {pastLoading && (
                <div className="text-center text-slate-400 py-12">
                  <i className="fas fa-spinner fa-spin text-2xl mb-2 block"></i>
                  <p className="text-sm">Searching…</p>
                </div>
              )}
              {pastSearched && !pastLoading && pastResults.length === 0 && (
                <div className="text-center text-slate-400 py-12">
                  <i className="fas fa-face-sad-tear text-3xl mb-2 block opacity-40"></i>
                  <p className="text-sm">No bookings match "<strong>{pastQuery}</strong>".</p>
                </div>
              )}
              {pastSearched && !pastLoading && pastResults.length > 0 && (
                <>
                  <p className="text-[11px] text-slate-500 mb-2 uppercase tracking-wide">
                    {pastResults.length} result{pastResults.length === 1 ? '' : 's'}
                  </p>
                  <ul className="space-y-2">
                    {pastResults.map(b => {
                      const grand       = Number(b.total ?? 0) + Number(b.extensionsTotal ?? 0) + Number(b.entranceFee ?? 0);
                      const outstanding = Math.max(0, grand - Number(b.paidAmount ?? 0));
                      return (
                        <li key={b.bookingId}
                          className="border border-slate-200 rounded-lg p-3 hover:border-sky-300 hover:bg-sky-50/40 transition"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="font-semibold text-slate-800 truncate">{walkInName(b)}</p>
                                <StatusBadge status={b.status} booking={b} />
                              </div>
                              <p className="text-[11px] font-mono text-slate-500">{b.id}</p>
                              <p className="text-xs text-slate-600 mt-1">
                                {b.roomType} · {b.guests} pax
                              </p>
                              <p className="text-[11px] text-slate-500">
                                {fmtDate(b.checkIn)} → {fmtDate(b.checkOut)}
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="font-bold text-slate-800 text-sm">{fmtMoney(grand)}</p>
                              {outstanding > 0
                                ? <p className="text-[11px] text-sky-700 font-medium">{fmtMoney(outstanding)} owed</p>
                                : <p className="text-[11px] text-emerald-600 font-medium">Fully paid</p>}
                            </div>
                          </div>
                          <div className="mt-2 flex gap-2">
                            <button
                              type="button"
                              onClick={() => { setSelected(b); setSearchPanelOpen(false); }}
                              className="flex-1 inline-flex items-center justify-center min-h-11 px-3 py-2 border border-slate-300 rounded text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
                              <i className="fas fa-eye mr-1" aria-hidden="true"></i>View details
                            </button>
                            {/* Past booking search panel — skip the Receipt
                                button for cancellations that never collected
                                any money, since the backend now refuses to
                                generate receipts for those (422). */}
                            {!(b.status === 'Cancelled' && Number(b.paidAmount ?? 0) <= 0) && (
                              <button
                                type="button"
                                onClick={() => downloadPastReceipt(b.bookingId, b.id)}
                                disabled={pastDownloading === b.bookingId}
                                className="flex-1 inline-flex items-center justify-center min-h-11 px-3 py-2 bg-sky-600 text-white rounded text-xs font-medium hover:bg-sky-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2">
                                <i className={`fas ${pastDownloading === b.bookingId ? 'fa-spinner fa-spin' : 'fa-file-pdf'} mr-1`} aria-hidden="true"></i>
                                Confirmation
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          </aside>
        </>
      )}
    </Shell>
  );
}
