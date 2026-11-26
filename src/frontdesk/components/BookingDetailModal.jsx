// src/frontdesk/components/BookingDetailModal.jsx
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import Modal from '../../components/modals/Modal.jsx';
import {
  updateBookingStatus, checkInBooking, checkOutBooking, markBookingNoShow,
  addAmenity, updateAmenity, removeAmenity, downloadStaffReceipt, updateBookingGuests,
  getFdRooms, getFdBookings, transferRoom,
  addonAvailabilityForBooking,
  checkInReservation,
  checkOutReservation,
  cancelReservation,
  revertNoShowReservation,
  markNoShowReservation,
  getExtensionOptions,
  createExtension,
  extendReservation,
  cancelExtension,
} from '../../lib/frontdeskApi';
import { api } from '../../lib/api';
import { applyPromoToBooking } from '../../lib/adminApi';
import { fmtDateTime, fmtMoney, fmtGuestEmail } from '../../lib/format';
import useFocusTrap from '../../hooks/useFocusTrap.js';
import { useNotifications } from '../../context/NotificationContext.jsx';

// Entrance fee rates per adult — matches Setting::pricing() defaults.
// Fallback rates for pre-mount / offline render. Live rates come from
// /api/pricing and are passed in explicitly so staff never see stale
// numbers when the owner has updated the Settings. '24hr-pm' is kept
// for legacy bookings created before the flexible 24hr start-hour.
const FALLBACK_RATES = { day: 50, night: 80, '24hr': 100, '24hr-pm': 100 };

function entranceFeeForBooking(booking, rates = FALLBACK_RATES) {
  const type   = booking.bookingType ?? 'day';
  const rate   = rates[type] ?? FALLBACK_RATES[type] ?? 50;
  // Use stored DB value when available (after check-in/walk-in); otherwise compute expected
  const amount = (booking.entranceFee != null && Number(booking.entranceFee) > 0)
    ? Number(booking.entranceFee)
    : (booking.guests ?? 1) * rate;
  return { rate, amount };
}

// ─── helpers ──────────────────────────────────────────────────────────────────
// Gate on the backend-attributed `source` — special_requests is user-
// controlled on online bookings, so a guest could craft "Walk-in: …" to
// forge identity/contact display. `source` is derived server-side from
// reservation_fee + paymongo_link_id and can't be spoofed by payload.
function parseWalkIn(b) {
  if (b?.source !== 'walk-in') return null;
  if (!b.specialRequests?.startsWith('Walk-in:')) return null;
  const name  = (b.specialRequests.match(/^Walk-in:\s*([^,]+)/) || [])[1]?.trim() || b.guest;
  const phone = (b.specialRequests.match(/Phone:\s*([^,]+)/)    || [])[1]?.trim() || '—';
  const email = (b.specialRequests.match(/Email:\s*([^,]+)/)    || [])[1]?.trim() || '—';
  // Notes is the free-form guest request that the walk-in form appends.
  // Grab everything after "Notes:" so multi-comma notes aren't truncated.
  const notesMatch = b.specialRequests.match(/Notes:\s*(.+)$/);
  const notes = notesMatch?.[1]?.trim() || '';
  return { name, phone, email, notes };
}

function isExpiredPending(b) {
  if (!b || b.status !== 'Pending') return false;
  if (b.paymongoLinkId) return false; // payment session in progress — not expired
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  return new Date(b.createdAt) < fiveMinAgo;
}

// A Checked In booking whose scheduled checkout time has already passed.
// Mirrors Bookings.jsx so the "Overdue" state is computed identically
// across the frontdesk portal.
function isOverdueCheckout(b) {
  if (!b || b.status !== 'Checked In' || !b.checkOut) return false;
  return new Date(String(b.checkOut).replace(' ', 'T')) < new Date();
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
    'Checked In': 'bg-violet-100 text-violet-800',
    Completed:    'bg-emerald-100 text-emerald-800',
    Cancelled:    'bg-rose-100 text-rose-800',
    Pending:      'bg-amber-100 text-amber-800',
  };
  return (
    <span className={`px-2 py-1 rounded text-xs font-medium ${cls[status] ?? 'bg-slate-100 text-slate-800'}`}>
      {status}
    </span>
  );
}

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

// Addons fetched from API — see useEffect below

// ─── action configs ───────────────────────────────────────────────────────────
const ACTION_CONFIG = {
  'confirm-booking': {
    label:   'Confirm Booking',
    icon:    'fa-check',
    color:   'sky',
    heading: 'Confirm this reservation?',
    desc:    'This commits the reservation. The guest will be notified.',
  },
  checkin: {
    label:   'Check In Guest',
    icon:    'fa-door-open',
    color:   'emerald',
    heading: 'Check in this guest?',
    desc:    'Ensure the balance and entrance fee have been collected before checking in.',
  },
  checkout: {
    label:   'Check Out Guest',
    icon:    'fa-sign-out-alt',
    color:   'emerald',
    heading: 'Check out this guest?',
    desc:    'This marks the booking as Completed. Make sure all charges are settled before proceeding.',
  },
  cancel: {
    label:   'Cancel Booking',
    icon:    'fa-ban',
    color:   'rose',
    heading: 'Cancel this booking?',
    desc:    'This cannot be undone. The reservation fee is non-refundable.',
  },
  'no-show': {
    label:   'Mark as No-Show',
    icon:    'fa-user-slash',
    color:   'slate',
    heading: 'Mark guest as no-show?',
    desc:    'Guest will be recorded as not arriving. Reservation fee stays as forfeited revenue. You can reverse this later by manually checking the guest in.',
  },
  'remove-amenity': {
    label:   'Remove Add-on',
    icon:    'fa-times',
    color:   'rose',
    heading: 'Remove this add-on?',
    desc:    'This will remove the item and adjust the booking total.',
  },
};

const COLOR = {
  sky:     { btn: 'bg-sky-600 hover:bg-sky-700',         banner: 'bg-sky-50 border-sky-200 text-sky-800',         ring: 'focus-visible:ring-sky-500' },
  violet:  { btn: 'bg-violet-600 hover:bg-violet-700',   banner: 'bg-violet-50 border-violet-200 text-violet-800', ring: 'focus-visible:ring-violet-500' },
  emerald: { btn: 'bg-emerald-600 hover:bg-emerald-700', banner: 'bg-emerald-50 border-emerald-200 text-emerald-800', ring: 'focus-visible:ring-emerald-500' },
  rose:    { btn: 'bg-rose-600 hover:bg-rose-700',       banner: 'bg-rose-50 border-rose-200 text-rose-800',       ring: 'focus-visible:ring-rose-500' },
  slate:   { btn: 'bg-slate-600 hover:bg-slate-700',     banner: 'bg-slate-50 border-slate-200 text-slate-800',   ring: 'focus-visible:ring-slate-500' },
};

/**
 * BookingDetailModal
 */
