import { useState, useMemo } from 'react';
import Modal from '../../components/modals/Modal';
import { fmtTime, fmtMoney } from '../../lib/format';

/**
 * Per-room month calendar. Shown when staff clicks the 📅 button on a
 * room card in Rooms.jsx. Reads from the parent's `bookings` array
 * (already fetched for the Live Board) and computes per-day per-slot
 * occupancy client-side — no new backend endpoint.
 *
 * Each day cell carries up to three pills — one per slot type (Day /
 * Night / 24hr) — coloured by whether that slot overlaps an active
 * booking. Clicking a day expands an inline detail panel listing the
 * bookings that touch that day, with a jump link to BookingDetailModal
 * handled by the parent.
 *
 * Multi-unit rooms (cottages, pavilions with quantity > 1): a pill
 * only turns red once activeCount === quantity, matching the rooms
 * board's availability semantics.
 *
 * Status handling mirrors the backend overlap check post-hostage-fix:
 *   - Cancelled / No-Show excluded.
 *   - Completed included only when check_out > now (cleaning window).
 *   - Pending included only within 15-min payment grace.
 */

// Slot-window math — Carbon-side logic ported to JS Date. Same
// windows AvailabilityController computes server-side.
function slotWindow(dateIso, slotType) {
  const base = new Date(`${dateIso}T00:00:00`);
  const next = new Date(base); next.setDate(next.getDate() + 1);
  if (slotType === 'night') {
    const ci = new Date(base); ci.setHours(18, 0, 0, 0);
    const co = new Date(next); co.setHours(6, 0, 0, 0);
    return [ci, co];
  }
  if (slotType === '24hr') {
    const ci = new Date(base); ci.setHours(7, 0, 0, 0);
    const co = new Date(next); co.setHours(6, 0, 0, 0);
    return [ci, co];
  }
  if (slotType === '24hr-pm') {
    const ci = new Date(base); ci.setHours(18, 0, 0, 0);
    const co = new Date(next); co.setHours(18, 0, 0, 0);
    return [ci, co];
  }
  // day
  const ci = new Date(base); ci.setHours(7, 0, 0, 0);
  const co = new Date(base); co.setHours(17, 0, 0, 0);
  return [ci, co];
}