export default function BookingDetailModal({ booking: initialBooking, onClose, onUpdated, onReload, showToast }) {
  const { refresh: refreshNotifications } = useNotifications();
  const [booking,       setBooking]       = useState(initialBooking);
  const [addonCatalog,     setAddonCatalog]     = useState([]);
  // Map of addon_id → { remaining, allocated, max_qty } for THIS
  // booking's window (server computes with exceptBookingId=self so
  // the booking's own lines aren't counted against itself).
  // Refreshed on mount + after every add/edit/remove.
  const [addonAvailability, setAddonAvailability] = useState({});
  const [actionLoading,    setActionLoading]    = useState(false);
  const [addingAmenity,    setAddingAmenity]    = useState(null);
  // Live entrance rates from /api/pricing so the modal never displays or
  // sends stale hardcoded numbers after the owner updates pricing.
  const [entranceRates,    setEntranceRates]    = useState(FALLBACK_RATES);

  // Fetch + set availability map for this booking's window. Keyed by
  // addon_id for O(1) lookup in the picker render. Called on mount
  // and after every amenity CRUD to keep counts in sync.
  const refreshAddonAvailability = () => {
    if (!booking?.bookingId) return;
    addonAvailabilityForBooking(booking.bookingId)
      .then(r => {
        const rows = r?.data ?? [];
        const map  = {};
        for (const row of rows) map[row.id] = row;
        setAddonAvailability(map);
      })
      .catch(() => {});
  };

  useEffect(() => {
    api.get('/api/addons')
      .then(r => setAddonCatalog(r.data?.data ?? []))
      .catch(() => {});
    api.get('/api/pricing')
      .then(r => {
        const d = r.data?.data;
        if (d) setEntranceRates({
          day:       Number(d.entrance_fee_day   ?? 50),
          night:     Number(d.entrance_fee_night ?? 80),
          '24hr':    Number(d.entrance_fee_24hr  ?? 100),
          '24hr-pm': Number(d.entrance_fee_24hr  ?? 100),
        });
      })
      .catch(() => {});
    // Fetch rooms up-front so the addon picker below can filter by
    // the booking's room + apply per-room price overrides, matching
    // the walk-in and guest-booking flows. Previously rooms only
    // loaded when the Transfer picker opened.
    getFdRooms()
      .then(setRooms)
      .catch(() => {});
    refreshAddonAvailability();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [amenityLoading,   setAmenityLoading]   = useState(false);
  // Inline qty editor state for an existing amenity row:
  //   { id: <amenityId>, qty: <staged qty>, max: <catalog max_qty> }
  const [editingAmenity,   setEditingAmenity]   = useState(null);
  const [receiptLoading,   setReceiptLoading]   = useState(false);
  const [guestEdit,        setGuestEdit]        = useState(false);
  // Member list in the group panel is capped at 3 by default so a 6-room
  // reservation doesn't push the money block + add-ons off-screen.
  const [showAllGroup,     setShowAllGroup]     = useState(false);
  const [guestCount,       setGuestCount]       = useState(initialBooking.guests ?? 1);
  const [guestLoading,     setGuestLoading]     = useState(false);
  const [promoInput,       setPromoInput]       = useState('');
  const [promoLoading,     setPromoLoading]     = useState(false);
  const [promoError,       setPromoError]       = useState('');
  // pendingAction: { type, amenityId?, amenityName?, amenityTotal? } | null
  const [pendingAction,    setPendingAction]    = useState(null);
  const [transferOpen,     setTransferOpen]     = useState(false);
  const [transferRoomId,   setTransferRoomId]   = useState('');
  const [transferring,     setTransferring]     = useState(false);
  // Separate confirm-modal step for transfers. Staff first pick a room
  // in the inline panel, then a confirmation modal shows the rate
  // delta (upgrades only; downgrades keep the original price) before
  // the API call fires. Prevents surprise charges and matches the
  // backend's upgrade-only re-pricing in Admin\BookingController.
  const [transferConfirmOpen, setTransferConfirmOpen] = useState(false);
  const transferDialogRef = useFocusTrap(transferConfirmOpen);

  // Focus traps for the two inner dialogs that the parent Modal
  // can't manage (they're portaled to body at z-[99998+], above
  // the parent Modal's z-[9999]). Without these, Tab would leak
  // from the inner dialog back into the parent BookingDetailModal
  // content underneath.
  const pendingActionRef = useFocusTrap(!!pendingAction);
  const transferPickerRef = useFocusTrap(transferOpen);


  // Escape closes the transfer confirm dialog (ignored while the
  // transfer API call is in flight so the dialog can't vanish mid-save).
  useEffect(() => {
    if (!transferConfirmOpen) return;
    function onKey(e) {
      if (e.key === 'Escape' && !transferring) setTransferConfirmOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [transferConfirmOpen, transferring]);

  // Escape cancels the action confirmation dialog (Confirm / Check In /
  // Check Out / Cancel / Remove Add-on). Ignored while an action is
  // mid-flight so the dialog can't vanish mid-save.
  useEffect(() => {
    if (!pendingAction) return;
    function onKey(e) {
      if (e.key === 'Escape' && !actionLoading) setPendingAction(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingAction, actionLoading]);

  // Escape closes the transfer room picker (step 1). Only fires while
  // the rate-preview confirm step (step 2) isn't also open — that
  // dialog has its own escape handler above, and whichever is on top
  // should be the one that responds.
  useEffect(() => {
    if (!transferOpen || transferConfirmOpen) return;
    function onKey(e) {
      if (e.key === 'Escape' && !transferring) {
        setTransferOpen(false);
        setTransferRoomId('');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [transferOpen, transferConfirmOpen, transferring]);
  const [rooms,            setRooms]            = useState([]);
  const [roomsLoading,     setRoomsLoading]     = useState(false);
  // All bookings — only fetched when the Transfer picker opens, so the
  // filter can count overlaps per target room against its quantity.
  const [allBookings,      setAllBookings]      = useState([]);

  function applyUpdate(updates) {
    const updated = { ...booking, ...updates };
    setBooking(updated);
    onUpdated?.(updated);
  }

  // ── actual executors ──────────────────────────────────────────────────────
  async function execAction() {
    if (!pendingAction) return;
    const { type, amenityId } = pendingAction;
    setPendingAction(null);
    setActionLoading(true);
    try {
      if (type === 'confirm-booking') {
        await updateBookingStatus(booking.bookingId, 'Confirmed');
        applyUpdate({ status: 'Confirmed' });
        refreshNotifications?.();
      } else if (type === 'checkin') {
        // Don't pass entrance_fee — the backend computes it from the
        // current Setting::pricing() rate so staff can't accidentally
        // persist a stale hardcoded amount that bypasses the owner's
        // pricing settings.
        const res = await checkInBooking(booking.bookingId);
        // Use the full formatted booking from the backend so paidAmount /
        // fullyPaid / entranceFee all stay in sync. Narrow-field spreads
        // here would leave those fields stale and mislead billing.
        applyUpdate(res.data ?? { status: 'Checked In', checkedInAt: res.checkedInAt, entranceFee: ef });
        refreshNotifications?.();
      } else if (type === 'checkout') {
        const res = await checkOutBooking(booking.bookingId);
        applyUpdate(res.data ?? { status: 'Completed', checkedOutAt: res.checkedOutAt });
        refreshNotifications?.();
      } else if (type === 'cancel') {
        await updateBookingStatus(booking.bookingId, 'Cancelled');
        applyUpdate({ status: 'Cancelled' });
        refreshNotifications?.();
      } else if (type === 'no-show') {
        const res = await markBookingNoShow(booking.bookingId);
        // Backend returns the full formatted booking; use it so noShowAt
        // and any backend-side derivations (eg. promo usage release) are
        // reflected without a stale spread.
        applyUpdate(res.data ?? { status: 'No-Show' });
        refreshNotifications?.();
      } else if (type === 'remove-amenity') {
        const res = await removeAmenity(booking.bookingId, amenityId);
        const newTotal = Number(res.newTotal);
        const updated  = {
          ...booking,
          amenities: (booking.amenities || []).filter(a => a.id !== amenityId),
          total: newTotal,
          fullyPaid: (typeof res.fullyPaid === 'boolean') ? res.fullyPaid : booking.fullyPaid,
          outstanding: (res.outstanding != null) ? Number(res.outstanding) : booking.outstanding,
        };
        setBooking(updated);
        onUpdated?.(updated);
        refreshAddonAvailability();
      }
    } catch (err) {
      // Surface the backend's specific 422 message when one is
      // present — this is how the checkout flow tells staff to
      // "collect the remaining balance first", and how confirm /
      // cancel report their own guard failures. Falling back to
      // the generic string only when nothing useful came down.
      const msg = err?.response?.data?.message
        || err?.response?.data?.error
        || 'Action failed. Please try again.';
      showToast?.(msg, 'error');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleUpdateGuests() {
    // Clamp here too in case Save was clicked while the input was
    // mid-edit (empty string or fractional) and onBlur hasn't fired.
    const parsed = parseInt(guestCount, 10);
    const safe   = Number.isNaN(parsed) || parsed < 1 ? 1 : parsed;
    if (safe !== guestCount) setGuestCount(safe);
    if (safe === booking.guests) { setGuestEdit(false); return; }
    setGuestLoading(true);
    try {
      const res = await updateBookingGuests(booking.bookingId, safe);
      // Pull the full formatted booking from the response so entranceFee,
      // paidAmount, fullyPaid, and outstanding all reflect the backend's
      // recomputation (otherwise the billing breakdown stays stale).
      applyUpdate(res.data ?? { guests: res.guests });
      setGuestEdit(false);
      // Backend only persists entrance_fee after check-in. For Pending /
      // Confirmed rows it returns 0 in res.data.entranceFee, which `??`
      // treats as a real value and bypasses the client-side fallback —
      // producing a misleading "Entrance fee: ₱0.00" toast. Treat any
      // non-positive backend value as absent and compute from the new
      // guest count × per-head rate instead.
      const backendEntrance = Number(res.data?.entranceFee ?? 0);
      const freshEntrance   = backendEntrance > 0
        ? backendEntrance
        : res.guests * (ENTRANCE_RATES[booking.bookingType ?? 'day'] ?? 50);
      showToast?.(`Guest count updated to ${res.guests}. Entrance fee: ${fmtMoney(freshEntrance)}.`, 'success');
    } catch {
      showToast?.('Failed to update guest count.', 'error');
    } finally {
      setGuestLoading(false);
    }
  }

  // Phase 3c+: reservation-level bulk check-in. Walks every sibling in
  // the parent reservation whose status is Confirmed (or No-Show
  // reversal) and whose check_in date is today or earlier, flipping
  // them to Checked In in one call. Future-dated, unpaid, cancelled,
  // or already-checked-in siblings are returned in the summary and
  // surfaced as a toast so staff knows exactly what was skipped.
  const [groupCheckInLoading, setGroupCheckInLoading] = useState(false);
  async function handleGroupCheckIn() {
    if (!booking.reservationId) return;
    setGroupCheckInLoading(true);
    try {
      const res = await checkInReservation(booking.reservationId);
      // Toast tone reflects the real outcome, not just the HTTP 200.
      // The endpoint returns 200 even when nothing was checked in
      // (all siblings scheduled for later, unpaid, or already in),
      // so the "success" tone would mislead staff into thinking the
      // group is now in-house. Green only when at least one sibling
      // actually flipped to Checked In and nothing was blocked;
      // amber for partial; red when nothing happened.
      const checkedIn = Number(res.summary?.checked_in ?? 0);
      const skippedFuture  = (res.summary?.skipped_future  ?? []).length;
      const blockedUnpaid  = (res.summary?.blocked_unpaid  ?? []).length;
      const alreadyCheckedIn = Number(res.summary?.already_checked_in ?? 0);
      const hadFailures = skippedFuture > 0 || blockedUnpaid > 0;
      const tone = checkedIn === 0
        ? 'error'
        : (hadFailures ? 'warning' : 'success');
      const msg = res.message || `Group check-in: ${checkedIn} room(s) checked in.`;
      showToast?.(msg, tone);
      // The call touched multiple bookings — hand back control to the
      // parent to refresh the whole list so each sibling row reflects
      // its new state. The modal closes afterwards; staff reopens any
      // row from the refreshed list if they want to act further.
      onReload?.();
      refreshNotifications?.();
      onClose?.();
    } catch (err) {
      const msg = err?.response?.data?.message || 'Group check-in failed.';
      showToast?.(msg, 'error');
    } finally {
      setGroupCheckInLoading(false);
    }
  }

  // Reservation-level bulk check-out. Blocks per-row on unpaid
  // balance — staff must collect those via the per-row billing flow
  // first, then re-run the group check-out. Toast enumerates skips
  // so staff can see exactly what still needs attention.
  const [groupCheckOutLoading, setGroupCheckOutLoading] = useState(false);
  async function handleGroupCheckOut() {
    if (!booking.reservationId) return;
    setGroupCheckOutLoading(true);
    try {
      const res = await checkOutReservation(booking.reservationId);
      showToast?.(res.message || `Group check-out: ${res.summary?.checked_out ?? 0} room(s) checked out.`, 'success');
      onReload?.();
      refreshNotifications?.();
      onClose?.();
    } catch (err) {
      const msg = err?.response?.data?.message || 'Group check-out failed.';
      showToast?.(msg, 'error');
    } finally {
      setGroupCheckOutLoading(false);
    }
  }

  // Phase 5 — stay extensions. Opens a picker, loads valid
  // continuations from the backend, lets staff pick a slot type
  // (+ nights for 24hr), and posts the extension. On success the
  // parent list refreshes so the extended check_out and the new
  // balance flow through.
  const [extendOpen, setExtendOpen] = useState(false);
  const [extendOptions, setExtendOptions] = useState(null);
  const [extendOptionsLoading, setExtendOptionsLoading] = useState(false);
  const [extendSelected, setExtendSelected] = useState(null); // {type, nights}
  const [extendSubmitting, setExtendSubmitting] = useState(false);
  const [extendError, setExtendError] = useState('');
  // 'room' = extend this booking only. 'group' = extend every
  // Checked-In sibling in the reservation. The picker loads options
  // from the current booking's chain tip either way; the backend
  // for 'group' re-validates per sibling and skips any whose chain
  // tip doesn't accept the chosen slot type.
  const [extendScope, setExtendScope] = useState('room');
  // { id, label, amount } when the staff clicks the X next to an
  // extension row. Two-step confirm because it writes to the
  // ledger and may leave the booking overpaid.
  const [cancelExtPending, setCancelExtPending] = useState(null);
  const [cancelExtLoading, setCancelExtLoading] = useState(false);
  // Post-group-extend result. Holds the backend summary so the
  // picker can render a per-sibling breakdown — which rooms got
  // extended and which were skipped with the reason — instead of
  // throwing a fleeting toast and closing. Null while the picker
  // is pre-submit; set when the group submit returns (whether
  // partial or full success).
  const [extendResult, setExtendResult] = useState(null);

  async function openExtendPicker(scope = 'room') {
    setExtendOpen(true);
    setExtendError('');
    setExtendSelected(null);
    setExtendOptions(null);
    setExtendResult(null);
    setExtendScope(scope);
    setExtendOptionsLoading(true);
    try {
      const res = await getExtensionOptions(booking.bookingId);
      setExtendOptions(res);
      // Pre-select the first option so the Confirm button is active
      // without an extra click when only one is valid (Day → Night).
      const first = res?.options?.[0];
      if (first) setExtendSelected({ type: first.type, nights: first.nights ?? 1 });
    } catch (err) {
      setExtendError(err?.response?.data?.message || 'Could not load extension options.');
    } finally {
      setExtendOptionsLoading(false);
    }
  }

  async function handleCancelExtension({ refundCash } = {}) {
    if (!cancelExtPending) return;
    setCancelExtLoading(true);
    try {
      const res = await cancelExtension(booking.bookingId, cancelExtPending.id, { refundCash });
      const refunded = Number(res?.refund_applied ?? 0);
      const over     = Number(res?.overpayment ?? 0);
      let msg;
      if (refunded > 0) {
        msg = `Extension cancelled. Refund of ${fmtMoney(refunded)} recorded — hand the cash to the guest.`;
      } else if (over > 0) {
        msg = `Extension cancelled. Guest overpaid by ${fmtMoney(over)} — refund or credit at checkout.`;
      } else {
        msg = 'Extension cancelled.';
      }
      showToast?.(msg, 'success');
      onReload?.();
      refreshNotifications?.();
      setCancelExtPending(null);
      onClose?.();
    } catch (err) {
      showToast?.(err?.response?.data?.message || 'Could not cancel the extension.', 'error');
    } finally {
      setCancelExtLoading(false);
    }
  }

  async function submitExtend() {
    if (!extendSelected?.type) return;
    setExtendSubmitting(true);
    setExtendError('');
    try {
      if (extendScope === 'group' && booking.reservationId) {
        const res = await extendReservation(booking.reservationId, extendSelected);
        const summary = res?.summary || {};
        const extended = Number(summary.extended ?? 0);
        const expectedSkips = (summary.skipped_not_checked_in?.length ?? 0);
        // Backend returns 200 only when the whole group succeeded
        // (atomic semantics). Reload the parent so new check_out /
        // balance show up. If there were "not Checked In" expected
        // skips, hold the result card open so staff see the breakdown;
        // otherwise toast + close like a normal full success.
        onReload?.();
        refreshNotifications?.();
        if (expectedSkips > 0) {
          setExtendResult({ scope: 'group', aborted: false, ...summary, message: res.message });
          return;
        }
        showToast?.(res.message || `Group extend: ${extended} room(s) extended.`, 'success');
        setExtendOpen(false);
        onClose?.();
      } else {
        await createExtension(booking.bookingId, extendSelected);
        showToast?.('Stay extended.', 'success');
        onReload?.();
        refreshNotifications?.();
        setExtendOpen(false);
        onClose?.();
      }
    } catch (err) {
      // Structured 422 abort from the group-extend endpoint. Carries
      // a full summary (per-room names + categories). Show it in the
      // result card instead of a toast so staff can read what blocked
      // each room and act on it.
      const data = err?.response?.data;
      if (extendScope === 'group' && data?.summary) {
        setExtendResult({ scope: 'group', aborted: !!data.aborted, ...data.summary, message: data.message });
      } else {
        setExtendError(data?.message || 'Could not extend the stay.');
      }
    } finally {
      setExtendSubmitting(false);
    }
  }

  // Reservation-level bulk mark-as-no-show. Mirrors the per-row
  // markNoShow guards (Confirmed + Day|Night + slot started). 24hr
  // siblings and future-slot siblings are blocked by the backend;
  // the toast enumerates skips. Two-step confirm because it
  // releases promo counts and flips multiple rows to a terminal-
  // adjacent state.
  const [groupMarkNoShowLoading, setGroupMarkNoShowLoading] = useState(false);
  const [groupMarkNoShowConfirm, setGroupMarkNoShowConfirm] = useState(false);
  async function handleGroupMarkNoShow() {
    if (!booking.reservationId) return;
    setGroupMarkNoShowLoading(true);
    try {
      const res = await markNoShowReservation(booking.reservationId);
      showToast?.(res.message || `Group no-show: ${res.summary?.marked ?? 0} room(s) marked.`, 'success');
      onReload?.();
      refreshNotifications?.();
      setGroupMarkNoShowConfirm(false);
      onClose?.();
    } catch (err) {
      const msg = err?.response?.data?.message || 'Group no-show failed.';
      showToast?.(msg, 'error');
    } finally {
      setGroupMarkNoShowLoading(false);
    }
  }

  // Reservation-level bulk no-show reversal. Flips No-Show siblings
  // back to Confirmed (restores the row + re-increments any promo
  // count that was released). For when staff marked no-show
  // prematurely and the guest is expected to arrive later. If the
  // guest is already at the counter, bulk check-in already covers
  // the No-Show → Checked In reversal path.
  const [groupRevertNoShowLoading, setGroupRevertNoShowLoading] = useState(false);
  async function handleGroupRevertNoShow() {
    if (!booking.reservationId) return;
    setGroupRevertNoShowLoading(true);
    try {
      const res = await revertNoShowReservation(booking.reservationId);
      showToast?.(res.message || `Group reversal: ${res.summary?.reverted ?? 0} room(s) restored.`, 'success');
      onReload?.();
      refreshNotifications?.();
      onClose?.();
    } catch (err) {
      const msg = err?.response?.data?.message || 'Group no-show reversal failed.';
      showToast?.(msg, 'error');
    } finally {
      setGroupRevertNoShowLoading(false);
    }
  }

  // Reservation-level bulk cancel. Confirms via an inline UI first —
  // cancelling a group is irreversible and has promo-release
  // consequences. Checked-In / Completed siblings are blocked by the
  // backend; the toast surfaces exactly what was skipped.
  const [groupCancelLoading, setGroupCancelLoading] = useState(false);
  const [groupCancelConfirm, setGroupCancelConfirm] = useState(false);
  async function handleGroupCancel() {
    if (!booking.reservationId) return;
    setGroupCancelLoading(true);
    try {
      const res = await cancelReservation(booking.reservationId);
      showToast?.(res.message || `Group cancel: ${res.summary?.cancelled ?? 0} room(s) cancelled.`, 'success');
      onReload?.();
      refreshNotifications?.();
      setGroupCancelConfirm(false);
      onClose?.();
    } catch (err) {
      const msg = err?.response?.data?.message || 'Group cancel failed.';
      showToast?.(msg, 'error');
    } finally {
      setGroupCancelLoading(false);
    }
  }

  async function handleApplyPromo() {
    if (!promoInput.trim()) return;
    setPromoLoading(true);
    setPromoError('');
    try {
      const res = await applyPromoToBooking(booking.bookingId, promoInput.trim());
      const code = res.data.promo_code;
      applyUpdate({ promoCode: code, discount: res.data.discount, total: res.data.total });
      setPromoInput('');
      showToast?.(`Promo code "${code}" applied. Discount: ${fmtMoney(res.data.discount)}`, 'success');
    } catch (err) {
      setPromoError(err?.response?.data?.message || 'Invalid promo code.');
    } finally {
      setPromoLoading(false);
    }
  }

  async function handleAddAmenity() {
    if (!addingAmenity?.name) return;
    setAmenityLoading(true);
    try {
      const res = await addAmenity(booking.bookingId, addingAmenity.name, addingAmenity.qty || 1);
      const newAmenity = res.data;
      const newTotal   = Number(res.newTotal);
      // Also pull the freshly-derived fullyPaid and outstanding from the
      // backend so the detail drawer reflects that adding a paid-up
      // amenity reopens the balance.
      const updated    = {
        ...booking,
        amenities: [...(booking.amenities || []), newAmenity],
        total: newTotal,
        fullyPaid: (typeof res.fullyPaid === 'boolean') ? res.fullyPaid : booking.fullyPaid,
        outstanding: (res.outstanding != null) ? Number(res.outstanding) : booking.outstanding,
      };
      setBooking(updated);
      onUpdated?.(updated);
      setAddingAmenity(null);
      refreshAddonAvailability();
    } catch (err) {
      showToast?.(err?.response?.data?.message || 'Failed to add add-on.', 'error');
    } finally { setAmenityLoading(false); }
  }

  // Edit the qty of an existing amenity line. Backend recomputes booking
  // total and fully_paid; we splice the returned amenity back into the
  // list in-place so the drawer's rendered totals stay consistent.
  async function handleUpdateAmenity() {
    if (!editingAmenity) return;
    const current = (booking.amenities || []).find(a => a.id === editingAmenity.id);
    if (!current) { setEditingAmenity(null); return; }
    if (editingAmenity.qty === current.qty) { setEditingAmenity(null); return; }

    setAmenityLoading(true);
    try {
      const res        = await updateAmenity(booking.bookingId, editingAmenity.id, editingAmenity.qty);
      const updatedRow = res.data;
      const newTotal   = Number(res.newTotal);
      const updated    = {
        ...booking,
        amenities: (booking.amenities || []).map(a => a.id === updatedRow.id ? { ...a, ...updatedRow } : a),
        total: newTotal,
        fullyPaid: (typeof res.fullyPaid === 'boolean') ? res.fullyPaid : booking.fullyPaid,
        outstanding: (res.outstanding != null) ? Number(res.outstanding) : booking.outstanding,
      };
      setBooking(updated);
      onUpdated?.(updated);
      setEditingAmenity(null);
      refreshAddonAvailability();
      showToast?.(`Updated ${updatedRow.name} to qty ${updatedRow.qty}.`, 'success');
    } catch (err) {
      showToast?.(err?.response?.data?.message || 'Failed to update add-on.', 'error');
    } finally { setAmenityLoading(false); }
  }

  async function handleDownloadReceipt() {
    setReceiptLoading(true);
    try {
      const blob = await downloadStaffReceipt(booking.bookingId);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `${booking.id}-booking-confirmation.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      showToast?.('Failed to download confirmation.', 'error');
    } finally {
      setReceiptLoading(false);
    }
  }

  function openTransfer() {
    setTransferOpen(true);
    setTransferRoomId('');
    setRoomsLoading(true);
    // Also fetch the full bookings list so the transfer filter can
    // count overlapping stays per room and compare to room.quantity —
    // matches the safer check the main Reservation page uses and the
    // backend's transferRoom guard (which rejects when overlap count
    // >= quantity). Always refetch so stale cached data doesn't hide
    // newly-created conflicts.
    Promise.all([getFdRooms(), getFdBookings()])
      .then(([roomsData, bookingsData]) => {
        setRooms(roomsData);
        setAllBookings(bookingsData);
      })
      .catch(() => {})
      .finally(() => setRoomsLoading(false));
  }

  // Per-slot rate lookup — must match the backend's transferRoom()
  // rule, otherwise the frontend delta preview diverges from what
  // the server actually charges. Keep this aligned with
  // Admin\BookingController::transferRoom's $rateFor closure.
  function rateFor(room, bookingType) {
    if (!room) return 0;
    switch (bookingType) {
      case 'night':
        return Number(room.overnight_rate ?? 0);
      case '24hr':
      case '24hr-pm':
        return Number(room.rate_24hr ?? 0);
      default:
        return Number(room.day_rate ?? 0);
    }
  }

  // Preview delta computed client-side from the rooms list that's
  // already loaded — no extra API round-trip needed. Drives the
  // confirmation modal below.
  const transferPreview = (() => {
    if (!transferRoomId) return null;
    const target = rooms.find(r => String(r.id) === String(transferRoomId));
    if (!target) return null;
    const oldRoom = rooms.find(r => String(r.id) === String(booking.roomId));
    const bt = booking.bookingType ?? 'day';
    const oldRate = rateFor(oldRoom, bt);
    const newRate = rateFor(target, bt);
    // Match backend upgrade-only rule: downgrades keep original pricing.
    const isUpgrade = newRate > oldRate;
    return {
      targetName: target.name,
      oldRate,
      newRate,
      isUpgrade,
      balanceChange: isUpgrade ? newRate - oldRate : 0,
    };
  })();

  async function handleTransfer() {
    if (!transferRoomId) return;
    setTransferring(true);
    try {
      const res = await transferRoom(booking.bookingId, Number(transferRoomId));
      const newRoomName = rooms.find(r => String(r.id) === String(transferRoomId))?.name ?? res.room_name;
      const delta = Number(res.balance_change ?? 0);
      // Propagate the new total + rate into the modal so billing
      // fields reflect the upgrade without requiring a full refetch.
      applyUpdate({
        roomType: newRoomName,
        roomId:   Number(transferRoomId),
        ...(res.data ? { total: res.data.total, fullyPaid: res.data.fullyPaid } : {}),
      });
      setTransferOpen(false);
      setTransferConfirmOpen(false);
      setTransferRoomId('');
      const toastMsg = delta > 0
        ? `Transferred to ${newRoomName}. +₱${delta.toLocaleString('en-PH', { minimumFractionDigits: 2 })} due at counter.`
        : `Guest transferred to ${newRoomName}.`;
      showToast?.(toastMsg, 'success');
    } catch (err) {
      showToast?.(err?.response?.data?.message ?? 'Transfer failed. Room may be occupied.', 'error');
    } finally {
      setTransferring(false);
    }
  }

  const wi         = parseWalkIn(booking);
  const guestName  = wi ? wi.name  : booking.guest;
  const guestEmail = fmtGuestEmail(wi ? wi.email : booking.guestEmail);
  const guestPhone = wi ? wi.phone : (booking.guestPhone || '—');
  // Room balance remaining before check-in. paidAmount is the backend's
  // authoritative ledger of money actually collected (reservation fee +
  // counter payments + promo credits), so it stays accurate after promo
  // changes, partial counter collections, guest-count edits, or amenity
  // additions. Falls back to the reservation-fee heuristic only when the
  // backend didn't attach paidAmount (legacy cached rows).
  // Entrance fee is shown as a separate line and collected at the gate,
  // so we compare against total (room + add-ons − discount), not the
  // grand total that outstanding() uses.
  const collectedAgainstRoom = Number(booking.paidAmount ?? booking.reservationFee ?? 0);
  const balanceDue           = Math.max(0, Number(booking.total || 0) - collectedAgainstRoom);

  const cfg   = pendingAction ? ACTION_CONFIG[pendingAction.type] : null;
  const clr   = cfg ? COLOR[cfg.color] : null;

  // Block close while a confirmation dialog is open inside — we
  // don't want the user to bail out of "Confirm check-in" by
  // clicking the backdrop and accidentally closing the parent
  // modal too. Both dialogs swallow Escape via their own focus
  // ownership; this guard handles backdrop clicks.
  const handleClose = () => { if (!pendingAction) onClose(); };

  return (
    <Modal open onClose={handleClose} maxWidth="max-w-lg" label={`Booking ${booking.id}`}>
      <div className="p-6">

          {/* ── Confirmation Dialog (portaled, renders above this modal) ── */}
          {pendingAction && cfg && createPortal(
            <div
              className="fixed inset-0 z-[99999] flex items-center justify-center px-4"
              role="dialog" aria-modal="true" aria-label="Confirm action"
              onMouseDown={e => e.target === e.currentTarget && !actionLoading && setPendingAction(null)}
            >
              <div className="absolute inset-0 bg-black/50" />
              <div ref={pendingActionRef} tabIndex={-1} className={`relative w-full max-w-sm rounded-xl border p-4 shadow-2xl focus:outline-none ${clr.banner} animate-hero-fade-in opacity-0`}>
                <div className="flex items-start gap-3 mb-3">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${clr.btn} text-white`}>
                    <i className={`fas ${cfg.icon} text-sm`}></i>
                  </div>
                  <div>
                    <p className="font-semibold text-sm">{cfg.heading}</p>
                    <p className="text-xs mt-0.5 opacity-80">{cfg.desc}</p>
                  </div>
                </div>

                {/* Summary rows */}
                <div className="bg-white/80 rounded-lg px-3 py-2 text-xs space-y-1 mb-3">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Booking</span>
                    <span className="font-semibold">{booking.id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Guest</span>
                    <span className="font-semibold">{guestName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Room</span>
                    <span className="font-semibold">{booking.roomType}</span>
                  </div>
                  {pendingAction.type === 'checkin' && (() => {
                    const { rate, amount } = entranceFeeForBooking(booking, entranceRates);
                    return (
                      <>
                        <div className="flex justify-between border-t border-slate-200 pt-1 mt-1">
                          <span className="text-slate-500">Balance due (room)</span>
                          <span className="font-bold text-violet-700">{fmtMoney(balanceDue)}</span>
                        </div>
                        <div className="flex justify-between pt-0.5">
                          <span className="text-amber-600 flex items-center gap-1">
                            <i className="fas fa-ticket-alt text-[10px]"></i>
                            Entrance fee ({booking.guests ?? 1} pax × ₱{rate})
                          </span>
                          <span className="font-bold text-amber-700">{fmtMoney(amount)}</span>
                        </div>
                        <p className="text-amber-600 text-[10px] pt-0.5">Collect entrance fee at the gate — not in booking total.</p>
                      </>
                    );
                  })()}
                  {pendingAction.type === 'checkout' && (
                    <div className="flex justify-between border-t border-slate-200 pt-1 mt-1">
                      <span className="text-slate-500">Total Amount</span>
                      <span className="font-bold text-emerald-700">{fmtMoney(booking.total)}</span>
                    </div>
                  )}
                  {pendingAction.type === 'remove-amenity' && (
                    <div className="flex justify-between border-t border-slate-200 pt-1 mt-1">
                      <span className="text-slate-500">Item</span>
                      <span className="font-semibold">{pendingAction.amenityName} — {fmtMoney(pendingAction.amenityTotal)}</span>
                    </div>
                  )}
                </div>

                <div className="flex gap-2">
                  <button type="button" onClick={() => setPendingAction(null)} disabled={actionLoading}
                    className="flex-1 inline-flex items-center justify-center min-h-11 px-3 py-2 border border-slate-300 bg-white rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
                    Cancel
                  </button>
                  <button type="button" onClick={execAction} disabled={actionLoading}
                    className={`flex-1 inline-flex items-center justify-center min-h-11 px-3 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${clr.btn} ${clr.ring ?? 'focus-visible:ring-slate-500'}`}>
                    {actionLoading
                      ? <><i className="fas fa-spinner fa-spin mr-1" aria-hidden="true"></i>Processing...</>
                      : <><i className={`fas ${cfg.icon} mr-1`} aria-hidden="true"></i>{cfg.label}</>}
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )}

          {/* Header — for group bookings the reservation id is shown
              as the primary line so it matches what the bookings table
              displays for the expanded group row (RSV-…). The per-room
              APL-… id becomes a subtitle so staff can still copy it
              for ticketing / receipts. Singles keep the one-line
              "Booking — APL-…" header. */}
          <div className="flex justify-between items-start mb-4 gap-3">
            {Number(booking.groupSize ?? 1) > 1 && booking.reservationResId ? (
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-slate-900 flex items-center flex-wrap gap-x-2">
                  <span>Group reservation — {booking.reservationResId}</span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-100 text-sky-800 text-[10px] font-bold uppercase tracking-wide">
                    <i className="fas fa-layer-group text-[9px]" aria-hidden="true"></i>
                    Group of {booking.groupSize}
                  </span>
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  This room: <span className="font-mono text-slate-700">{booking.id}</span>
                  <span className="mx-1 text-slate-300">·</span>
                  <span className="font-medium text-slate-700">{booking.roomType}</span>
                </p>
              </div>
            ) : (
              <h3 className="text-lg font-semibold">Booking — {booking.id}</h3>
            )}
            <button onClick={onClose} type="button" className="shrink-0 w-11 h-11 inline-flex items-center justify-center rounded-md text-slate-500 hover:text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" aria-label="Close">
              <i className="fas fa-times"></i>
            </button>
          </div>

          {/* Booking details grid — single column on phone, two cols at sm+ */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 bg-slate-50 rounded text-sm mb-4">
            {/* Money block — pulls grand total out of the "Total Amount"
                leaf cell and surfaces the full breakdown (room + add-ons /
                entrance / extensions) so staff see the real figure the
                guest owes without doing the math in their head. Entrance
                is tagged (at gate) so staff know where it's collected. */}
            {(() => {
              const { amount: entranceAmount } = entranceFeeForBooking(booking, entranceRates);
              const extensions = Number(booking.extensionsTotal ?? 0);
              const grand = Number(booking.total ?? 0) + entranceAmount + extensions;
              const paid = Number(booking.paidAmount ?? booking.reservationFee ?? 0);
              const balance = Math.max(0, grand - paid);
              const groupGrand = (Number(booking.groupSize ?? 1) > 1 && Array.isArray(booking.groupSiblings))
                ? booking.groupSiblings.reduce((s, x) => s + Number(x.total ?? 0), 0)
                : null;
              return (
                <div className="col-span-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-slate-600">Room + Add-ons</span>
                      <span className="font-medium tabular-nums text-slate-800">{fmtMoney(booking.total)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600 flex items-center gap-1">
                        <i className="fas fa-ticket-alt text-amber-500 text-[10px]"></i>
                        Entrance fee
                        <span className="text-[10px] text-amber-600 font-medium">(at gate)</span>
                      </span>
                      <span className="font-medium tabular-nums text-slate-800">{fmtMoney(entranceAmount)}</span>
                    </div>
                    {extensions > 0 && (
                      <div className="flex justify-between">
                        <span className="text-slate-600 flex items-center gap-1">
                          <i className="fas fa-clock-rotate-left text-violet-500 text-[10px]"></i>
                          Stay extensions
                        </span>
                        <span className="font-medium tabular-nums text-violet-700">+{fmtMoney(extensions)}</span>
                      </div>
                    )}
                    <div className="flex justify-between border-t border-slate-200 pt-1.5 mt-1">
                      <span className="font-semibold text-slate-800">Grand total</span>
                      <span className="font-bold tabular-nums text-sky-700 text-base">{fmtMoney(grand)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Paid</span>
                      <span className="tabular-nums text-emerald-700 font-medium">{fmtMoney(paid)}</span>
                    </div>
                    {balance > 0 ? (
                      <div className="flex justify-between text-xs">
                        <span className="text-rose-700 font-semibold">Balance due</span>
                        <span className="tabular-nums text-rose-700 font-bold">{fmtMoney(balance)}</span>
                      </div>
                    ) : (
                      <div className="text-xs text-emerald-700 font-semibold flex items-center gap-1">
                        <i className="fas fa-check-circle"></i>Fully paid
                      </div>
                    )}
                    {groupGrand != null && (
                      <div className="pt-1.5 mt-1.5 border-t border-dashed border-slate-200 text-[11px] text-slate-500">
                        Group total (all {booking.groupSize} rooms):{' '}
                        <span className="text-slate-700 font-semibold tabular-nums">{fmtMoney(groupGrand)}</span>
                        <span className="text-slate-400"> (room + add-ons only — entrance & extensions per room)</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
            <div>
              <p className="text-xs text-slate-500">Guest</p>
              <p className="font-medium">{guestName}</p>
              {wi && <span className="text-xs text-sky-600 bg-sky-50 px-1 rounded">Walk-in</span>}
            </div>
            <div><p className="text-xs text-slate-500">Status</p><StatusBadge status={booking.status} booking={booking} /></div>
            <div><p className="text-xs text-slate-500">Email</p><p>{guestEmail}</p></div>
            <div><p className="text-xs text-slate-500">Phone</p><p>{guestPhone}</p></div>
            <div><p className="text-xs text-slate-500">Room Type</p><p className="font-medium">{booking.roomType}</p></div>
            <div>
              <p className="text-xs text-slate-500">Guests</p>
              <p>{booking.guests} pax</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Check-in</p>
              <p>{fmtDateTime(booking.checkIn)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Check-out</p>
              <p>
                {fmtDateTime(booking.checkOut)}
                {Number(booking.nights ?? 1) > 1 && (
                  <span className="ml-1 text-xs text-amber-700 font-medium">
                    · {booking.nights} nights
                  </span>
                )}
              </p>
            </div>
            {booking.checkedInAt && (
              <div><p className="text-xs text-slate-500">Actual Check-in</p>
                <p className="text-violet-700 font-medium">{fmtDateTime(booking.checkedInAt)}</p></div>
            )}
            {booking.checkedOutAt && (
              <div><p className="text-xs text-slate-500">Actual Check-out</p>
                <p className="text-emerald-700 font-medium">{fmtDateTime(booking.checkedOutAt)}</p></div>
            )}
            <div><p className="text-xs text-slate-500">Payment Method</p><PayIcon method={booking.paymentMethod} /></div>
            {/* GCash proof — Cloudinary image of the guest's confirmation
                screenshot captured at the counter. Clickable thumbnail
                opens the full-size image in a new tab. Spans both grid
                columns so the preview isn't awkwardly cramped. */}
            {booking.gcashRefImageUrl && (
              <div className="col-span-2">
                <p className="text-xs text-slate-500 mb-1">
                  <i className="fas fa-mobile-alt text-sky-500 mr-1"></i>
                  GCash Proof
                </p>
                <a
                  href={booking.gcashRefImageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block rounded border border-slate-200 bg-slate-50 p-1 hover:border-sky-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                  title="Click to view full-size"
                >
                  <img
                    src={booking.gcashRefImageUrl}
                    alt="GCash confirmation screenshot"
                    className="h-32 object-contain rounded bg-white"
                    loading="lazy"
                  />
                  <p className="text-[10px] text-slate-500 text-center mt-1">
                    <i className="fas fa-external-link-alt mr-1"></i>
                    Tap to view full size
                  </p>
                </a>
              </div>
            )}
            {/* Phase 5 — stay extensions list. Renders when any
                extensions have been added to this booking. Each
                row shows the slot the extension added, its window,
                and the amount added to the balance. */}
            {Array.isArray(booking.extensions) && booking.extensions.length > 0 && (
              <div className="col-span-2">
                {/* Tighter card: p-3 -> p-2, no header row (money block
                    already surfaces the "Stay extensions +PHP X" line),
                    just the per-row list with the cancel X on the tail. */}
                <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-2">
                  <ul className="space-y-0.5">
                    {(() => {
                      // Sort by end so the tail (cancellable candidate)
                      // is unambiguous. The X button only shows on the
                      // tail that hasn't started yet — matches the
                      // backend guards (tail-only + start > now).
                      const sorted = [...booking.extensions].sort(
                        (a, b) => new Date(String(a.end).replace(' ', 'T'))
                                - new Date(String(b.end).replace(' ', 'T'))
                      );
                      const tailId = sorted[sorted.length - 1]?.id;
                      const now = new Date();
                      return sorted.map(e => {
                        const typeLbl = e.type === 'night' ? 'Night'
                          : e.type === '24hr'    ? `24hr AM × ${e.nights}`
                          : e.type === '24hr-pm' ? `24hr PM × ${e.nights}`
                          : 'Day';
                        const startDate = new Date(String(e.start).replace(' ', 'T'));
                        const canCancel = e.id === tailId
                          && startDate > now
                          && booking.status === 'Checked In';
                        return (
                          <li key={e.id}
                              className="flex items-center justify-between text-xs px-2 py-1 rounded text-slate-700">
                            <span className="truncate">
                              <i className="fas fa-plus mr-1 text-[10px] text-violet-400" aria-hidden="true"></i>
                              {typeLbl}
                              <span className="ml-1 text-[11px] text-slate-500">
                                {fmtDateTime(e.start)} → {fmtDateTime(e.end)}
                              </span>
                            </span>
                            <span className="flex items-center gap-1 shrink-0">
                              <span className="tabular-nums text-slate-700 font-medium">
                                +{fmtMoney(e.total)}
                              </span>
                              {canCancel && (
                                <button
                                  type="button"
                                  onClick={() => setCancelExtPending({
                                    id: e.id,
                                    label: `${typeLbl} (${fmtDateTime(e.start)} → ${fmtDateTime(e.end)})`,
                                    amount: Number(e.total),
                                  })}
                                  disabled={cancelExtLoading}
                                  className="w-7 h-7 inline-flex items-center justify-center rounded text-rose-600 hover:bg-rose-50 hover:text-rose-800 text-[10px] disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                                  aria-label={`Cancel ${typeLbl} extension`}
                                  title="Cancel this extension (only the most recent one that hasn't started yet)"
                                >
                                  <i className="fas fa-times" aria-hidden="true"></i>
                                </button>
                              )}
                            </span>
                          </li>
                        );
                      });
                    })()}
                  </ul>
                  {/* Inline confirm — fires when staff clicks the X.
                      Previews the overpayment the cancel will create
                      so staff know to reconcile at checkout. */}
                  {cancelExtPending && (() => {
                    const paid   = Number(booking.paidAmount ?? 0);
                    const refund = Number(booking.refundAmount ?? 0);
                    const effectivePaid = paid - refund;
                    const grand  = Number(booking.total ?? 0) + Number(booking.entranceFee ?? 0) + Number(booking.extensionsTotal ?? 0);
                    const futureGrand   = grand - Number(cancelExtPending.amount ?? 0);
                    const futureOverpay = Math.max(0, effectivePaid - futureGrand);
                    const hasOverpay    = futureOverpay > 0;
                    return (
                      <div className="mt-2 rounded-lg bg-rose-50 border border-rose-200 p-2">
                        <p className="text-[11px] text-rose-900 mb-1">
                          Cancel the <span className="font-semibold">{cancelExtPending.label}</span> extension?
                          Removes <span className="font-semibold">{fmtMoney(cancelExtPending.amount)}</span> from the balance.
                        </p>
                        {hasOverpay && (
                          <div className="text-[11px] text-emerald-900 bg-emerald-50 border border-emerald-200 rounded px-2 py-1.5 mb-2 space-y-1">
                            <p className="flex items-start gap-1.5">
                              <i className="fas fa-coins text-emerald-600 mt-0.5" aria-hidden="true"></i>
                              <span>
                                Guest paid <span className="font-semibold">{fmtMoney(effectivePaid)}</span>, new grand total is <span className="font-semibold">{fmtMoney(futureGrand)}</span>.
                                You'll owe the guest <span className="font-bold text-emerald-700">{fmtMoney(futureOverpay)}</span> in cash.
                              </span>
                            </p>
                            <p className="text-[10px] text-emerald-700 ml-5">
                              Pick an option below. Policy: cash / GCash collected at the counter is refundable; online reservation fees paid via PayMongo are NOT.
                            </p>
                          </div>
                        )}
                        {/* Two primary paths when there's an overpayment:
                            RECORD the refund (staff hands cash now, system
                            logs it and nets out of Reports), or CANCEL
                            WITHOUT refund (leaves booking overpaid — staff
                            reconciles manually at checkout). No-overpay
                            case collapses to a single cancel. */}
                        {hasOverpay ? (
                          <div className="flex flex-col gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleCancelExtension({ refundCash: true })}
                              disabled={cancelExtLoading}
                              className="inline-flex items-center justify-center gap-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-[11px] font-semibold py-2 px-2 rounded"
                            >
                              {cancelExtLoading ? (
                                <><i className="fas fa-spinner fa-spin text-[10px]" aria-hidden="true"></i>Recording refund…</>
                              ) : (
                                <><i className="fas fa-check text-[10px]" aria-hidden="true"></i>I've handed back {fmtMoney(futureOverpay)} cash — cancel + record refund</>
                              )}
                            </button>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => handleCancelExtension({ refundCash: false })}
                                disabled={cancelExtLoading}
                                className="flex-1 inline-flex items-center justify-center gap-1 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-[11px] font-semibold py-1.5 px-2 rounded"
                              >
                                <i className="fas fa-times text-[10px]" aria-hidden="true"></i>Cancel without refund
                              </button>
                              <button
                                type="button"
                                onClick={() => setCancelExtPending(null)}
                                disabled={cancelExtLoading}
                                className="flex-1 inline-flex items-center justify-center gap-1 bg-white border border-rose-300 hover:bg-rose-100 text-rose-800 text-[11px] font-semibold py-1.5 px-2 rounded"
                              >
                                Keep extension
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => handleCancelExtension({ refundCash: false })}
                              disabled={cancelExtLoading}
                              className="flex-1 inline-flex items-center justify-center gap-1 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-[11px] font-semibold py-1.5 px-2 rounded"
                            >
                              {cancelExtLoading ? (
                                <><i className="fas fa-spinner fa-spin text-[10px]" aria-hidden="true"></i>Cancelling…</>
                              ) : (
                                <><i className="fas fa-times text-[10px]" aria-hidden="true"></i>Yes, cancel extension</>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => setCancelExtPending(null)}
                              disabled={cancelExtLoading}
                              className="flex-1 inline-flex items-center justify-center gap-1 bg-white border border-rose-300 hover:bg-rose-100 text-rose-800 text-[11px] font-semibold py-1.5 px-2 rounded"
                            >
                              Keep extension
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}

            {/* Phase 5 — "Extend stay" action. Visible only while the
                guest is Checked In. The picker loads valid
                continuations from the backend and shows one card per
                option. For GROUP reservations the outer button is
                hidden — the group panel's "Extend all eligible rooms"
                is the one visible extend entry, and per-room extend
                follows the same pattern as transfer / collect balance
                / no-show (open that sibling's own modal). The picker
                itself still renders when extendOpen is true so the
                group-scoped picker can open from inside the group
                panel on a multi-room booking. */}
            {booking.status === 'Checked In' && (
              <div className="col-span-2">
                {!extendOpen ? (
                  Number(booking.groupSize ?? 1) <= 1 ? (
                    <button
                      type="button"
                      onClick={() => openExtendPicker('room')}
                      className="w-full inline-flex items-center justify-center gap-2 bg-white border-2 border-violet-300 hover:bg-violet-50 text-violet-700 text-xs font-semibold py-2 px-3 rounded-lg transition-colors"
                    >
                      <i className="fas fa-clock-rotate-left text-[10px]" aria-hidden="true"></i>
                      Extend stay
                    </button>
                  ) : null
                ) : (
                  <div className="rounded-xl border-2 border-violet-200 bg-violet-50/40 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold text-violet-900">
                        <i className="fas fa-clock-rotate-left mr-1 text-violet-600"></i>
                        {extendScope === 'group'
                          ? `Extend all eligible rooms in this reservation`
                          : (Number(booking.groupSize ?? 1) > 1
                              ? `Extend ${booking.roomType} only`
                              : 'Extend stay')}
                      </p>
                      <button type="button"
                        onClick={() => { setExtendOpen(false); setExtendResult(null); }}
                        disabled={extendSubmitting}
                        className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1 rounded hover:bg-slate-100"
                      >
                        Close
                      </button>
                    </div>
                    {/* Post-group-extend result. Rendered INSTEAD of the
                        options picker so staff see exactly which rooms
                        got extended and which were skipped, with the
                        reason + a specific hint per skip category. The
                        toast was too fleeting for a partial group
                        outcome. */}
                    {extendResult && (() => {
                      const buckets = [
                        { key: 'type-mismatch',   arr: extendResult.skipped_type_mismatch,   label: 'Slot mismatch',
                          hint: "Those rooms' chain tips are out of sync. Cancel their latest extension to re-sync." },
                        { key: 'room-conflict',   arr: extendResult.skipped_room_conflict,   label: 'Room conflict',
                          hint: 'Those rooms are occupied by another booking during this window.' },
                        { key: 'addon-conflict',  arr: extendResult.skipped_addon_conflict,  label: 'Add-on pool short',
                          hint: "Add-on inventory doesn't cover the extended window. Remove the add-on or shorten the extension." },
                        { key: 'not-checked-in',  arr: extendResult.skipped_not_checked_in,  label: 'Not Checked In',
                          hint: 'Check in first, then re-run.' },
                      ].filter(c => Array.isArray(c.arr) && c.arr.length > 0);
                      const aborted = extendResult.aborted;
                      const extended = Number(extendResult.extended ?? 0);
                      return (
                        <div className="space-y-2">
                          {/* One banner for the headline + the per-category skips —
                              no separate "aborted" subhead, no "nothing was extended"
                              repeat, no 3-line hints. */}
                          <div className={`rounded border px-3 py-2 ${
                            aborted ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50'
                          }`}>
                            <p className={`text-xs font-semibold flex items-center gap-1.5 ${
                              aborted ? 'text-rose-900' : 'text-emerald-900'
                            }`}>
                              <i className={`fas ${aborted ? 'fa-ban text-rose-600' : 'fa-check-circle text-emerald-600'}`} aria-hidden="true"></i>
                              {aborted
                                ? 'Aborted — no rooms extended'
                                : `${extended} room${extended === 1 ? '' : 's'} extended · +${fmtMoney(Number(extendResult.total_added || 0))}`}
                            </p>
                            {!aborted && Array.isArray(extendResult.extended_rooms) && extendResult.extended_rooms.length > 0 && (
                              <p className="text-[11px] text-emerald-800 mt-0.5 ml-5">
                                {extendResult.extended_rooms.join(', ')}
                              </p>
                            )}
                            {buckets.map(c => (
                              <p key={c.key} className={`text-[11px] mt-1 ${aborted ? 'text-rose-800' : 'text-amber-800'}`}>
                                <span className="font-semibold">{c.label}:</span> {c.arr.join(', ')}
                                <span className={`block text-[10px] mt-0.5 ${aborted ? 'text-rose-600' : 'text-amber-600'}`}>
                                  {c.hint}
                                </span>
                              </p>
                            ))}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              if (aborted) {
                                setExtendOpen(false);
                                setExtendResult(null);
                              } else {
                                setExtendOpen(false);
                                setExtendResult(null);
                                onClose?.();
                              }
                            }}
                            className="w-full inline-flex items-center justify-center gap-1 bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold py-2 px-3 rounded"
                          >
                            {aborted ? 'Close' : 'Got it'}
                          </button>
                        </div>
                      );
                    })()}
                    {!extendResult && extendOptionsLoading && (
                      <p className="text-xs text-violet-700">
                        <i className="fas fa-spinner fa-spin mr-1"></i>Loading options…
                      </p>
                    )}
                    {!extendResult && extendError && !extendOptionsLoading && (
                      <p className="text-xs text-rose-600 mb-2">
                        <i className="fas fa-triangle-exclamation mr-1"></i>{extendError}
                      </p>
                    )}
                    {!extendResult && extendOptions && (
                      <>
                        <p className="text-[11px] text-slate-600 mb-2">
                          Current end: <span className="font-medium text-slate-800">{fmtDateTime(extendOptions.current?.endsAt)}</span>.
                          {extendOptions.options.length === 0 && (
                            <span className="ml-1 text-rose-600">No valid continuation from this slot.</span>
                          )}
                        </p>
                        {extendScope === 'group' && Array.isArray(booking.groupSiblings) && (() => {
                          // Count eligible siblings up-front so staff
                          // sees "N of M" scope before confirming.
                          // Backend re-validates per sibling and skips
                          // type-mismatches / overlaps with reasons in
                          // the response summary.
                          const eligible = booking.groupSiblings.filter(s => s.status === 'Checked In').length;
                          return (
                            <p className="text-[11px] text-violet-700 bg-violet-100 rounded px-2 py-1 mb-2">
                              <i className="fas fa-layer-group mr-1" aria-hidden="true"></i>
                              Applies to {eligible} Checked-In room{eligible === 1 ? '' : 's'} of {booking.groupSize} in this reservation.
                              All-or-nothing: if any room conflicts, no rooms are extended — the response will name which rooms blocked and why.
                            </p>
                          );
                        })()}
                        <div className="space-y-2">
                          {extendOptions.options.map(opt => {
                            const active = extendSelected?.type === opt.type;
                            const isMulti = opt.type === '24hr' || opt.type === '24hr-pm';
                            // For 24hr variants, let staff multiply nights client-side.
                            const nights = active && isMulti
                              ? Math.max(1, Math.min(30, Number(extendSelected.nights) || 1))
                              : 1;
                            const total = (opt.rate || 0) * nights;
                            return (
                              <div key={opt.type}
                                className={`rounded-lg border p-2 ${active ? 'border-violet-500 bg-white' : 'border-violet-200 bg-white/60'}`}>
                                <button type="button"
                                  onClick={() => setExtendSelected({ type: opt.type, nights: 1 })}
                                  className="w-full text-left"
                                  aria-pressed={active}
                                >
                                  <div className="flex items-center justify-between">
                                    <span className="text-sm font-semibold text-slate-800">
                                      {opt.type === 'night'    ? 'Night'
                                        : opt.type === '24hr'    ? '24-hour slot (AM)'
                                        : opt.type === '24hr-pm' ? '24-hour slot (PM)'
                                        : 'Day'}
                                    </span>
                                    <span className="text-xs tabular-nums text-slate-700">
                                      {fmtMoney(total)}
                                    </span>
                                  </div>
                                  <p className="text-[11px] text-slate-500 mt-0.5">
                                    {`${fmtDateTime(opt.start)} → ${fmtDateTime(opt.end)}`}
                                    <span className="ml-1 text-slate-400">
                                      · {fmtMoney(opt.rate)} × {nights}
                                    </span>
                                  </p>
                                </button>
                                {active && isMulti && (
                                  <div className="mt-2 flex items-center justify-between rounded bg-amber-50 border border-amber-200 px-2 py-1">
                                    <span className="text-[11px] text-amber-900">
                                      <i className="fas fa-moon mr-1"></i>Nights
                                    </span>
                                    <div className="flex items-center gap-1.5">
                                      <button type="button"
                                        onClick={() => setExtendSelected(s => ({ ...s, nights: Math.max(1, (s.nights || 1) - 1) }))}
                                        disabled={(extendSelected.nights || 1) <= 1}
                                        className="w-6 h-6 rounded bg-white border border-amber-300 text-amber-700 text-[10px] font-bold disabled:opacity-40"
                                        aria-label="Decrease nights"
                                      ><i className="fas fa-minus"></i></button>
                                      <span className="min-w-[2rem] text-center text-xs font-bold text-amber-900 tabular-nums">
                                        {extendSelected.nights || 1}
                                      </span>
                                      <button type="button"
                                        onClick={() => setExtendSelected(s => ({ ...s, nights: Math.min(30, (s.nights || 1) + 1) }))}
                                        disabled={(extendSelected.nights || 1) >= 30}
                                        className="w-6 h-6 rounded bg-white border border-amber-300 text-amber-700 text-[10px] font-bold disabled:opacity-40"
                                        aria-label="Increase nights"
                                      ><i className="fas fa-plus"></i></button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        <div className="mt-3 flex gap-2">
                          <button type="button"
                            onClick={submitExtend}
                            disabled={extendSubmitting || !extendSelected}
                            className="flex-1 inline-flex items-center justify-center gap-1 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-xs font-semibold py-2 px-3 rounded"
                          >
                            {extendSubmitting ? (
                              <><i className="fas fa-spinner fa-spin text-[10px]"></i>Extending…</>
                            ) : (
                              <><i className="fas fa-check text-[10px]"></i>Confirm extension</>
                            )}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Phase 3c: when this booking belongs to a multi-room reservation,
                show the other rooms in the group so staff can jump between
                them without hunting through the bookings list. Hidden for
                classic single-room bookings (groupSize <= 1). */}
            {Number(booking.groupSize ?? 1) > 1 && Array.isArray(booking.groupSiblings) && (
              <div className="col-span-2">
                <div className="rounded-xl border-2 border-sky-200 bg-sky-50/60 p-3">
                  <p className="text-xs font-semibold text-sky-900 flex items-center gap-1.5 mb-2">
                    <i className="fas fa-layer-group text-sky-600" aria-hidden="true"></i>
                    Group reservation
                    {booking.reservationResId && (
                      <span className="font-mono font-normal text-sky-700 text-[11px]">· {booking.reservationResId}</span>
                    )}
                    <span className="ml-auto text-[11px] text-sky-700 font-normal">
                      {booking.groupSize} rooms total
                    </span>
                  </p>
                  {/* Status summary pill — lets staff read the group's
                      mixed state in one line on 4+ room reservations
                      without scanning every row. Only renders when the
                      group spans more than one status. */}
                  {(() => {
                    const counts = {};
                    for (const s of booking.groupSiblings) counts[s.status] = (counts[s.status] || 0) + 1;
                    const summary = Object.entries(counts);
                    if (summary.length <= 1) return null;
                    return (
                      <p className="text-[11px] text-sky-700/90 mb-2 flex flex-wrap items-center gap-x-1.5">
                        {summary.map(([k, v], i) => (
                          <span key={k}>
                            <span className="font-semibold">{v}</span> {k}
                            {i < summary.length - 1 && <span className="text-sky-400"> ·</span>}
                          </span>
                        ))}
                      </p>
                    );
                  })()}
                  {(() => {
                    // Cap member list at 3 so 6-room reservations don't
                    // push the money block + add-ons off-screen. The
                    // current room is pinned so staff never lose context.
                    const cap = 3;
                    const siblings = booking.groupSiblings;
                    const selfId = Number(booking.bookingId);
                    const visible = (showAllGroup || siblings.length <= cap)
                      ? siblings
                      : [
                          ...siblings.filter(s => Number(s.bookingId) === selfId),
                          ...siblings.filter(s => Number(s.bookingId) !== selfId).slice(0, cap - 1),
                        ];
                    const hidden = siblings.length - visible.length;
                    return (
                      <>
                        <ul className="space-y-1">
                          {visible.map(s => {
                            const isSelf = Number(s.bookingId) === Number(booking.bookingId);
                            return (
                              <li key={s.bookingId}
                                  className={`flex items-center justify-between text-xs px-2 py-1 rounded ${isSelf ? 'bg-sky-100 font-semibold text-sky-900' : 'text-slate-700 hover:bg-sky-100/40'}`}>
                                <span className="truncate">
                                  <i className={`fas fa-bed mr-1 text-[10px] ${isSelf ? 'text-sky-700' : 'text-slate-400'}`} aria-hidden="true"></i>
                                  {s.roomName ?? `Room #${s.bookingId}`}
                                  {isSelf && <span className="ml-1 text-[10px] uppercase tracking-wide text-sky-700">(this one)</span>}
                                </span>
                                <span className="flex items-center gap-2 shrink-0">
                                  <span className="text-slate-500 tabular-nums">{fmtMoney(s.total)}</span>
                                  {/* Sibling pill palette mirrors the main status
                                      pill at the top of this modal so the same
                                      booking never renders two different colors
                                      for the same status across views. */}
                                  <span className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                                    s.status === 'Confirmed'   ? 'bg-sky-100 text-sky-800' :
                                    s.status === 'Checked In'  ? 'bg-violet-100 text-violet-800' :
                                    s.status === 'Completed'   ? 'bg-emerald-100 text-emerald-800' :
                                    s.status === 'Cancelled'   ? 'bg-rose-100 text-rose-800' :
                                    s.status === 'Pending'     ? 'bg-amber-100 text-amber-800' :
                                    s.status === 'No-Show'     ? 'bg-slate-200 text-slate-800' :
                                    'bg-slate-100 text-slate-800'
                                  }`}>
                                    {s.status}
                                  </span>
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                        {hidden > 0 && (
                          <button
                            type="button"
                            onClick={() => setShowAllGroup(true)}
                            className="mt-1 w-full text-center text-[11px] text-sky-700 hover:text-sky-900 py-1 rounded hover:bg-sky-100/40"
                          >
                            Show {hidden} more ▾
                          </button>
                        )}
                        {showAllGroup && siblings.length > cap && (
                          <button
                            type="button"
                            onClick={() => setShowAllGroup(false)}
                            className="mt-1 w-full text-center text-[11px] text-sky-700 hover:text-sky-900 py-1 rounded hover:bg-sky-100/40"
                          >
                            Show less ▴
                          </button>
                        )}
                      </>
                    );
                  })()}
                  {/* Group bulk actions ("Check in all", "Extend all",
                      etc.) sit alongside per-row actions at the bottom
                      of the modal. Scope is in the button text itself
                      ("Check out all" vs "Check Out"). */}
                  <p className="mt-2 text-[11px] text-sky-700/80">
                    Actions marked <strong>“all”</strong> below apply to every sibling in this reservation. The rest apply only to {booking.roomType}.
                  </p>
                </div>
              </div>
            )}
            {booking.promoCode && Number(booking.discount) > 0 && (
              <div className="col-span-2">
                <div className="flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2">
                    <i className="fas fa-tag text-emerald-600 text-xs"></i>
                    <div>
                      <p className="text-xs text-emerald-700 font-semibold">Promo Applied</p>
                      <p className="text-sm font-mono font-bold text-emerald-800">{booking.promoCode}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-emerald-700">Discount</p>
                    <p className="text-sm font-bold text-emerald-800">−{fmtMoney(booking.discount)}</p>
                  </div>
                </div>
              </div>
            )}
            {!['Completed','Cancelled'].includes(booking.status) && !booking.promoCode && (
              <div className="col-span-2">
                <p className="text-xs text-slate-500 mb-1">Apply Promo Code</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={promoInput}
                    onChange={e => { setPromoInput(e.target.value.toUpperCase()); setPromoError(''); }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleApplyPromo(); } }}
                    placeholder="Enter promo code"
                    aria-label="Promo code"
                    className="flex-1 min-h-11 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 font-mono uppercase"
                  />
                  <button
                    type="button"
                    onClick={handleApplyPromo}
                    disabled={promoLoading || !promoInput.trim()}
                    aria-label="Apply promo code"
                    className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
                  >
                    {promoLoading ? <i className="fas fa-spinner fa-spin" aria-hidden="true"></i> : 'Apply'}
                  </button>
                </div>
                {promoError && <p className="text-xs text-rose-500 mt-1">{promoError}</p>}
              </div>
            )}
            <div className="col-span-2">
              <p className="text-xs text-slate-500">Booked On</p>
              <p>{fmtDateTime(booking.createdAt)}</p>
            </div>
          </div>

          {/* Special requests — prominent callout so frontdesk staff can't
              miss guest-authored notes (e.g. allergies, early check-in,
              anniversary requests). Works for both regular and walk-in
              bookings (walk-in metadata lives in specialRequests as well,
              so we surface the Notes: slice only). */}
          {(() => {
            const note = wi ? wi.notes : booking.specialRequests;
            if (!note) return null;
            return (
              <div className="mt-4 rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 flex gap-3 shadow-sm">
                <div className="shrink-0 w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center">
                  <i className="fas fa-note-sticky text-amber-600" aria-hidden="true"></i>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                    Special request from guest
                  </p>
                  <p className="mt-1 text-sm text-amber-900 whitespace-pre-wrap break-words">
                    {note}
                  </p>
                </div>
              </div>
            );
          })()}

          {/* Guest count editor — entrance fee moved to the money block
              above so staff see the full grand total in one glance
              instead of two stacked amber cards. */}
          {['Confirmed', 'Checked In'].includes(booking.status) && (
                  <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <i className="fas fa-users text-amber-600"></i>
                      <span className="text-sm font-semibold text-amber-900">Number of Guests</span>
                    </div>
                    {guestEdit ? (
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => setGuestCount(g => Math.max(1, g - 1))}
                          aria-label="Decrease guest count"
                          className="w-11 h-11 rounded-lg bg-white border border-amber-300 hover:bg-amber-100 text-base font-bold text-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2">−</button>
                        {/* Typeable count — staff can either step with ± or
                            tab into the input and type. type="number" gives
                            mobile staff the numeric keyboard (Apple HIG +
                            Material input-type-keyboard guideline). Validate
                            on blur (Material inline-validation: don't yell
                            on every keystroke) — snap empty/<1 back to 1
                            so handleUpdateGuests never POSTs an invalid
                            value. Width fits 3 digits comfortably. */}
                        <input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          step={1}
                          value={guestCount}
                          onChange={(e) => {
                            const v = e.target.value;
                            // Allow transient empty while typing — clamp on blur.
                            if (v === '') { setGuestCount(''); return; }
                            const n = parseInt(v, 10);
                            if (!Number.isNaN(n)) setGuestCount(n);
                          }}
                          onBlur={() => {
                            const n = parseInt(guestCount, 10);
                            setGuestCount(Number.isNaN(n) || n < 1 ? 1 : n);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              e.currentTarget.blur();
                              handleUpdateGuests();
                            }
                          }}
                          aria-label="Number of guests"
                          className="h-11 w-16 text-center font-bold text-lg text-amber-900 bg-white border border-amber-300 rounded-lg tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button type="button" onClick={() => setGuestCount(g => g + 1)}
                          aria-label="Increase guest count"
                          className="w-11 h-11 rounded-lg bg-white border border-amber-300 hover:bg-amber-100 text-base font-bold text-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2">+</button>
                        <button type="button" onClick={handleUpdateGuests} disabled={guestLoading}
                          aria-label="Save guest count"
                          className="ml-2 inline-flex items-center justify-center min-h-11 px-4 py-2 bg-amber-600 text-white rounded-lg text-xs font-bold hover:bg-amber-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2">
                          {guestLoading ? '…' : 'Save'}
                        </button>
                        <button type="button" onClick={() => { setGuestEdit(false); setGuestCount(booking.guests); }}
                          aria-label="Cancel guest count edit"
                          className="inline-flex items-center justify-center min-h-11 w-11 bg-white border border-amber-300 text-amber-700 rounded-lg text-xs hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2">✕</button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => { setGuestEdit(true); setGuestCount(booking.guests); }}
                        aria-label="Edit guest count"
                        className="inline-flex items-center gap-2 min-h-11 px-3 py-1.5 bg-white border border-amber-300 rounded-lg text-sm font-medium text-amber-800 hover:bg-amber-100 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2">
                        <span className="font-bold text-lg">{booking.guests}</span>
                        <span className="text-xs">pax</span>
                        <i className="fas fa-pen text-xs text-amber-500 ml-1" aria-hidden="true"></i>
                      </button>
                    )}
                  </div>
                )}

          {/* Add-ons */}
          <div className="mb-4">
            <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Add-ons</p>
            {(booking.amenities?.length ?? 0) === 0 ? (
              <p className="text-xs text-slate-600 mb-2">No add-ons added.</p>
            ) : (
              <div className="space-y-1 mb-2">
                {booking.amenities.map(a => {
                  const catalog  = addonCatalog.find(c => c.name === a.name);
                  const perBookg = catalog?.per_booking;
                  const maxQty   = catalog?.max_qty ?? 10;
                  const canEdit  = ['Confirmed', 'Checked In'].includes(booking.status) && !perBookg;
                  const isEditing = editingAmenity?.id === a.id;
                  const liveTotal = Number(a.unitPrice ?? a.unit_price ?? 0) * (editingAmenity?.qty ?? 1);
                  // Edit-qty cap = `remaining` from the availability endpoint
                  // verbatim. The API already subtracts what OTHER overlapping
                  // bookings hold (excludes self) and caps at max_qty, so it's
                  // exactly how high this booking's qty may climb.
                  //   pool=6, we hold 3, others hold 2 → remaining=4 (correct cap)
                  //   pool=6, we hold 3, others hold 0 → remaining=6 (correct cap)
                  const availRow = catalog ? addonAvailability[catalog.id] : null;
                  const editCap  = availRow?.remaining ?? maxQty;

                  if (isEditing) {
                    const stagedQty = editingAmenity.qty || 1;
                    const atEditCap = stagedQty >= editCap;
                    // Global pool free = max − (others' allocation) − (staged qty).
                    // `remaining` already equals max − others' allocation, so we
                    // just subtract the live staged qty. Updates as user clicks
                    // ±, so "3 of 6 left in pool" tracks the edit in real time.
                    const freeInPool = availRow?.remaining != null
                      ? Math.max(0, availRow.remaining - stagedQty)
                      : null;
                    return (
                      <div key={a.id} className="flex items-center gap-2 bg-sky-50 border border-sky-200 rounded px-3 py-2 text-sm flex-wrap">
                        <i className={`fas ${catalog?.icon || 'fa-tag'} text-slate-500`} aria-hidden="true"></i>
                        <span className="truncate flex-1">{a.name}</span>
                        <span className="text-xs text-slate-600">Qty:</span>
                        <button
                          type="button"
                          onClick={() => setEditingAmenity(e => ({ ...e, qty: Math.max(1, (e.qty || 1) - 1) }))}
                          aria-label={`Decrease ${a.name} quantity`}
                          className="w-11 h-11 border border-slate-300 rounded text-sm bg-white hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2">−</button>
                        <span className="w-8 text-center text-sm tabular-nums" aria-live="polite">{editingAmenity.qty}</span>
                        <button
                          type="button"
                          onClick={() => setEditingAmenity(e => ({ ...e, qty: Math.min(editCap, (e.qty || 1) + 1) }))}
                          aria-label={`Increase ${a.name} quantity`}
                          disabled={atEditCap}
                          title={atEditCap ? `Pool limit reached — cap is ${editCap} for this booking window.` : undefined}
                          className="w-11 h-11 border border-slate-300 rounded text-sm bg-white hover:bg-slate-50 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2">+</button>
                        <span className="text-xs font-medium text-sky-700 w-20 text-right">
                          {fmtMoney(liveTotal)}
                        </span>
                        {freeInPool != null && (
                          <span className="basis-full text-[11px] text-slate-500">
                            {freeInPool} of {maxQty} left in pool
                            {availRow.allocated > 0 ? ` (${availRow.allocated} held by other bookings in this window)` : ''}.
                          </span>
                        )}
                        <button
                          onClick={handleUpdateAmenity}
                          disabled={amenityLoading}
                          aria-label={`Save quantity change for ${a.name}`}
                          className="w-11 h-11 inline-flex items-center justify-center rounded text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                          title="Save"
                          type="button"
                        >
                          <i className="fas fa-check" aria-hidden="true"></i>
                        </button>
                        <button
                          onClick={() => setEditingAmenity(null)}
                          disabled={amenityLoading}
                          aria-label="Cancel qty change"
                          className="w-11 h-11 inline-flex items-center justify-center rounded text-slate-600 hover:bg-slate-100 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                          title="Cancel"
                          type="button"
                        >
                          <i className="fas fa-times" aria-hidden="true"></i>
                        </button>
                      </div>
                    );
                  }

                  // Pool-free for the read-only row = remaining (excl self) − own qty.
                  // Shown inline so staff can see "N of M left in pool" at a glance
                  // without clicking the pencil first.
                  const rowPoolFree = availRow?.remaining != null
                    ? Math.max(0, availRow.remaining - (a.qty || 0))
                    : null;
                  return (
                    <div key={a.id} className="flex items-center justify-between bg-slate-50 rounded px-3 py-2 text-sm">
                      <span className="flex items-center gap-2 min-w-0">
                        <i className={`fas ${catalog?.icon || 'fa-tag'} text-slate-500`} aria-hidden="true"></i>
                        <span className="truncate">
                          {a.name}{a.qty > 1 && ` × ${a.qty}`}
                          {rowPoolFree != null && (
                            <span className="ml-2 text-[11px] text-slate-400 font-normal">
                              · {rowPoolFree} of {maxQty} left in pool
                            </span>
                          )}
                        </span>
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-slate-600 text-xs mr-1">{fmtMoney(a.total)}</span>
                        {canEdit && (
                          <button
                            onClick={() => {
                              // Fire a fresh availability fetch so the stepper's
                              // "left in pool" count is current, not stale from
                              // when the modal opened minutes ago.
                              refreshAddonAvailability();
                              setEditingAmenity({ id: a.id, qty: a.qty || 1, max: maxQty });
                            }}
                            disabled={amenityLoading}
                            className="w-11 h-11 inline-flex items-center justify-center rounded text-slate-600 hover:bg-slate-200 hover:text-slate-800 text-xs disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                            title={`Edit ${a.name} quantity`}
                            type="button"
                            aria-label={`Edit ${a.name} quantity`}
                          >
                            <i className="fas fa-pen" aria-hidden="true"></i>
                          </button>
                        )}
                        {['Confirmed', 'Checked In'].includes(booking.status) && (
                          <button
                            onClick={() => setPendingAction({ type: 'remove-amenity', amenityId: a.id, amenityName: a.name, amenityTotal: a.total })}
                            disabled={amenityLoading}
                            className="w-11 h-11 inline-flex items-center justify-center rounded text-rose-600 hover:bg-rose-50 hover:text-rose-800 text-xs disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                            title={`Remove ${a.name}`}
                            type="button"
                            aria-label={`Remove ${a.name}`}
                          >
                            <i className="fas fa-times" aria-hidden="true"></i>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {['Confirmed', 'Checked In'].includes(booking.status) && addonCatalog.length > 0 && (() => {
              // Filter the catalog by this booking's room the same way
              // the walk-in + guest booking forms do:
              //   - Addons in NO room_addons pivot → shared pool, show as-is
              //   - Addons attached to THIS room as 'optional' → show with
              //     per-room price override
              //   - Addons attached to other rooms (any relation) → hidden
              //   - Package attachments anywhere → also hidden; they're
              //     auto-created at booking time and live in booking.amenities
              //     already (pencil-editable).
              // Backend AmenityController::store applies the same per-room
              // price lookup on write, so the ₱ shown here matches what
              // lands on the receipt.
              const bookingRoom    = rooms.find(r => String(r.id) === String(booking.roomId));
              const roomScopedIds  = new Set();
              for (const rm of rooms) {
                for (const a of (rm.attached_addons ?? [])) roomScopedIds.add(a.id);
              }
              const thisRoomOpt = new Map(
                (bookingRoom?.attached_addons ?? [])
                  .filter(a => a.relation === 'optional')
                  .map(a => [a.id, a])
              );
              // Tag each visible row with `relation` so the picker can
              // render a "For [room]" badge on optional room-fixture
              // items — important when catalog has look-alike names
              // like "Videoke (Hourly)" (shared) vs "Videoke (Red
              // Pavilion)" (room-fixture). Optionals sort first so
              // staff see room-specific items before shared-pool.
              const visibleCatalog = addonCatalog.flatMap(c => {
                if (!roomScopedIds.has(c.id)) return [{ ...c, relation: 'shared' }];
                const opt = thisRoomOpt.get(c.id);
                if (!opt) return [];                                                       // attached elsewhere or package here
                return [{ ...c, relation: 'optional', price: Number(opt.price) }];         // per-room override
              }).sort((a, b) => {
                if (a.relation === b.relation) return 0;
                return a.relation === 'optional' ? -1 : 1;
              });

              // Guard against duplicate add-on rows. The backend's addAmenity
              // endpoint creates a new BookingAmenity row every call, so
              // "add Parking Fee ×5" then "add Parking Fee ×5" leaves two
              // separate ₱400 lines — confusing for staff and cash collection.
              //
              // There's no `update qty` endpoint to merge client-side, so we
              // block the picker for add-ons already attached and point staff
              // to the existing row if they want a different quantity.
              const attachedNames = new Set((booking.amenities || []).map(a => a.name));
              const pickable      = visibleCatalog.filter(c => !attachedNames.has(c.name));
              const isAttached    = (name) => attachedNames.has(name);
              // "Sold out" = inventory pool exhausted by *other* bookings in
              // this window. We can still edit our own existing row via the
              // pencil, but the picker shouldn't offer a fresh add.
              const remainingFor  = (id) => addonAvailability[id]?.remaining;
              const isSoldOut     = (cat) => remainingFor(cat.id) === 0 && !isAttached(cat.name);
              const selectable    = pickable.filter(c => !isSoldOut(c));
              const noneLeft      = selectable.length === 0;
              const selAvail      = addingAmenity ? addonAvailability[addingAmenity.id] : null;
              const qtyCap        = addingAmenity
                ? Math.min(addingAmenity.max_qty || 10, selAvail?.remaining ?? (addingAmenity.max_qty || 10))
                : 10;

              return addingAmenity ? (
                <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Add Add-on</p>
                  </div>
                  {/* Vertical list — one row per addon. Previous layout was
                      cramped horizontal pills with wrapped multi-line
                      labels; this reads left-to-right like a menu. */}
                  <div className="divide-y divide-slate-100">
                    {visibleCatalog.map(cat => {
                      const attached  = isAttached(cat.name);
                      const soldOut   = isSoldOut(cat);
                      const disabled  = attached || soldOut;
                      const selected  = addingAmenity.name === cat.name;
                      const remaining = remainingFor(cat.id);
                      const status = attached ? 'Already added'
                                   : soldOut  ? 'Sold out'
                                   : remaining != null ? `${remaining} of ${cat.max_qty} left in pool`
                                   : null;
                      const title = attached
                        ? 'Already on this booking — use the pencil icon above to edit its quantity.'
                        : soldOut
                          ? 'All units of this add-on are booked during this booking window.'
                          : undefined;
                      const isOptional = cat.relation === 'optional';
                      return (
                        <button
                          key={cat.id}
                          type="button"
                          disabled={disabled}
                          onClick={() => !disabled && setAddingAmenity({ id: cat.id, name: cat.name, qty: 1, unit_price: cat.price, per_booking: cat.per_booking, max_qty: cat.max_qty, icon: cat.icon })}
                          title={title}
                          aria-label={attached ? `${cat.name} — already added to this booking` : soldOut ? `${cat.name} — sold out` : `Select ${cat.name}`}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                            selected  ? 'bg-sky-50'
                            : disabled ? 'bg-slate-50/60 cursor-not-allowed'
                            : isOptional ? 'bg-amber-50/50 hover:bg-amber-50 border-l-4 border-l-amber-400'
                            : 'hover:bg-slate-50'
                          }`}
                        >
                          <i className={`fas ${cat.icon || 'fa-tag'} w-4 text-center text-[13px] shrink-0 ${
                            selected ? 'text-sky-600'
                            : disabled ? 'text-slate-300'
                            : isOptional ? 'text-amber-600'
                            : 'text-slate-400'
                          }`} aria-hidden="true"></i>
                          {/* Name + (if optional) room badge stacked so
                              the name always gets full width — badge
                              doesn't squeeze the name into an ellipsis. */}
                          <div className="min-w-0 flex-1">
                            <div className={`text-sm font-medium truncate ${
                              disabled ? 'text-slate-400' : selected ? 'text-sky-800' : 'text-slate-700'
                            }`}>{cat.name}</div>
                            {isOptional && (
                              <div className="mt-0.5">
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-400 text-white text-[10px] font-bold uppercase tracking-wide shadow-sm">
                                  <i className="fas fa-link text-[9px]" aria-hidden="true"></i>For {bookingRoom?.name || 'this room'}
                                </span>
                              </div>
                            )}
                          </div>
                          {status && (
                            <span className={`text-[11px] shrink-0 ${
                              soldOut ? 'text-rose-500' : disabled ? 'text-slate-400' : 'text-slate-400'
                            }`}>{status}</span>
                          )}
                          <span className={`text-xs tabular-nums w-20 text-right shrink-0 ${
                            disabled ? 'text-slate-400' : selected ? 'text-sky-700 font-semibold' : 'text-slate-600'
                          }`}>
                            ₱{Number(cat.price).toLocaleString()}
                            <span className="text-[10px] text-slate-400 ml-0.5">{cat.per_booking ? 'flat' : '/ea'}</span>
                          </span>
                          {selected && !disabled && (
                            <i className="fas fa-check-circle text-sky-600 text-sm shrink-0" aria-hidden="true"></i>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {/* Qty + total + actions */}
                  <div className="px-4 py-3 bg-slate-50 border-t border-slate-100 space-y-2">
                    {!addingAmenity.per_booking && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-slate-600">Qty</span>
                        <button type="button" onClick={() => setAddingAmenity(a => ({ ...a, qty: Math.max(1, (a.qty || 1) - 1) }))}
                          aria-label={`Decrease ${addingAmenity.name} quantity`}
                          className="w-11 h-11 border border-slate-300 rounded bg-white text-sm hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2">−</button>
                        <span className="w-8 text-center text-sm font-medium tabular-nums" aria-live="polite">{addingAmenity.qty}</span>
                        <button type="button" onClick={() => setAddingAmenity(a => ({ ...a, qty: Math.min(qtyCap, (a.qty || 1) + 1) }))}
                          aria-label={`Increase ${addingAmenity.name} quantity`}
                          disabled={(addingAmenity.qty || 1) >= qtyCap}
                          className="w-11 h-11 border border-slate-300 rounded bg-white text-sm hover:bg-slate-100 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2">+</button>
                        <span className="ml-auto text-sm font-semibold text-sky-700 tabular-nums">
                          ₱{(Number(addingAmenity.qty || 1) * Number(addingAmenity.unit_price || 0)).toLocaleString()}
                        </span>
                      </div>
                    )}
                    {selAvail?.remaining != null && (() => {
                      const stagedQty  = addingAmenity.qty || 1;
                      const freeInPool = Math.max(0, selAvail.remaining - stagedQty);
                      return (
                        <p className="text-[11px] text-slate-500">
                          {freeInPool} of {addingAmenity.max_qty} left in pool after this add
                          {selAvail.allocated > 0 ? ` (${selAvail.allocated} held by other bookings)` : ''}.
                        </p>
                      );
                    })()}
                    <div className="flex gap-2 justify-end pt-1">
                      <button type="button" onClick={() => setAddingAmenity(null)}
                        className="inline-flex items-center justify-center min-h-11 px-4 py-2 border border-slate-300 rounded text-xs font-medium text-slate-700 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">Cancel</button>
                      <button type="button" onClick={handleAddAmenity} disabled={amenityLoading || isAttached(addingAmenity.name)}
                        title={isAttached(addingAmenity.name) ? 'Already on this booking.' : undefined}
                        className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-sky-600 text-white rounded text-xs font-semibold hover:bg-sky-700 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2">
                        {amenityLoading ? 'Adding…' : 'Add'}
                      </button>
                    </div>
                  </div>
                </div>
              ) : noneLeft ? (
                <p className="text-xs text-slate-600 italic">
                  {pickable.length === 0
                    ? 'All add-ons are already on this booking. Use the pencil icon above to change a quantity, or the × to remove.'
                    : 'All available add-ons are sold out for this booking window.'}
                </p>
              ) : (
                <button
                  onClick={() => {
                    // Refresh availability so the picker greys out anything
                    // another booking has claimed since the modal opened.
                    refreshAddonAvailability();
                    const first = selectable[0];
                    setAddingAmenity({ id: first.id, name: first.name, qty: 1, unit_price: first.price, per_booking: first.per_booking, max_qty: first.max_qty, icon: first.icon });
                  }}
                  className="text-xs text-sky-700 hover:text-sky-800 inline-flex items-center gap-1 px-1 py-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded"
                >
                  <i className="fas fa-plus-circle" aria-hidden="true"></i> Add add-on
                </button>
              );
            })()}
          </div>

          {/* Transfer Room Picker — portaled dialog (step 1 of 2).
              Shows a target-room dropdown on top of the booking modal.
              Clicking "Review Transfer" opens the second dialog below
              which previews rate deltas before committing the move. */}
          {transferOpen && createPortal(
            <div
              className="fixed inset-0 z-[99998] flex items-center justify-center px-4"
              role="dialog" aria-modal="true" aria-label="Transfer to another room"
              onMouseDown={e => e.target === e.currentTarget && !transferring && !transferConfirmOpen && (setTransferOpen(false), setTransferRoomId(''))}
            >
              <div className="absolute inset-0 bg-black/50" />
              <div ref={transferPickerRef} tabIndex={-1} className="relative w-full max-w-sm rounded-xl border border-violet-200 bg-violet-50 p-4 shadow-2xl animate-hero-fade-in opacity-0 focus:outline-none">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-full bg-violet-600 flex items-center justify-center shrink-0">
                  <i className="fas fa-exchange-alt text-white text-xs" aria-hidden="true"></i>
                </div>
                <div>
                  <p className="font-semibold text-sm text-violet-900">Transfer to Another Room</p>
                  <p className="text-xs text-violet-700">Currently in: <strong>{booking.roomType}</strong></p>
                </div>
              </div>
              {roomsLoading ? (
                <p className="text-xs text-violet-600"><i className="fas fa-spinner fa-spin mr-1"></i>Loading rooms...</p>
              ) : (() => {
                // Match the Reservation page / backend transferRoom guard:
                // count overlapping active stays per room id, then allow
                // the room only while count < room.quantity. Parse date
                // strings via .replace(' ', 'T') so Safari / strict engines
                // don't return Invalid Date on "YYYY-MM-DD HH:mm".
                const parseDT = (s) => new Date(String(s ?? '').replace(' ', 'T'));
                const transferStart = parseDT(booking.checkIn);
                const transferEnd   = parseDT(booking.checkOut);
                const overlapCounts = new Map();
                for (const b of allBookings) {
                  if (b.bookingId === booking.bookingId) continue;
                  if (['Cancelled', 'Completed', 'No-Show'].includes(b.status)) continue;
                  const s = parseDT(b.checkIn);
                  const e = parseDT(b.checkOut);
                  if (isNaN(s.getTime()) || isNaN(e.getTime())) continue;
                  if (s < transferEnd && e > transferStart) {
                    overlapCounts.set(b.roomId, (overlapCounts.get(b.roomId) ?? 0) + 1);
                  }
                }
                const available = rooms.filter(r => {
                  if (String(r.id) === String(booking.roomId)) return false;
                  // Pseudo-room guard — the 'admission' category is the
                  // Entrance Only gate-walk-in row, not a real stayable
                  // unit. Backend rejects this too, but filtering here
                  // keeps it out of the dropdown entirely.
                  if (r.category === 'admission') return false;
                  // Booking-type compatibility — skip rooms that don't
                  // accept this booking's type. Empty/null
                  // allowed_booking_types means the room accepts all.
                  const allowed = r.allowed_booking_types;
                  if (Array.isArray(allowed) && allowed.length > 0
                      && !allowed.includes(booking.bookingType)) {
                    return false;
                  }
                  const taken = overlapCounts.get(r.id) ?? 0;
                  const qty   = Number(r.quantity ?? 1);
                  return taken < qty;
                });
                if (available.length === 0) {
                  return (
                    <p className="text-sm text-rose-700 mb-3">
                      No other rooms have free units for this time slot.
                    </p>
                  );
                }
                return (
                  <select value={transferRoomId} onChange={e => setTransferRoomId(e.target.value)}
                    aria-label="Transfer to room"
                    className="w-full border border-violet-200 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-violet-400 bg-white">
                    <option value="">Select a room...</option>
                    {available.map(r => {
                      const qty   = Number(r.quantity ?? 1);
                      const taken = overlapCounts.get(r.id) ?? 0;
                      const free  = Math.max(0, qty - taken);
                      const suffix = qty > 1 ? ` — ${free} of ${qty} free` : '';
                      return (
                        <option key={r.id} value={r.id}>{r.name}{suffix}</option>
                      );
                    })}
                  </select>
                );
              })()}
              <div className="flex gap-2">
                <button type="button" onClick={() => { setTransferOpen(false); setTransferRoomId(''); }}
                  className="flex-1 inline-flex items-center justify-center min-h-11 px-3 py-2 border border-slate-300 bg-white rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
                  Cancel
                </button>
                <button type="button" onClick={() => setTransferConfirmOpen(true)}
                  disabled={!transferRoomId || transferring || roomsLoading}
                  className="flex-1 inline-flex items-center justify-center min-h-11 px-3 py-2 bg-violet-600 text-white rounded-lg text-xs font-bold hover:bg-violet-700 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2">
                  <i className="fas fa-arrow-right mr-1" aria-hidden="true"></i>Review Transfer
                </button>
              </div>
              </div>
            </div>,
            document.body
          )}

          {/* Transfer confirmation modal — shown AFTER picking a target
              room. Previews the rate change so staff can't accidentally
              upgrade a guest at the old rate. Downgrades get a neutral
              "no rate change" message since the resort doesn't refund
              the difference. Portaled at z-[99999] so it sits above
              the picker dialog (z-[99998]) when both are open. */}
          {transferConfirmOpen && transferPreview && createPortal(
            <div
              className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/50 p-4"
              onMouseDown={e => e.target === e.currentTarget && !transferring && setTransferConfirmOpen(false)}
            >
              <div
                ref={transferDialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="transfer-confirm-title"
                className="bg-white rounded-2xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto"
              >
                <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3">
                  <span className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                    transferPreview.isUpgrade ? 'bg-amber-100' : 'bg-violet-100'
                  }`}>
                    <i className={`fas fa-exchange-alt text-sm ${
                      transferPreview.isUpgrade ? 'text-amber-700' : 'text-violet-700'
                    }`} aria-hidden="true" />
                  </span>
                  <div className="flex-1">
                    <h3 id="transfer-confirm-title" className="text-lg font-bold text-slate-900">Confirm Room Transfer</h3>
                    <p className="text-xs text-slate-500">Booking {booking.id}</p>
                  </div>
                </div>

                <div className="p-5 space-y-4">
                  {/* Room move line */}
                  <div className="flex items-center gap-3 bg-slate-50 rounded-lg p-3">
                    <div className="flex-1">
                      <p className="text-xs text-slate-500">From</p>
                      <p className="text-sm font-semibold text-slate-800">{booking.roomType}</p>
                    </div>
                    <i className="fas fa-arrow-right text-slate-400 text-xs" />
                    <div className="flex-1 text-right">
                      <p className="text-xs text-slate-500">To</p>
                      <p className="text-sm font-semibold text-slate-800">{transferPreview.targetName}</p>
                    </div>
                  </div>

                  {/* Rate delta */}
                  {transferPreview.isUpgrade ? (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-1.5">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-amber-800">Room rate</span>
                        <span className="text-amber-900 font-medium">
                          ₱{Number(transferPreview.oldRate).toLocaleString('en-PH')}
                          <i className="fas fa-arrow-right mx-2 text-amber-500 text-[10px]" />
                          ₱{Number(transferPreview.newRate).toLocaleString('en-PH')}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm pt-1.5 border-t border-amber-200">
                        <span className="text-amber-800 font-semibold">Balance due at counter</span>
                        <span className="text-amber-900 font-bold text-base">
                          +₱{Number(transferPreview.balanceChange).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </div>
                      <p className="text-[11px] text-amber-700 pt-1">
                        Staff will collect this difference from the guest after the transfer.
                      </p>
                    </div>
                  ) : (
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                      <p className="text-sm text-slate-700">
                        <i className="fas fa-check-circle text-emerald-500 mr-1.5"></i>
                        <span className="font-semibold">No rate change.</span>
                        {' '}Original pricing (₱{Number(transferPreview.oldRate).toLocaleString('en-PH')}) is preserved.
                      </p>
                    </div>
                  )}
                </div>

                <div className="px-5 py-4 border-t border-slate-100 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setTransferConfirmOpen(false)}
                    disabled={transferring}
                    className="flex-1 inline-flex items-center justify-center min-h-11 px-4 py-2 border border-slate-300 bg-white rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleTransfer}
                    disabled={transferring}
                    className={`flex-1 inline-flex items-center justify-center min-h-11 px-4 py-2 text-white rounded-lg text-sm font-bold disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                      transferPreview.isUpgrade
                        ? 'bg-amber-600 hover:bg-amber-700 focus-visible:ring-amber-500'
                        : 'bg-violet-600 hover:bg-violet-700 focus-visible:ring-violet-500'
                    }`}
                  >
                    {transferring
                      ? <><i className="fas fa-spinner fa-spin mr-1" aria-hidden="true"></i>Transferring...</>
                      : <><i className="fas fa-check mr-1" aria-hidden="true"></i>Confirm Transfer</>}
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )}

          {/* Actions — hidden while confirmation is pending.
              Two-tier for group bookings: "All N rooms" first (every
              sibling), then "This room — <RoomType>" (just the one open
              in the modal). Singles collapse to a single flat row. */}
          {!pendingAction && (
            <div className="pt-4 border-t space-y-3">
              {/* "All N rooms" group bulk actions row. Only renders
                  when the booking is part of a multi-room reservation
                  AND at least one bulk action is eligible for the
                  current sibling-status mix. */}
              {Number(booking.groupSize ?? 1) > 1 && Array.isArray(booking.groupSiblings) && (() => {
                const hasCheckIn   = booking.groupSiblings.some(s => s.status === 'Confirmed' || s.status === 'No-Show');
                const hasCheckOut  = booking.groupSiblings.some(s => s.status === 'Checked In');
                const hasExtend    = hasCheckOut;
                const hasMarkNS    = booking.groupSiblings.some(s =>
                  s.status === 'Confirmed' && (s.bookingType === 'day' || s.bookingType === 'night')
                );
                const hasRevertNS  = booking.groupSiblings.some(s => s.status === 'No-Show');
                const hasCancel    = booking.groupSiblings.some(s => s.status === 'Pending' || s.status === 'Confirmed');
                const anyAction = hasCheckIn || hasCheckOut || hasExtend || hasMarkNS || hasRevertNS || hasCancel;
                if (!anyAction) return null;
                return (
                  <div>
                    {/* Inline confirm for mark-no-show-all preempts the
                        button row so the confirm isn't buried mid-row. */}
                    {hasMarkNS && groupMarkNoShowConfirm && (
                      <div className="mb-2 rounded-lg bg-amber-50 border border-amber-200 p-2">
                        <p className="text-[11px] text-amber-900 mb-2">
                          Mark all eligible Day/Night rooms as no-show? Promo credit (if any) is released. Use the reversal action to undo.
                        </p>
                        <div className="flex gap-2">
                          <button type="button" onClick={handleGroupMarkNoShow} disabled={groupMarkNoShowLoading}
                            className="flex-1 inline-flex items-center justify-center gap-1 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-[11px] font-semibold py-1.5 px-2 rounded">
                            {groupMarkNoShowLoading
                              ? <><i className="fas fa-spinner fa-spin text-[10px]"></i>Marking…</>
                              : <><i className="fas fa-check text-[10px]"></i>Yes, mark no-show</>}
                          </button>
                          <button type="button" onClick={() => setGroupMarkNoShowConfirm(false)} disabled={groupMarkNoShowLoading}
                            className="flex-1 inline-flex items-center justify-center gap-1 bg-white border border-amber-300 hover:bg-amber-100 text-amber-900 text-[11px] font-semibold py-1.5 px-2 rounded">
                            Keep bookings
                          </button>
                        </div>
                      </div>
                    )}
                    {hasCancel && groupCancelConfirm && (
                      <div className="mb-2 rounded-lg bg-rose-50 border border-rose-200 p-2">
                        <p className="text-[11px] text-rose-800 mb-2">
                          Cancel all Pending/Confirmed rooms in this reservation? Checked-in rooms stay unchanged. This cannot be undone.
                        </p>
                        <div className="flex gap-2">
                          <button type="button" onClick={handleGroupCancel} disabled={groupCancelLoading}
                            className="flex-1 inline-flex items-center justify-center gap-1 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-[11px] font-semibold py-1.5 px-2 rounded">
                            {groupCancelLoading
                              ? <><i className="fas fa-spinner fa-spin text-[10px]"></i>Cancelling…</>
                              : <><i className="fas fa-check text-[10px]"></i>Yes, cancel group</>}
                          </button>
                          <button type="button" onClick={() => setGroupCancelConfirm(false)} disabled={groupCancelLoading}
                            className="flex-1 inline-flex items-center justify-center gap-1 bg-white border border-rose-300 hover:bg-rose-100 text-rose-800 text-[11px] font-semibold py-1.5 px-2 rounded">
                            Keep bookings
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="flex flex-wrap justify-end gap-2">
                      {hasCheckIn && (
                        <button type="button" onClick={handleGroupCheckIn} disabled={groupCheckInLoading}
                          className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-emerald-600 text-white rounded text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2">
                          {groupCheckInLoading
                            ? <><i className="fas fa-spinner fa-spin mr-1" aria-hidden="true"></i>Checking in…</>
                            : <><i className="fas fa-user-check mr-1" aria-hidden="true"></i>Check in all</>}
                        </button>
                      )}
                      {hasCheckOut && (
                        <button type="button" onClick={handleGroupCheckOut} disabled={groupCheckOutLoading}
                          className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-indigo-600 text-white rounded text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2">
                          {groupCheckOutLoading
                            ? <><i className="fas fa-spinner fa-spin mr-1" aria-hidden="true"></i>Checking out…</>
                            : <><i className="fas fa-door-open mr-1" aria-hidden="true"></i>Check out all</>}
                        </button>
                      )}
                      {hasExtend && (
                        <button type="button" onClick={() => openExtendPicker('group')} disabled={extendSubmitting}
                          className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-white border border-violet-400 text-violet-700 rounded text-sm font-medium hover:bg-violet-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2">
                          <i className="fas fa-clock-rotate-left mr-1" aria-hidden="true"></i>Extend all
                        </button>
                      )}
                      {hasMarkNS && !groupMarkNoShowConfirm && (
                        <button type="button" onClick={() => setGroupMarkNoShowConfirm(true)}
                          className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-white border border-amber-400 text-amber-800 rounded text-sm font-medium hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2">
                          <i className="fas fa-user-slash mr-1" aria-hidden="true"></i>Mark all no-show
                        </button>
                      )}
                      {hasRevertNS && (
                        <button type="button" onClick={handleGroupRevertNoShow} disabled={groupRevertNoShowLoading}
                          className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-amber-100 hover:bg-amber-200 text-amber-800 border border-amber-300 rounded text-sm font-medium disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2">
                          {groupRevertNoShowLoading
                            ? <><i className="fas fa-spinner fa-spin mr-1" aria-hidden="true"></i>Reversing…</>
                            : <><i className="fas fa-rotate-left mr-1" aria-hidden="true"></i>Revert no-show all</>}
                        </button>
                      )}
                      {hasCancel && !groupCancelConfirm && (
                        <button type="button" onClick={() => setGroupCancelConfirm(true)}
                          className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-white border border-rose-300 text-rose-700 rounded text-sm font-medium hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2">
                          <i className="fas fa-ban mr-1" aria-hidden="true"></i>Cancel all
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()}
              {/* Per-row actions (and Download / Close). Scope is
                  clear from button copy ("Check out all" vs "Check
                  Out") so no label row — keeps the bottom bar flat. */}
              <div>
                <div className="flex flex-wrap justify-end gap-2">
              {/* Check In is only offered for Confirmed bookings — Pending
                  means payment hasn't been verified yet. Staff must collect
                  payment first (which moves the booking to Confirmed), then
                  check in. The backend enforces this too; this hides the
                  button so staff don't try the disallowed path. */}
              {booking.status === 'Confirmed' && !isExpiredPending(booking) && (() => {
                // Same-day guard that mirrors Admin\BookingController::checkIn —
                // backend rejects future-dated check-ins with 422. We keep the
                // button visible but disabled (with a scheduled-date tooltip)
                // so staff see the control and know WHY they can't use it yet.
                const ci = new Date(String(booking.checkIn || '').replace(' ', 'T'));
                const ciDay = new Date(ci.getFullYear(), ci.getMonth(), ci.getDate()).getTime();
                const t = new Date();
                const todayDay = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
                const futureDated = booking.checkIn && ciDay > todayDay;
                const ciLabel = futureDated
                  ? ci.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
                  : '';
                return (
                  <button type="button" onClick={() => setPendingAction({ type: 'checkin' })}
                    disabled={actionLoading || futureDated}
                    title={futureDated ? `Scheduled for ${ciLabel} — check in on that day` : undefined}
                    className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-emerald-600 text-white rounded text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2">
                    <i className="fas fa-door-open mr-1" aria-hidden="true"></i>Check In
                  </button>
                );
              })()}
              {/* No-Show for Day/Night Confirmed bookings whose slot has
                  started. Backend enforces the same guards (status +
                  booking_type + slot started); the frontend gate hides
                  the button when it would 422. 24hr is excluded because
                  it auto-checkins at slot start — see the plan docs. */}
              {booking.status === 'Confirmed'
                && !isExpiredPending(booking)
                && ['day', 'night'].includes(booking.bookingType)
                && booking.checkIn
                && new Date(String(booking.checkIn).replace(' ', 'T')) <= new Date() && (
                <button type="button" onClick={() => setPendingAction({ type: 'no-show' })}
                  disabled={actionLoading}
                  className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-slate-600 text-white rounded text-sm font-medium hover:bg-slate-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2">
                  <i className="fas fa-user-slash mr-1" aria-hidden="true"></i>No-Show
                </button>
              )}
              {/* Reversibility — a No-Show booking can be checked in
                  manually if the guest arrives late. Backend accepts
                  No-Show as a valid source status for checkIn. */}
              {booking.status === 'No-Show' && (
                <button type="button" onClick={() => setPendingAction({ type: 'checkin' })}
                  disabled={actionLoading}
                  className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-emerald-600 text-white rounded text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2">
                  <i className="fas fa-undo mr-1" aria-hidden="true"></i>Reverse No-Show
                </button>
              )}
              {/* Transfer hidden once a Checked In booking has gone
                  overdue — at that point staff should be walking the
                  guest through checkout, not rotating rooms.
                  (Frontend-only guard: the transferRoom backend still
                  accepts overdue bookings so an override via API is
                  possible if ever needed.) */}
              {booking.status === 'Checked In' && !transferOpen && !isOverdueCheckout(booking) && (
                <button type="button" onClick={openTransfer}
                  disabled={actionLoading}
                  className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-violet-600 text-white rounded text-sm font-medium hover:bg-violet-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2">
                  <i className="fas fa-exchange-alt mr-1" aria-hidden="true"></i>Transfer
                </button>
              )}
              {booking.status === 'Checked In' && (
                <button type="button" onClick={() => setPendingAction({ type: 'checkout' })}
                  disabled={actionLoading}
                  className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-emerald-600 text-white rounded text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2">
                  <i className="fas fa-sign-out-alt mr-1" aria-hidden="true"></i>Check Out
                </button>
              )}
              {booking.status === 'Pending' && !isExpiredPending(booking) && (
                <button type="button" onClick={() => setPendingAction({ type: 'cancel' })}
                  disabled={actionLoading}
                  className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-rose-600 text-white rounded text-sm font-medium hover:bg-rose-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2">
                  <i className="fas fa-times mr-1" aria-hidden="true"></i>Cancel
                </button>
              )}
              {/* Receipt is available for any booking that has been paid to
                  some degree — Pending rows have no collected amounts yet,
                  so the PDF would be empty. Confirmed / Checked In /
                  Completed / Cancelled all have meaningful records. */}
              {booking.status !== 'Pending' && (
                <button type="button" onClick={handleDownloadReceipt} disabled={receiptLoading}
                  className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-sky-600 text-white rounded text-sm font-medium hover:bg-sky-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2">
                  {receiptLoading
                    ? <><i className="fas fa-spinner fa-spin mr-1" aria-hidden="true"></i>Downloading...</>
                    : <><i className="fas fa-file-pdf mr-1" aria-hidden="true"></i>Download</>}
                </button>
              )}
              <button onClick={onClose}
                type="button"
                className="px-3 py-2.5 min-h-11 border border-slate-200 rounded text-sm text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400">Close</button>
                </div>
              </div>
            </div>
          )}
      </div>
    </Modal>
  );
}