// Parse "YYYY-MM-DD HH:MM:SS" or ISO to Date.
function parseBookingTs(ts) {
  if (!ts) return null;
  const s = String(ts).replace(' ', 'T');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Does the booking still hold a unit against the given slot window?
// Mirrors AvailabilityController's active-count predicate (post-fix).
function bookingBlocks(b, ws, we, now) {
  if (!b || b.status === 'Cancelled' || b.status === 'No-Show') return false;
  if (b.status === 'Pending') {
    const created = parseBookingTs(b.createdAt);
    const grace   = new Date(now.getTime() - 15 * 60_000);
    if (!created || created < grace) return false;
  }
  if (b.status === 'Completed') {
    const co = parseBookingTs(b.checkOut);
    if (!co || co <= now) return false;
  }
  const ci = parseBookingTs(b.checkIn);
  const co = parseBookingTs(b.checkOut);
  if (!ci || !co) return false;
  return ci < we && co > ws;
}

function fmtDateISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const WEEK_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SLOT_META = {
  day:   { label: 'Day',   cls: 'bg-sky-500'    },
  night: { label: 'Night', cls: 'bg-indigo-500' },
  '24hr': { label: '24hr', cls: 'bg-purple-500' },
};

export default function RoomCalendarModal({ room, bookings = [], open, onClose, onOpenBooking }) {
  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [picked, setPicked] = useState(null); // ISO date clicked

  // Only this room's bookings. Multi-unit matching by roomType name as
  // a fallback because bookings carry roomType rather than roomId in
  // some shapes.
  const roomBookings = useMemo(() => {
    const roomIdStr = String(room?.id ?? '');
    const roomName  = String(room?.name ?? '');
    return (bookings || []).filter(b =>
      (b.roomId != null && String(b.roomId) === roomIdStr) ||
      (b.roomType === roomName)
    );
  }, [bookings, room]);

  // Build the 6-week grid for the visible month. Starts from the
  // Sunday on or before the 1st of the month.
  const days = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first);
    start.setDate(start.getDate() - first.getDay());
    const out = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      out.push(d);
    }
    return out;
  }, [cursor]);

  const now = useMemo(() => new Date(), [picked, cursor]); // snap each render

  const quantity = Math.max(1, Number(room?.quantity) || 1);

  // For a given day iso + slot type: count active bookings that overlap.
  const countActive = (dateIso, slotType) => {
    const [ws, we] = slotWindow(dateIso, slotType);
    let count = 0;
    for (const b of roomBookings) {
      if (bookingBlocks(b, ws, we, now)) count++;
      if (count >= quantity) return quantity;
    }
    return count;
  };

  // For the click-expanded day: list every active booking whose window
  // touches that date (any slot).
  const bookingsOnDate = (dateIso) => {
    const base = new Date(`${dateIso}T00:00:00`);
    const next = new Date(base); next.setDate(next.getDate() + 1);
    return roomBookings.filter(b => bookingBlocks(b, base, next, now));
  };

  if (!room) return null;

  const monthLabel = `${MONTH_NAMES[cursor.getMonth()]} ${cursor.getFullYear()}`;
  const todayIso = fmtDateISO(today);

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-xl" label={`Calendar — ${room.name}`}>
      <div className="p-5">
        {/* Header */}
        <div className="flex items-start gap-3 mb-3">
          <div className="p-2.5 rounded-lg bg-sky-100 text-sky-600 shrink-0">
            <i className="fas fa-calendar-days text-lg" aria-hidden="true"></i>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-bold text-slate-900">Availability — {room.name}</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {quantity > 1 ? `${quantity} units · ` : ''}
              Day, Night, and 24-hour slots per day. Click a day to see what's booked.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="w-9 h-9 inline-flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
            <i className="fas fa-times" aria-hidden="true"></i>
          </button>
        </div>

        {/* Month nav */}
        <div className="flex items-center justify-between mb-3 bg-slate-50 rounded-lg p-2">
          <button type="button"
            onClick={() => setCursor(c => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
            className="w-9 h-9 inline-flex items-center justify-center rounded-md text-slate-600 hover:bg-white hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            aria-label="Previous month">
            <i className="fas fa-chevron-left" aria-hidden="true"></i>
          </button>
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-slate-900">{monthLabel}</h4>
            <button type="button"
              onClick={() => { setCursor(new Date(today.getFullYear(), today.getMonth(), 1)); setPicked(todayIso); }}
              className="text-[11px] font-semibold px-2 py-1 rounded bg-sky-100 text-sky-700 hover:bg-sky-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
              Today
            </button>
          </div>
          <button type="button"
            onClick={() => setCursor(c => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
            className="w-9 h-9 inline-flex items-center justify-center rounded-md text-slate-600 hover:bg-white hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            aria-label="Next month">
            <i className="fas fa-chevron-right" aria-hidden="true"></i>
          </button>
        </div>

        {/* Day-of-week header */}
        <div className="grid grid-cols-7 gap-1 mb-1">
          {WEEK_LABELS.map(d => (
            <div key={d} className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 text-center py-1">{d}</div>
          ))}
        </div>

        {/* Day grid */}
        <div className="grid grid-cols-7 gap-1">
          {days.map((d, i) => {
            const iso = fmtDateISO(d);
            const inMonth = d.getMonth() === cursor.getMonth();
            const isToday = iso === todayIso;
            const isPicked = iso === picked;

            // Per-slot occupancy count → pill colour (green if free, red if full)
            const day24  = countActive(iso, '24hr');
            const day24p = countActive(iso, '24hr-pm');
            const dayCt  = countActive(iso, 'day');
            const nightCt = countActive(iso, 'night');
            // Combine 24hr + 24hr-pm into one "24h" indicator — either
            // version blocking means the 24-hour window for that date
            // is taken. The other slots stand on their own.
            const dayFull   = dayCt   >= quantity;
            const nightFull = nightCt >= quantity;
            const d24Full   = Math.max(day24, day24p) >= quantity;
            const hasAny    = dayCt > 0 || nightCt > 0 || day24 > 0 || day24p > 0;

            return (
              <button
                key={i}
                type="button"
                onClick={() => setPicked(p => p === iso ? null : iso)}
                className={`
                  relative flex flex-col items-center justify-start gap-1 py-1.5 px-0.5 rounded-md border transition-colors
                  ${inMonth ? 'text-slate-900' : 'text-slate-300 bg-slate-50'}
                  ${isPicked ? 'border-sky-500 ring-2 ring-sky-200 bg-sky-50' : 'border-transparent'}
                  ${isToday && !isPicked ? 'border-sky-300 bg-sky-50' : ''}
                  hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500
                `}
                aria-label={`${iso}, ${hasAny ? 'has bookings' : 'free'}`}
              >
                <span className="text-xs font-semibold">{d.getDate()}</span>
                {inMonth && (
                  // Only render dots for SLOTS THAT ARE BOOKED. A fully
                  // free day renders no dots, so staff don't confuse
                  // "three free dots" for "three busy dots". A busy day
                  // shows only the booked slot's colour so the eye
                  // picks it out immediately.
                  <div className="flex gap-0.5 min-h-[6px]">
                    {dayFull   && <span className={`w-1.5 h-1.5 rounded-full ${SLOT_META.day.cls}`}    aria-label="Day booked"></span>}
                    {nightFull && <span className={`w-1.5 h-1.5 rounded-full ${SLOT_META.night.cls}`}  aria-label="Night booked"></span>}
                    {d24Full   && <span className={`w-1.5 h-1.5 rounded-full ${SLOT_META['24hr'].cls}`} aria-label="24hr booked"></span>}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Legend */}
        <div className="mt-3 flex items-center justify-center gap-3 text-[10px] text-slate-500 flex-wrap">
          <span className="italic">Days with no dots are fully free.</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-sky-500"></span> Day booked</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-indigo-500"></span> Night booked</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-purple-500"></span> 24hr booked</span>
        </div>

        {/* Expanded detail for picked day */}
        {picked && (() => {
          const items = bookingsOnDate(picked);
          const [y, m, dd] = picked.split('-').map(Number);
          const d = new Date(y, m - 1, dd);
          const label = `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
          return (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold text-slate-700 mb-2">{label}</p>
              {items.length === 0 ? (
                <p className="text-xs text-emerald-700 flex items-center gap-1.5">
                  <i className="fas fa-check-circle" aria-hidden="true"></i>
                  No bookings — all slots free.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {items.map(b => (
                    <li key={b.bookingId} className="flex items-start justify-between gap-2 bg-white rounded-md px-2 py-1.5 border border-slate-200">
                      <div className="min-w-0 text-xs">
                        <p className="font-medium text-slate-900 truncate">
                          {b.guest || b.guestName || 'Guest'}
                          <span className="ml-1 text-[10px] text-slate-400 font-normal">· {b.bookingType || ''}</span>
                        </p>
                        <p className="text-[10px] text-slate-500 truncate">
                          {fmtTime(b.checkIn)} → {fmtTime(b.checkOut)} · {b.status}
                        </p>
                      </div>
                      {onOpenBooking && (
                        <button type="button" onClick={() => onOpenBooking(b)}
                          className="shrink-0 text-[10px] font-semibold text-sky-700 hover:text-sky-900 underline underline-offset-2">
                          Open
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })()}
      </div>
    </Modal>
  );
}
