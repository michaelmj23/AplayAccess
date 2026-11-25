import React, { useState, useEffect, useMemo, useRef, Fragment } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
// bookingsPath resolution lives inside the component so the back-button
// and success redirect land in the portal the page was mounted from
// (/admin/bookings when embedded, /frontdesk/bookings otherwise).
import { Helmet } from 'react-helmet-async';
import Sidebar from './Layout/Sidebar';
import { api } from '../../lib/api';
import { getFdRooms, getFdBookings, createWalkInBooking, addonAvailabilityForSlot, getCounterXenditStatus } from '../../lib/frontdeskApi';
import { uploadFile } from '../../lib/uploadApi';
import { QRCodeSVG } from 'qrcode.react';
import { validatePromo, getAdminGuests } from '../../lib/adminApi';
import Toast, { useToast } from '../../components/ui/Toast';
import Modal from '../../components/modals/Modal';
import { fmtMoney, localDateStr } from '../../lib/format';

// ─── helpers ──────────────────────────────────────────────────────────────────
const todayStr = () => localDateStr();


// Addons are fetched from API — no hardcoded catalog

// Entrance fee fallback — live values come from /api/pricing on mount
// Legacy '24hr-pm' is kept here for rendering old bookings only — new walk-ins
// always use '24hr' with a staff-picked start hour.
const FALLBACK_RATES = { day: 50, night: 80, '24hr': 100, '24hr-pm': 100 };

// Strip a phone string down to digits only — used as the dedup key
// when merging walk-in guests (special_requests) with registered
// users so "+63 908 191 4721" and "09081914721" hash to the same
// entry instead of producing two suggestion rows.
function phoneKey(p) {
  return String(p ?? '').replace(/\D/g, '');
}

// Walk-in details parser — same shape as Bookings.jsx parseWalkIn.
// Gated on backend-attributed `source` so a guest can't forge a
// fake walk-in identity by typing "Walk-in:" into special_requests.
function parseWalkInGuest(b) {
  if (b?.source !== 'walk-in') return null;
  if (!b.specialRequests?.startsWith('Walk-in:')) return null;
  const name  = (b.specialRequests.match(/^Walk-in:\s*([^,]+)/) || [])[1]?.trim() || b.guest;
  const phone = (b.specialRequests.match(/Phone:\s*([^,]+)/) || [])[1]?.trim() || '';
  const email = (b.specialRequests.match(/Email:\s*([^,]+)/) || [])[1]?.trim() || '';
  return { name, phone: phone === '—' ? '' : phone, email: email === '—' ? '' : email };
}

const EMPTY_FORM = {
  fullName: '', phone: '', email: '',
  roomId: '', date: todayStr(),
  payMethod: 'Cash', notes: '',
  // GCash evidence — required when payMethod === 'GCash'. gcashRef is
  // the typed reference number (reconciliation lookup key),
  // gcashRefImageUrl is a Cloudinary URL of the guest's confirmation
  // screenshot (audit evidence). Same contract as the Billing Manual
  // Ref flow. Uploads to aplaya/gcash-refs/YYYY/MM/DD/ at submit time.
  gcashRef: '',
  gcashRefImageUrl: '',
  // GCash sub-mode: 'ref' = manual (type ref + upload screenshot of
  // the guest's GCash confirmation), 'qr' = inline Xendit QR (resort
  // generates an invoice, guest scans, webhook credits). 'qr' is the
  // default when GCash is picked — matches the Billing Collect UX.
  gcashMode: 'qr',
  // Cash tender — required when payMethod === 'Cash'. String so an
  // empty input can be distinguished from a typed 0. Must be >=
  // grand total at submit time; change due renders live below the
  // field. Nothing gets persisted backend-side (the tender itself is
  // a counter-floor quantity, not a DB field) — paid_amount stays at
  // grand total just like Cash Billing collects.
  cashTender: '',
  bookingType: 'day', // 'day' | 'night' | '24hr'
  // Multi-night count — only applies when bookingType === '24hr'.
  // Day and Night stay single-slot (backend rejects nights>1 for
  // those with a 422). Resets to 1 whenever the type changes.
  nights: 1,
  guests: 1,
  // Multi-room mode gate. Off by default — staff ticks the checkbox
  // above the room picker to reveal the "+ Add Another Room" flow.
  // Untocking wipes additionalRooms so they can't be submitted by
  // accident.
  multiRoomMode: false,
  // Primary room unit count — for rooms with quantity > 1 staff
  // can book up to that many Small Cottages (etc.) without adding
  // siblings. Always 1 when the selected primary has quantity 1.
  primaryQty: 1,
  // Additional rooms in the same reservation. Each entry can
  // carry its own qty for multi-unit rooms (cottages / pavilions
  // with quantity > 1). On submit each entry expands by its qty.
  additionalRooms: [], // {tempId, roomId, qty?}
};

// ─── component ────────────────────────────────────────────────────────────────
// `embedded` prop: see Bookings.jsx for the rationale — when true,
// the front-desk Sidebar + top bar are skipped so an outer shell
// (AdminShell) can wrap the page body instead.
export default function WalkIn({ embedded = false }) {
  const Shell = embedded ? Fragment : Sidebar;
  const location = useLocation();
  const bookingsPath = location.pathname.startsWith('/admin') ? '/admin/bookings' : '/frontdesk/bookings';
  const navigate = useNavigate();
  const preselectedRoom = location.state?.preselectedRoom ?? null;

  // Wizard-only page: no table, no row actions — so none of the bookings,
  // sort, transfer, view-detail, or per-row status state lives here anymore.
  const [rooms, setRooms]                 = useState([]);
  const [loading, setLoading]             = useState(true);
  const [formOpen, setFormOpen]           = useState(false);
  const [submitting,   setSubmitting]     = useState(false);
  const [confirmOpen,  setConfirmOpen]   = useState(false);
  const [error, setError]                 = useState('');
  const [formError, setFormError]         = useState('');
  const [form, setForm]                   = useState(EMPTY_FORM);
  const [wiStep, setWiStep]               = useState(1);
  // Transient upload state for the GCash screenshot — kept outside
  // `form` so it resets even on draft restores.
  const [gcashImageUploading, setGcashImageUploading] = useState(false);
  // Counter Xendit QR flow — only used when form.gcashMode === 'qr'.
  // When qrInvoice is non-null the form is locked (rows already exist
  // as Pending in the DB) and the body swaps to the QR panel. Status
  // polls every 3s until paid / failed; on paid the modal closes.
  const [qrInvoice, setQrInvoice]         = useState(null);
  const [qrGenerating, setQrGenerating]   = useState(false);
  const [showWiNotes, setShowWiNotes]     = useState(false);
  const [toast, showToast, clearToast, toastType] = useToast();

  // ── Returning-guest lookup ─────────────────────────────────────────────
  // Lets staff find an existing customer (registered account OR past
  // walk-in) and pre-fill name / phone / email so we don't create
  // duplicate "Maria Santos" / "M Santos" / "Maria S" records that look
  // like different people in Guest Records. When the matched guest has
  // an email or phone the backend resolves to an existing User and the
  // walk-in shows up in the guest's My Bookings on next login.
  const [knownGuests,           setKnownGuests]           = useState([]);
  const [guestSearch,           setGuestSearch]           = useState('');
  const [guestSearchOpen,       setGuestSearchOpen]       = useState(false);
  const [highlightedGuestIdx,   setHighlightedGuestIdx]   = useState(0);
  const [selectedReturningGuest, setSelectedReturningGuest] = useState(null);
  const guestSearchRef = useRef(null);

  // Fetch the merged guest set on mount. Two sources combined:
  //   1. /api/admin/guests — every user with role='guest' (covers
  //      anyone who has booked online or whose walk-in had an email,
  //      since the backend creates a User in that case).
  //   2. /api/admin/bookings — pulls walk-in entries whose
  //      special_requests carries the typed details, picking up the
  //      anonymous (no-email) walk-ins that don't surface in (1).
  // Dedup by digits-only phone; email-only matches collapse onto
  // their phone-keyed sibling on next mount when staff supplies the
  // phone. Sorted by lastVisit desc so the most recent returning
  // guest surfaces at the top of suggestions.
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([getAdminGuests(), getFdBookings()])
      .then(([gRes, bRes]) => {
        if (cancelled) return;
        // Two layers of "deleted account" detection:
        //  1. The users table row is anonymized — name='Deleted User',
        //     email='deleted_{id}@removed.local'. Skip those entirely.
        //  2. Past walk-in bookings linked to a deleted user_id may
        //     still hold the pre-deletion PII in special_requests if
        //     the backend scrub hasn't run on that row yet (legacy data
        //     from before the ProfileController scrub was added). The
        //     deletedUserIds set lets us drop those walk-in extracts
        //     even when their special_requests still contains the
        //     original name/phone/email.
        const isDeletedRow = (g) => (g.name || '').trim().toLowerCase() === 'deleted user'
          || /^deleted_\d+@removed\.local$/i.test(g.email || '');
        const deletedUserIds = new Set();
        const map = new Map();
        if (gRes.status === 'fulfilled') {
          for (const g of gRes.value?.data?.data ?? []) {
            if (isDeletedRow(g)) {
              if (g.id != null) deletedUserIds.add(Number(g.id));
              continue;
            }
            const key = phoneKey(g.phone) || `email:${(g.email || '').toLowerCase()}`;
            if (!key || key === 'email:') continue;
            map.set(key, {
              name:      g.name || '',
              email:     g.email || '',
              phone:     g.phone && g.phone !== '—' ? g.phone : '',
              visits:    Number(g.total_bookings || 0),
              lastVisit: g.last_booking || g.joined || '',
              source:    'account',
            });
          }
        }
        if (bRes.status === 'fulfilled') {
          for (const b of bRes.value ?? []) {
            // Skip walk-ins owned by a user whose account was deleted
            // (covers legacy specialRequests rows that still hold PII).
            if (b.userId != null && deletedUserIds.has(Number(b.userId))) continue;
            const wi = parseWalkInGuest(b);
            if (!wi) continue;
            // Skip post-scrub rows whose parsed name is the placeholder.
            if ((wi.name || '').trim().toLowerCase() === 'deleted user') continue;
            const key = phoneKey(wi.phone) || `email:${(wi.email || '').toLowerCase()}`;
            if (!key || key === 'email:') continue;
            const existing = map.get(key);
            const lastVisit = b.checkIn || b.createdAt || '';
            if (existing) {
              if (lastVisit > (existing.lastVisit || '')) existing.lastVisit = lastVisit;
              if (existing.source === 'walkin') existing.visits += 1;
            } else {
              map.set(key, {
                name:      wi.name,
                email:     wi.email,
                phone:     wi.phone,
                visits:    1,
                lastVisit,
                source:    'walkin',
              });
            }
          }
        }
        const list = [...map.values()].sort(
          (a, b) => String(b.lastVisit).localeCompare(String(a.lastVisit))
        );
        setKnownGuests(list);
      });
    return () => { cancelled = true; };
  }, []);

  const guestMatches = useMemo(() => {
    const q = guestSearch.trim().toLowerCase();
    if (q.length < 2) return [];
    const qDigits = q.replace(/\D/g, '');
    const matches = knownGuests.filter(g =>
      g.name.toLowerCase().includes(q) ||
      (qDigits && phoneKey(g.phone).includes(qDigits)) ||
      (g.email && g.email.toLowerCase().includes(q))
    );
    return matches.slice(0, 8);
  }, [knownGuests, guestSearch]);

  // Reset the highlight whenever the suggestion list changes so we
  // don't index past the end after a query narrows the matches.
  useEffect(() => { setHighlightedGuestIdx(0); }, [guestMatches.length]);

  // Click-outside dismisses the dropdown.
  useEffect(() => {
    if (!guestSearchOpen) return;
    function onDown(e) {
      if (guestSearchRef.current && !guestSearchRef.current.contains(e.target)) {
        setGuestSearchOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [guestSearchOpen]);

  function pickReturningGuest(g) {
    setForm(f => ({ ...f, fullName: g.name, phone: g.phone, email: g.email || '' }));
    setSelectedReturningGuest(g);
    setGuestSearch('');
    setGuestSearchOpen(false);
  }
  function clearReturningGuest() {
    setSelectedReturningGuest(null);
  }
  function handleGuestSearchKeyDown(e) {
    if (!guestSearchOpen || guestMatches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedGuestIdx(i => (i + 1) % guestMatches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedGuestIdx(i => (i - 1 + guestMatches.length) % guestMatches.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickReturningGuest(guestMatches[highlightedGuestIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setGuestSearchOpen(false);
    }
  }

  // Promo code
  const [addons,       setAddons]        = useState([]);   // from API
  const [addonQtys,    setAddonQtys]    = useState({});   // { [id]: qty }
  // Live per-window remaining counts. Keyed by addon id — {allocated, remaining,
  // max_qty, per_booking}. Empty map when slot inputs aren't yet valid; the UI
  // falls back to `a.max_qty` in that case, so the flow degrades gracefully.
  const [addonAvailability, setAddonAvailability] = useState({});

  const [promoInput,   setPromoInput]   = useState('');
  const [promoResult,  setPromoResult]  = useState(null);
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoError,   setPromoError]   = useState('');

  // Live entrance-fee rates from /api/pricing (falls back to FALLBACK_RATES)
  const [entranceRates, setEntranceRates] = useState(FALLBACK_RATES);
  useEffect(() => {
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
  }, []);

  const today = todayStr();

  // Wizard needs rooms (picker), addons (amenities), pricing (fetched
  // separately below). It no longer needs the bookings list — availability
  // is checked via /api/availability, not client-side overlap scanning.
  function loadAll() {
    setLoading(true);
    Promise.all([getFdRooms(), api.get('/api/addons')])
      .then(([rm, adRes]) => {
        setRooms(rm);
        const fetchedAddons = adRes.data?.data ?? [];
        setAddons(fetchedAddons);
        setAddonQtys(Object.fromEntries(fetchedAddons.map(a => [a.id, 0])));
        setError('');
      })
      .catch(() => setError('Failed to load data.'))
      .finally(() => setLoading(false));
  }
  useEffect(() => { loadAll(); }, []);

  // This route is wizard-only: the modal auto-opens on mount. A ref guards
  // against the effect re-firing (e.g. when loadAll toggles `loading`).
  // The preselectedRoom handoff from Rooms board still works — we just
  // seed the form's roomId before opening.
  const hasAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (loading || hasAutoOpenedRef.current) return;
    hasAutoOpenedRef.current = true;
    if (preselectedRoom) {
      setForm(f => ({ ...f, roomId: String(preselectedRoom.id) }));
      navigate(location.pathname, { replace: true, state: null });
    }
    setFormOpen(true);
    setWiStep(1);
    setShowWiNotes(false);
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close handlers return to the consolidated Bookings page, since this
  // route carries no content of its own beyond the wizard modal.
  const closeWizard = () => navigate(bookingsPath);

  // Room availability — same check as BookingModal
  const [availability,  setAvailability]  = useState(null);
  const [availChecking, setAvailChecking] = useState(false);

  useEffect(() => {
    if (!form.date) { setAvailability(null); return; }
    const params = new URLSearchParams({
      date:         form.date,
      booking_type: form.bookingType,
    });
    setAvailChecking(true);
    api.get(`/api/availability?${params}`)
      .then(r => {
        // Key by id — room names aren't unique in the admin controller,
        // so two rooms sharing a name would otherwise collapse into one
        // availability slot and hide / mis-allow the wrong record.
        const map = {};
        (r.data?.data ?? []).forEach(rm => { map[String(rm.id)] = rm.available; });
        setAvailability(map);
      })
      .catch(() => setAvailability(null))
      .finally(() => setAvailChecking(false));
  }, [form.date, form.bookingType]);


  // Time-slot guard: disable booking types whose window already passed today
  const isToday          = form.date === today;
  const currentHour      = new Date().getHours();
  const dayPassed        = isToday && currentHour >= 17;   // Day (7AM–5PM) window closed
  // 24hr covers 7 AM today → 6 AM tomorrow. Locked from 4 PM onward so
  // a walk-in doesn't book a "24-hour" slot with only ~14 hours left.
  const twentyFourPassed = isToday && currentHour >= 16;

  // Auto-switch away from Day or 24hr if its window passed
  useEffect(() => {
    if (dayPassed && form.bookingType === 'day') setField('bookingType', 'night');
  }, [dayPassed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (twentyFourPassed && form.bookingType === '24hr') setField('bookingType', 'night');
  }, [twentyFourPassed]); // eslint-disable-line react-hooks/exhaustive-deps

  function setField(key, val) { setForm(f => ({ ...f, [key]: val })); }

  // Auto-switch to first allowed type when a restricted room is selected
  useEffect(() => {
    const room = rooms.find(r => String(r.id) === String(form.roomId));
    const allowed = room?.allowed_booking_types ?? null;
    if (!allowed) return;
    if (!allowed.includes(form.bookingType)) setField('bookingType', allowed[0]);
  }, [form.roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset nights to 1 whenever the booking type leaves 24hr. Multi-
  // night only applies to 24hr; a leftover 3 from a prior 24hr pick
  // must not survive a switch to Day/Night.
  useEffect(() => {
    if (!is24hr && form.nights !== 1) setField('nights', 1);
  }, [form.bookingType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Multi-room checkbox toggled off → drop any staged siblings so
  // they don't silently end up in the submit payload.
  useEffect(() => {
    if (!form.multiRoomMode && form.additionalRooms.length > 0) {
      setField('additionalRooms', []);
    }
    if (!form.multiRoomMode && form.primaryQty !== 1) {
      setField('primaryQty', 1);
    }
  }, [form.multiRoomMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Primary room swap → reset qty to 1 (the new room's quantity
  // may be smaller than the previous one's).
  useEffect(() => {
    if (form.primaryQty !== 1) setField('primaryQty', 1);
  }, [form.roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pricing preview — room rate only; entrance fees collected at check-in by frontdesk
  const selectedRoom  = rooms.find(r => String(r.id) === String(form.roomId));
  const allowedTypes  = selectedRoom?.allowed_booking_types ?? null;
  const typeAllowed   = (type) => !allowedTypes || allowedTypes.includes(type);
  const dayRate       = Number(selectedRoom?.day_rate       ?? 1500);
  const nightRate     = Number(selectedRoom?.overnight_rate ?? 1500);
  const rate24        = Number(selectedRoom?.rate_24hr      ?? 2000);
  const is24hr        = form.bookingType === '24hr' || form.bookingType === '24hr-pm';
  const is24hrPm      = form.bookingType === '24hr-pm';
  const baseRate      = form.bookingType === 'night' ? nightRate : is24hr ? rate24 : dayRate;
  // Multi-night 24hr: per-night rate rolls up for pricing previews.
  // room_rate on the booking row stays per-night; `nights` is sent
  // separately and the backend recomputes.
  const effectiveNights = is24hr ? Math.max(1, Math.min(30, Number(form.nights) || 1)) : 1;

  // Per-room rate helper. Honors mixed-type bookings by letting the
  // caller pass an override type (each additionalRoom may carry its
  // own). Falls back to the top-level form.bookingType.
  function rateForRoom(roomRecord, type) {
    if (!roomRecord) return 0;
    const t = type ?? form.bookingType;
    // 24hr-pm uses the same per-slot rate column as 24hr (shared pricing).
    if (t === 'night') return Number(roomRecord.overnight_rate ?? 1500);
    if (t === '24hr' || t === '24hr-pm') return Number(roomRecord.rate_24hr ?? 2000);
    return Number(roomRecord.day_rate ?? 1500);
  }

  // Resolve each additional room — all siblings inherit the
  // primary's slot (resort rule: one group, one visit slot).
  // Each row's `qty` scales its subtotal (multi-unit cottages /
  // pavilions).
  const additionalRoomRows = form.additionalRooms.map(ar => {
    const room = rooms.find(r => String(r.id) === String(ar.roomId));
    const type = form.bookingType;
    const n    = (type === '24hr' || type === '24hr-pm') ? effectiveNights : 1;
    const qty  = Math.max(1, Number(ar.qty ?? 1));
    return { ar, room, type, nights: n, qty, rate: rateForRoom(room, type) };
  });
  const additionalRoomObjs = additionalRoomRows.map(r => r.room).filter(Boolean);
  const additionalRoomsSubtotal = additionalRoomRows
    .filter(r => r.room)
    .reduce((sum, r) => sum + r.rate * r.nights * r.qty, 0);

  // Primary room's subtotal multiplied by its own unit count (when
  // the room supports multiple units and staff upped the qty).
  const effectivePrimaryQty = (form.multiRoomMode && selectedRoom && Number(selectedRoom.quantity ?? 1) > 1)
    ? Math.max(1, Math.min(Number(selectedRoom.quantity), Number(form.primaryQty) || 1))
    : 1;
  const primaryRoomSubtotal = baseRate * effectiveNights * effectivePrimaryQty;
  const roomSubtotal = primaryRoomSubtotal + additionalRoomsSubtotal;

  // Set of addon IDs that are attached to SOME room (as either package
  // or optional). Catalog addons not in this set are resort-wide shared
  // pool and show for every room. Attached ones only show for the room
  // they're attached to, and only as optional (package auto-attaches
  // server-side; there's no "pick" for them here).
  const roomScopedAddonIds = useMemo(() => {
    const ids = new Set();
    for (const r of rooms) {
      for (const a of (r.attached_addons ?? [])) ids.add(a.id);
    }
    return ids;
  }, [rooms]);

  // The picker's working list. Returns two kinds of rows, each
  // tagged with a `relation` so the picker can render a "For this
  // room" badge on room-attached ones:
  //   - relation='shared'   → catalog addons not tied to any room
  //                            (pillows, towel, parking, common table)
  //   - relation='optional' → attached to THIS room as optional,
  //                            priced via the per-room pivot override
  // Package attachments anywhere + optional attachments for other
  // rooms are hidden — packages auto-attach server-side, other-room
  // optionals don't apply here.
  //
  // Optional rows sort FIRST so staff see the room-specific items
  // before the generic shared-pool list — matches the "these apply
  // only to this room, don't miss them" mental model.
  const visibleAddons = useMemo(() => {
    const selectedRoomOptionals = new Map(
      (selectedRoom?.attached_addons ?? [])
        .filter(a => a.relation === 'optional')
        .map(a => [a.id, a])
    );
    const rows = addons.flatMap(a => {
      if (!roomScopedAddonIds.has(a.id)) {
        return [{ ...a, relation: 'shared' }];
      }
      const opt = selectedRoomOptionals.get(a.id);
      if (!opt) return [];
      return [{ ...a, relation: 'optional', price: Number(opt.price) }];
    });
    // Stable sort: optionals first, shared after. Preserves original
    // order within each group.
    return rows.sort((a, b) => {
      if (a.relation === b.relation) return 0;
      return a.relation === 'optional' ? -1 : 1;
    });
  }, [addons, roomScopedAddonIds, selectedRoom]);

  // Clear qtys for any addon that disappeared from the visible list
  // after switching rooms (e.g. staged Patrice videoke qty=1 then
  // swapped to Cassey → Cassey has no videoke attachment → would
  // otherwise silently submit a qty that the new room can't offer).
  useEffect(() => {
    const visibleIds = new Set(visibleAddons.map(a => a.id));
    setAddonQtys(prev => {
      let touched = false;
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        if (Number(next[id]) > 0 && !visibleIds.has(Number(id))) {
          next[id] = 0;
          touched = true;
        }
      }
      return touched ? next : prev;
    });
  }, [visibleAddons]);

  // Fetch per-window add-on availability whenever the slot inputs change.
  // Mirrors the shared inventory check that the backend walk-in endpoint runs
  // at submit, so staff see "sold out" before they pick a qty that will fail.
  useEffect(() => {
    if (!form.date || addons.length === 0) { setAddonAvailability({}); return; }
    let cancelled = false;
    addonAvailabilityForSlot({ date: form.date, bookingType: form.bookingType, hour: null })
      .then(r => {
        if (cancelled) return;
        const map = {};
        for (const row of (r?.data ?? [])) map[row.id] = row;
        setAddonAvailability(map);
        // If a staged qty now exceeds live remaining, clamp it so the submit
        // doesn't 422. Happens when staff changes date/type after staging.
        setAddonQtys(prev => {
          let touched = false;
          const next = { ...prev };
          for (const row of (r?.data ?? [])) {
            const cur = Number(next[row.id] || 0);
            if (cur > row.remaining) { next[row.id] = row.remaining; touched = true; }
          }
          return touched ? next : prev;
        });
      })
      .catch(() => { if (!cancelled) setAddonAvailability({}); });
    return () => { cancelled = true; };
  }, [form.date, form.bookingType, addons.length]);

  // Use visibleAddons so the per-room price override (Patrice videoke
  // vs catalog videoke) feeds the summary + totals correctly.
  const amenityTotal = visibleAddons.reduce((sum, a) => {
    const qty = Number(addonQtys[a.id] || 0);
    if (qty <= 0) return sum;
    return sum + (a.per_booking ? a.price : a.price * qty);
  }, 0);
  // Multi-night 24hr: subtotal rolls the per-night rate up before
  // amenities fold in. Day/Night still use baseRate × 1 effectively.
  const previewSubtotal = roomSubtotal + amenityTotal;
  const promoDiscount   = promoResult?.discount_amount ?? 0;
  const previewTotal    = Math.max(previewSubtotal - promoDiscount, 0);
  const entranceFeeRate = entranceRates[form.bookingType] ?? 50;
  const entranceFeeTotal = Number(form.guests || 1) * entranceFeeRate;

  async function applyPromo() {
    const code = promoInput.trim();
    if (!code) return;
    setPromoLoading(true);
    setPromoError('');
    setPromoResult(null);
    try {
      const res = await validatePromo(code, previewSubtotal);
      const d   = res.data;
      if (d.valid) {
        setPromoResult(d);
      } else {
        setPromoError(d.message || 'Invalid promo code.');
      }
    } catch {
      setPromoError('Could not validate promo code.');
    } finally {
      setPromoLoading(false);
    }
  }

  function removePromo() {
    setPromoResult(null);
    setPromoInput('');
    setPromoError('');
  }

  // Step 2 — validate → show confirmation
  function handleCreate() {
    setFormError('');
    if (!form.fullName.trim()) {
      setFormError('Guest name is required.'); return;
    }
    if (allowedTypes && !allowedTypes.includes(form.bookingType)) {
      setFormError(`This room only supports: ${allowedTypes.join(', ')}.`); return;
    }
    if (!form.roomId) { setFormError('Please select a room.'); return; }
    if (form.payMethod === 'GCash' && form.gcashMode === 'ref') {
      if (!form.gcashRef.trim()) {
        setFormError('GCash reference number is required.'); return;
      }
      if (!form.gcashRefImageUrl) {
        setFormError('GCash confirmation screenshot is required.'); return;
      }
      if (gcashImageUploading) {
        setFormError('Please wait for the screenshot upload to finish.'); return;
      }
    }
    if (form.payMethod === 'Cash') {
      const grandTotal = previewTotal + entranceFeeTotal;
      const typed = form.cashTender.trim() === '' ? null : Number(form.cashTender);
      if (typed == null || !Number.isFinite(typed) || typed <= 0) {
        setFormError('Please enter the amount tendered.'); return;
      }
      if (typed < grandTotal - 0.009) {
        setFormError(`Tender (${fmtMoney(typed)}) is less than the total (${fmtMoney(grandTotal)}).`); return;
      }
    }
    const selRoom = rooms.find(r => String(r.id) === String(form.roomId));
    if (availability !== null && (!selRoom || availability[String(selRoom.id)] !== true)) {
      setFormError('This room is not available for the selected date and booking type.'); return;
    }

    // Validate additional rooms: each must have a selection, no
    // duplicates with the primary or other additionals, available
    // for the date, and accepting this room's EFFECTIVE type.
    // Primary qty + any sibling qty for the same room must not
    // exceed that room's physical quantity.
    const roomCounts = {};
    const primaryRoomRec = rooms.find(r => String(r.id) === String(form.roomId));
    const primaryQ = (form.multiRoomMode && primaryRoomRec && Number(primaryRoomRec.quantity ?? 1) > 1)
      ? Math.max(1, Number(form.primaryQty) || 1)
      : 1;
    roomCounts[String(form.roomId)] = primaryQ;
    if (primaryRoomRec && primaryQ > Number(primaryRoomRec.quantity ?? 1)) {
      setFormError(`${primaryRoomRec.name} only has ${primaryRoomRec.quantity} unit${primaryRoomRec.quantity === 1 ? '' : 's'} — can't book more than that in one reservation.`); return;
    }
    for (const [idx, row] of additionalRoomRows.entries()) {
      const ar = row.ar;
      if (!ar.roomId) {
        setFormError(`Additional room #${idx + 1} needs a selection — remove it or pick a room.`); return;
      }
      const adRoom = row.room;
      if (!adRoom) {
        setFormError(`Additional room #${idx + 1} no longer exists — remove it.`); return;
      }
      const sibQty = Math.max(1, Number(ar.qty ?? 1));
      roomCounts[String(ar.roomId)] = (roomCounts[String(ar.roomId)] ?? 0) + sibQty;
      const maxQty = Math.max(1, Number(adRoom.quantity ?? 1));
      if (roomCounts[String(ar.roomId)] > maxQty) {
        setFormError(`${adRoom.name} only has ${maxQty} unit${maxQty === 1 ? '' : 's'} — can't book more than that in one reservation.`); return;
      }
      if (adRoom.allowed_booking_types && !adRoom.allowed_booking_types.includes(row.type)) {
        setFormError(`${adRoom.name} does not support ${row.type}.`); return;
      }
      if (availability !== null && availability[String(adRoom.id)] !== true) {
        setFormError(`${adRoom.name} is not available for the selected date.`); return;
      }
    }

    setShortStayAck(false);
    setConfirmOpen(true);
  }

  // Step 2 — confirmed → call API
  async function handleConfirmCreate() {
    setConfirmOpen(false);
    // Pick a reasonable HH:MM:SS for the datetime; the backend overrides with
    // the canonical fixed window anyway.
    const checkInTime = form.bookingType === 'night'
      ? '18:00:00'
      : '07:00:00';
    const checkIn     = `${form.date} ${checkInTime}`;
    const guestName   = form.fullName.trim();
    // Only submit amenities that are currently visible for the
    // selected room — prevents stale qtys from a previously picked
    // room leaking through when the staff switches mid-flow.
    const amenities   = visibleAddons
      .filter(a => Number(addonQtys[a.id] || 0) > 0)
      .map(a => ({ name: a.name, qty: Number(addonQtys[a.id]) }));

    setSubmitting(true);
    try {
      // Phase 3b-walkin: multi-room payload when staff added at least
      // one extra room. All amenities land on the primary room —
      // additional rooms don't carry an addon picker in the UI yet
      // (post-booking add-addon flow covers them). Package addons
      // auto-attach on the backend per-room regardless.
      const multiRoom = form.additionalRooms.length > 0;
      const payload = {
        guest_name:        guestName,
        guest_phone:       form.phone.trim(),
        guest_email:       form.email.trim() || undefined,
        check_in:          checkIn,
        guests:            Number(form.guests || 1),
        payment_method:    form.payMethod.toLowerCase(),
        special_requests:  form.notes.trim() || undefined,
        booking_type:      form.bookingType,
        nights:            effectiveNights,
        promo_code:        promoResult ? promoInput.trim().toUpperCase() : null,
        discount:          promoDiscount,
      };
      // GCash evidence rides alongside payment_method for both single
      // and multi-room walk-ins. Backend validates both are present
      // when method=gcash and mirrors them onto every sibling.
      if (form.payMethod === 'GCash') {
        payload.gcash_ref            = form.gcashRef.trim();
        payload.gcash_ref_image_url  = form.gcashRefImageUrl;
      }
      // Multi-room branch: expand primary + each sibling by their
      // qty so cottages/pavilions with quantity > 1 become multiple
      // rooms[] entries sharing the same room_id. Backend handles
      // duplicates up to room.quantity via its per-iteration
      // overlap count. Only the FIRST primary entry carries the
      // amenities (addon pool is reservation-wide).
      if (multiRoom || effectivePrimaryQty > 1) {
        const primaryEntries = [
          { room_id: Number(form.roomId), amenities },
          ...Array.from({ length: effectivePrimaryQty - 1 }).map(() => ({
            room_id: Number(form.roomId),
            amenities: [],
          })),
        ];
        const siblingEntries = additionalRoomRows.flatMap(r => {
          const q = Math.max(1, Number(r.ar.qty ?? 1));
          return Array.from({ length: q }).map(() => ({
            room_id: Number(r.ar.roomId),
            amenities: [],
          }));
        });
        payload.rooms = [...primaryEntries, ...siblingEntries];
      } else {
        payload.room_id  = Number(form.roomId);
        payload.amenities = amenities;
      }
      const res = await createWalkInBooking(payload);
      setFormOpen(false);
      setForm({ ...EMPTY_FORM, date: form.date });
      setAddonQtys(Object.fromEntries(addons.map(a => [a.id, 0])));
      setPromoInput(''); setPromoResult(null); setPromoError('');
      // Success: return to the consolidated Bookings view. Skip loadAll —
      // the Bookings page fetches its own data on mount.
      // Backend returns guest_reactivated=true when the matched user
      // row was deactivated and we flipped it back on (see WalkIn-
      // Controller comment on the auto-reactivate block). Surface that
      // explicitly so staff aren't surprised when the guest can suddenly
      // log in to /dashboard again.
      if (res?.guest_reactivated) {
        showToast(`Walk-in booking created. ${guestName}'s dormant account was reactivated.`, 'success');
      } else {
        showToast('Walk-in booking created.', 'success');
      }
      navigate(bookingsPath);
      return;
    } catch (err) {
      setFormError(
        err?.response?.data?.message ||
        'Failed to create booking. The room may already be booked for this time slot.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  // Confirm-step ack for short stays (wizard UI). No row-action handlers
  // here anymore — those moved to the Bookings page.
  const [shortStayAck, setShortStayAck] = useState(false);

  // Scan-QR submit. Same validation as handleCreate (which already
  // skips the GCash manual-ref checks when gcashMode==='qr'), then
  // POSTs with prepay=true. Response includes {invoice}; we stash it
  // and the polling effect below picks up state === 'paid'.
  async function handleGenerateQr() {
    // Reuse handleCreate's gating (which now also validates roomId,
    // tender, etc.) by calling it manually — but it opens the confirm
    // modal via setConfirmOpen(true), which we DON'T want in QR mode.
    // Re-run its core guards inline instead. This duplicates a few
    // lines but keeps the control flow obvious.
    setFormError('');
    if (!form.fullName.trim()) { setFormError('Guest name is required.'); return; }
    if (!form.roomId) { setFormError('Please select a room.'); return; }
    if (form.payMethod !== 'GCash' || form.gcashMode !== 'qr') return;

    setSubmitting(true);
    setQrGenerating(true);
    try {
      // Build the same payload shape handleConfirmCreate builds —
      // promoResult / multi-room branch / amenities — but with
      // prepay=true appended so the backend lands the rows as Pending
      // and returns a Xendit invoice.
      const checkInTime = form.bookingType === 'night'
        ? '18:00:00'
        : form.bookingType === '24hr-pm'
          ? '18:00:00'
          : (form.bookingType === '24hr' ? `${String(form.check_in_hour ?? 7).padStart(2,'0')}:00:00` : '07:00:00');
      const checkIn = `${form.date}T${checkInTime}`;
      const guestName = form.fullName.trim();
      const effectiveNights = form.bookingType === '24hr' ? Math.max(1, Number(form.nights) || 1) : 1;
      const amenities = visibleAddons
        .filter(a => Number(addonQtys[a.id] || 0) > 0)
        .map(a => ({ name: a.name, qty: Number(addonQtys[a.id]) }));
      const multiRoom = form.additionalRooms.length > 0;

      const payload = {
        guest_name:        guestName,
        guest_phone:       form.phone.trim(),
        guest_email:       form.email.trim() || undefined,
        check_in:          checkIn,
        guests:            Number(form.guests || 1),
        payment_method:    'gcash',
        prepay:            true,
        special_requests:  form.notes.trim() || undefined,
        booking_type:      form.bookingType,
        nights:            effectiveNights,
        promo_code:        promoResult ? promoInput.trim().toUpperCase() : null,
        discount:          promoDiscount,
      };
      if (multiRoom) {
        const primary = { room_id: Number(form.roomId), type: form.bookingType, nights: effectiveNights, amenities };
        const extras = form.additionalRooms.flatMap(r =>
          Array.from({ length: Math.max(1, Number(r.qty) || 1) }).map(() => ({
            room_id: Number(r.roomId), type: r.type || form.bookingType, nights: r.type === '24hr' ? Math.max(1, Number(r.nights) || 1) : 1, amenities: []
          }))
        );
        const expandedPrimary = Array.from({ length: Math.max(1, Number(form.primaryQty) || 1) }).map(() => primary);
        payload.rooms = [...expandedPrimary, ...extras];
      } else {
        payload.room_id  = Number(form.roomId);
        payload.amenities = amenities;
      }

      const res = await createWalkInBooking(payload);
      if (!res?.invoice?.invoice_id || !res?.invoice?.invoice_url) {
        throw new Error('Gateway returned no invoice.');
      }
      setQrInvoice({ ...res.invoice, state: 'pending' });
    } catch (err) {
      setFormError(
        err?.response?.data?.message ||
        err?.message ||
        'Failed to generate GCash QR. The room may already be booked.'
      );
    } finally {
      setSubmitting(false);
      setQrGenerating(false);
    }
  }

  // Scan-QR polling. Runs every 3s while qrInvoice.state === 'pending',
  // stops once the backend reports 'paid' (success; close modal + go
  // to Bookings) or 'failed' (expired/declined; let staff dismiss).
  useEffect(() => {
    if (!qrInvoice?.invoice_id) return;
    if (qrInvoice.state !== 'pending') return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const data = await getCounterXenditStatus(qrInvoice.invoice_id);
        if (cancelled) return;
        if (data.state === 'paid') {
          setQrInvoice(prev => prev ? { ...prev, state: 'paid' } : prev);
          showToast('Walk-in paid. Booking confirmed.', 'success');
          setTimeout(() => {
            setFormOpen(false);
            closeWizard();
            setQrInvoice(null);
            navigate(bookingsPath);
          }, 1500);
        } else if (data.state === 'failed') {
          setQrInvoice(prev => prev ? { ...prev, state: 'failed' } : prev);
        }
      } catch {
        // Transient poll error — wait for next tick.
      }
    }, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [qrInvoice?.invoice_id, qrInvoice?.state]);

  // ─── render ───────────────────────────────────────────────────────────────────
  return (
    <Shell>
      <Helmet><title>Walk-in — Frontdesk</title></Helmet>
      <Toast message={toast} type={toastType} onClose={clearToast} />

      {/* Cancel / Transfer row-action modals removed — those flows live on
          the consolidated Bookings page now. */}

      {/* ── Walk-in Confirmation Modal ── */}
      {confirmOpen && (() => {
        const selRoom    = rooms.find(r => String(r.id) === String(form.roomId));
        const guestName  = form.fullName.trim();
        const checkInLabel  = form.bookingType === 'night'    ? '6:00 PM'
                            : form.bookingType === '24hr'     ? 'Any time (from 7 AM)'
                            : form.bookingType === '24hr-pm'  ? 'Any time (from 6 PM)'
                            : '7:00 AM';
        const checkOutLabel = form.bookingType === 'night'    ? '6:00 AM (next day)'
                            : form.bookingType === '24hr'     ? '6:00 AM (next day)'
                            : form.bookingType === '24hr-pm'  ? '6:00 PM (next day)'
                            : '5:00 PM';
        const dateLabel  = form.date ? new Date(form.date + 'T00:00:00').toLocaleDateString('en-PH', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        }) : '—';
        const typeLabel  = form.bookingType === 'night'    ? 'Night Stay'
                         : form.bookingType === '24hr'     ? '24 Hours (AM)'
                         : form.bookingType === '24hr-pm'  ? '24 Hours (PM)'
                         : 'Day Visit';

        // Calculate remaining hours in slot if booking is for today
        let remainingHrs = null;
        if (form.date === today) {
          const now = new Date();
          const h = now.getHours() + now.getMinutes() / 60;
          if (form.bookingType === 'day')              remainingHrs = 17 - h;        // ends 5PM
          else if (form.bookingType === 'night')        remainingHrs = (h >= 18 ? (24 - h) + 6 : 6 - h);  // ends 6AM
          else if (form.bookingType === '24hr')         remainingHrs = (24 - h) + 6; // ends 6 AM next day
          else if (form.bookingType === '24hr-pm')      remainingHrs = (h >= 18 ? (24 - h) + 18 : 18 - h); // ends 6 PM next day
        }
        const shortStay = remainingHrs !== null && remainingHrs > 0 && remainingHrs < 4;

        return (
          <Modal open onClose={() => setConfirmOpen(false)} maxWidth="max-w-lg" label="Confirm walk-in booking">
            <div className="overflow-hidden">

              {/* Header */}
              <div className="bg-sky-700 px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3 text-white">
                  <i className="fas fa-clipboard-check text-xl"></i>
                  <div>
                    <h3 className="font-bold text-lg">Walk-in Booking Summary</h3>
                    <p className="text-sky-200 text-xs">Review all details before confirming</p>
                  </div>
                </div>
                <button onClick={() => setConfirmOpen(false)} type="button" className="w-11 h-11 inline-flex items-center justify-center rounded-md text-white/80 hover:text-white hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70" aria-label="Close">
                  <i className="fas fa-times"></i>
                </button>
              </div>

              <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">

                {/* Booking type badge */}
                <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-semibold ${
                  form.bookingType === 'night'   ? 'bg-indigo-100 text-indigo-800' :
                  is24hr                         ? 'bg-purple-100 text-purple-800' :
                                                   'bg-sky-100 text-sky-800'
                }`}>
                  <i className={`fas ${form.bookingType === 'night' ? 'fa-moon' : is24hr ? 'fa-clock' : 'fa-sun'}`}></i>
                  {typeLabel}
                </span>

                {/* Guest & Booking Details */}
                <div className="bg-slate-50 rounded-xl border border-slate-200 overflow-hidden">
                  <div className="bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wide">Guest</div>
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-slate-100">
                      <tr>
                        <td className="px-4 py-2.5 text-slate-500 font-medium w-32">Name</td>
                        <td className="px-4 py-2.5 font-semibold text-slate-900">{guestName}</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-2.5 text-slate-500 font-medium">Phone</td>
                        <td className="px-4 py-2.5 text-slate-900">{form.phone}</td>
                      </tr>
                      {form.email && (
                        <tr>
                          <td className="px-4 py-2.5 text-slate-500 font-medium">Email</td>
                          <td className="px-4 py-2.5 text-slate-900">{form.email}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  <div className="bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wide">Booking</div>
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-slate-100">
                      <tr>
                        <td className="px-4 py-2.5 text-slate-500 font-medium w-32">Room</td>
                        <td className="px-4 py-2.5 font-semibold text-slate-900">{selRoom?.name || '—'}</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-2.5 text-slate-500 font-medium">Date</td>
                        <td className="px-4 py-2.5 text-slate-900">{dateLabel}</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-2.5 text-slate-500 font-medium">Check-in</td>
                        <td className="px-4 py-2.5 text-slate-900">{checkInLabel}</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-2.5 text-slate-500 font-medium">Check-out</td>
                        <td className="px-4 py-2.5 text-slate-900">{checkOutLabel}</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-2.5 text-slate-500 font-medium">Guests</td>
                        <td className="px-4 py-2.5 text-slate-900">{form.guests} pax</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-2.5 text-slate-500 font-medium">Payment</td>
                        <td className="px-4 py-2.5 text-slate-900">{form.payMethod}</td>
                      </tr>
                      {form.notes && (
                        <tr>
                          <td className="px-4 py-2.5 text-slate-500 font-medium align-top">Notes</td>
                          <td className="px-4 py-2.5 text-slate-700 italic">"{form.notes}"</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  {visibleAddons.some(a => Number(addonQtys[a.id] || 0) > 0) && (
                    <>
                      <div className="bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wide">Add-ons</div>
                      <table className="w-full text-sm">
                        <tbody className="divide-y divide-slate-100">
                          {visibleAddons.filter(a => Number(addonQtys[a.id] || 0) > 0).map(a => {
                            const qty = Number(addonQtys[a.id]);
                            const subtotal = a.per_booking ? a.price : a.price * qty;
                            return (
                              <tr key={a.id}>
                                <td className="px-4 py-2.5 text-slate-500 font-medium w-32">{a.name}</td>
                                <td className="px-4 py-2.5 text-slate-900">
                                  {a.per_booking ? fmtMoney(subtotal) : `× ${qty} — ${fmtMoney(subtotal)}`}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>

                {/* Pricing Breakdown */}
                <div className={`rounded-xl border p-4 space-y-2 text-sm ${
                  form.bookingType === 'night' ? 'bg-indigo-50 border-indigo-200' :
                  is24hr                       ? 'bg-purple-50 border-purple-200' :
                                                 'bg-sky-50 border-sky-200'
                }`}>
                  <p className={`font-semibold mb-1 ${
                    form.bookingType === 'night' ? 'text-indigo-900' :
                    is24hr                       ? 'text-purple-900' : 'text-sky-900'
                  }`}>Payment Breakdown</p>
                  <div className="flex justify-between text-slate-700">
                    <span>
                      {form.additionalRooms.length > 0 ? 'Primary room' : `Room rate (${typeLabel})`}
                      {is24hr && effectiveNights > 1 && (
                        <span className="text-xs text-slate-500 ml-1">
                          · {fmtMoney(baseRate)} × {effectiveNights} nights
                        </span>
                      )}
                    </span>
                    <span>{fmtMoney(primaryRoomSubtotal)}</span>
                  </div>
                  {additionalRoomRows.filter(r => r.room).map((r, i) => {
                    const typeLbl = r.type === 'night' ? 'Night' : r.type === '24hr' ? '24hr AM' : r.type === '24hr-pm' ? '24hr PM' : 'Day';
                    return (
                      <div key={r.room.id} className="flex justify-between text-slate-700">
                        <span>
                          + {r.room.name}
                          <span className="text-xs text-slate-500 ml-1">
                            · {typeLbl}
                            {(r.type === '24hr' || r.type === '24hr-pm') && r.nights > 1
                              ? ` · ${fmtMoney(r.rate)} × ${r.nights} nights`
                              : ''}
                          </span>
                        </span>
                        <span>{fmtMoney(r.rate * r.nights)}</span>
                      </div>
                    );
                  })}
                  {amenityTotal > 0 && (
                    <div className="flex justify-between text-slate-700">
                      <span>Add-ons</span>
                      <span>{fmtMoney(amenityTotal)}</span>
                    </div>
                  )}
                  {promoDiscount > 0 ? (
                    <>
                      <div className="flex justify-between text-slate-600 border-t border-slate-200 pt-2">
                        <span>Subtotal</span>
                        <span className="line-through">{fmtMoney(previewSubtotal)}</span>
                      </div>
                      <div className="flex justify-between text-emerald-700 font-medium">
                        <span><i className="fas fa-tag mr-1 text-xs"></i>Promo ({promoInput.toUpperCase()})</span>
                        <span>− {fmtMoney(promoDiscount)}</span>
                      </div>
                    </>
                  ) : (
                    <div className="border-t border-slate-200 pt-1"></div>
                  )}
                  <div className={`flex justify-between font-bold text-base border-t pt-2 ${
                    form.bookingType === 'night' ? 'text-indigo-900 border-indigo-200' :
                    is24hr                       ? 'text-purple-900 border-purple-200' :
                                                   'text-sky-900 border-sky-200'
                  }`}>
                    <span>Booking Total</span>
                    <span>{fmtMoney(previewTotal)}</span>
                  </div>
                  <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                    <div className="flex justify-between text-amber-800 font-semibold text-sm">
                      <span className="flex items-center gap-1.5">
                        <i className="fas fa-ticket-alt text-amber-600"></i>
                        Entrance Fee
                        <span className="text-amber-600 font-normal text-xs">({form.guests} pax × ₱{entranceFeeRate})</span>
                      </span>
                      <span>{fmtMoney(entranceFeeTotal)}</span>
                    </div>
                  </div>
                  <div className="flex justify-between font-bold text-lg border-t-2 border-slate-300 pt-3 mt-3 text-slate-900">
                    <span>Total to Collect</span>
                    <span>{fmtMoney(previewTotal + entranceFeeTotal)}</span>
                  </div>
                  <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                    <i className="fas fa-info-circle"></i>
                    Entrance fee collected separately at the gate.
                  </p>
                </div>
              </div>

              {/* Short-stay warning */}
              {shortStay && (
                <div className="mx-6 mb-2 p-3 bg-amber-50 border border-amber-300 rounded-xl">
                  <div className="flex items-start gap-2">
                    <i className="fas fa-exclamation-triangle text-amber-600 mt-0.5"></i>
                    <div>
                      <p className="text-sm font-semibold text-amber-900">
                        Less than {Math.ceil(remainingHrs)} {Math.ceil(remainingHrs) === 1 ? 'hour' : 'hours'} remaining in this time slot
                      </p>
                      <p className="text-xs text-amber-700 mt-0.5">
                        The guest will have limited time. Full room rate still applies.
                      </p>
                      <label className="flex items-center gap-2 mt-2 cursor-pointer">
                        <input type="checkbox" checked={shortStayAck} onChange={e => setShortStayAck(e.target.checked)}
                          className="w-4 h-4 rounded border-amber-400 text-amber-600 focus:ring-amber-500" />
                        <span className="text-xs font-medium text-amber-800">I've informed the guest about the remaining time</span>
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="px-6 py-4 border-t border-slate-100 flex gap-3">
                <button type="button" onClick={() => setConfirmOpen(false)}
                  className="flex-1 inline-flex items-center justify-center min-h-11 px-4 py-2.5 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
                  <i className="fas fa-arrow-left mr-2" aria-hidden="true"></i>Back
                </button>
                <button type="button" onClick={handleConfirmCreate} disabled={submitting || (shortStay && !shortStayAck)}
                  className="flex-1 inline-flex items-center justify-center min-h-11 px-4 py-2.5 bg-sky-600 hover:bg-sky-700 disabled:opacity-60 text-white rounded-lg text-sm font-bold gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2">
                  {submitting
                    ? <><i className="fas fa-spinner fa-spin" aria-hidden="true"></i> Creating...</>
                    : <><i className="fas fa-check" aria-hidden="true"></i> Confirm Booking</>}
                </button>
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* Detail modal removed — guests are viewed from the Bookings page. */}

      {/* ── New Walk-in Modal ── */}
      {formOpen && (
        <Modal open onClose={() => { setFormOpen(false); setFormError(''); }} maxWidth="max-w-xl" label="New walk-in booking">
          <div className="max-h-[90vh] overflow-hidden flex flex-col">

            {/* Header */}
            <div className="bg-brand px-6 py-4 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3 text-white">
                <i className="fas fa-person-walking-luggage text-xl"></i>
                <div>
                  <h3 className="font-bold text-lg">New Walk-in Booking</h3>
                  <p className="text-sky-200 text-xs">Fill in guest and booking details</p>
                </div>
              </div>
              <button onClick={() => { setFormOpen(false); setFormError(''); closeWizard(); }} type="button" className="w-11 h-11 inline-flex items-center justify-center rounded-md text-white/80 hover:text-white hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70" aria-label="Close">
                <i className="fas fa-times"></i>
              </button>
            </div>

            <div id="walkin-scroll" className="overflow-y-auto flex-1 p-6">
              {formError && (
                <div role="alert" aria-live="assertive" className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-sm flex items-center gap-2">
                  <i className="fas fa-exclamation-circle" aria-hidden="true"></i>{formError}
                </div>
              )}

              {/* Step indicator */}
              <div className="flex items-center gap-2 mb-5">
                {[{ num: 1, label: 'Details' }, { num: 2, label: 'Extras & Summary' }].map((s, i) => (
                  <React.Fragment key={s.num}>
                    {i > 0 && <div className={`flex-1 h-px ${wiStep >= s.num ? 'bg-sky-400' : 'bg-slate-200'}`} />}
                    <button type="button" onClick={() => s.num < wiStep && setWiStep(s.num)}
                      className={`flex items-center gap-1.5 text-sm font-medium ${
                        wiStep === s.num ? 'text-sky-700' : wiStep > s.num ? 'text-sky-500 cursor-pointer' : 'text-slate-400'
                      }`}>
                      <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                        wiStep >= s.num ? 'bg-sky-600 text-white' : 'bg-slate-200 text-slate-500'
                      }`}>{wiStep > s.num ? '✓' : s.num}</span>
                      {s.label}
                    </button>
                  </React.Fragment>
                ))}
              </div>

              <div id="walkin-form">

                {/* ═══ STEP 1 — Guest & Booking Details ═══ */}
                {wiStep === 1 && (<>
                {/* Guest info */}
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-px flex-1 bg-slate-200"></div>
                  <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Guest Information</span>
                  <div className="h-px flex-1 bg-slate-200"></div>
                </div>

                {/* ── Returning-guest lookup ─────────────────────────────
                     Search across past customers (registered accounts +
                     prior walk-ins). Picking a match pre-fills the three
                     fields below. ARIA: combobox pattern (input owns the
                     listbox, aria-activedescendant points at the
                     highlighted option). aria-live="polite" on the count
                     line so screen-reader users hear the suggestion total
                     update as they type. */}
                <div ref={guestSearchRef} className="mb-4 relative">
                  <label htmlFor="wi-guest-search" className="block text-xs font-medium text-slate-700 mb-1">
                    Returning guest? <span className="text-slate-500 font-normal">— search by name, phone, or email</span>
                  </label>
                  <div className="relative">
                    <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs" aria-hidden="true"></i>
                    <input
                      id="wi-guest-search"
                      type="search"
                      value={guestSearch}
                      onChange={e => { setGuestSearch(e.target.value); setGuestSearchOpen(true); }}
                      onFocus={() => guestSearch.trim().length >= 2 && setGuestSearchOpen(true)}
                      onKeyDown={handleGuestSearchKeyDown}
                      placeholder="Type at least 2 characters…"
                      autoComplete="off"
                      role="combobox"
                      aria-expanded={guestSearchOpen && guestMatches.length > 0}
                      aria-controls="wi-guest-suggestions"
                      aria-autocomplete="list"
                      aria-activedescendant={
                        guestSearchOpen && guestMatches.length > 0
                          ? `wi-guest-opt-${highlightedGuestIdx}` : undefined
                      }
                      className="w-full border border-slate-200 rounded-xl pl-9 pr-9 py-2.5 min-h-11 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
                    />
                    {guestSearch && (
                      <button
                        type="button"
                        onClick={() => { setGuestSearch(''); setGuestSearchOpen(false); }}
                        aria-label="Clear search"
                        className="absolute right-1 top-1/2 -translate-y-1/2 w-11 h-11 inline-flex items-center justify-center rounded-full text-slate-500 hover:text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
                      >
                        <i className="fas fa-times text-xs" aria-hidden="true"></i>
                      </button>
                    )}
                  </div>

                  {/* Suggestions popover */}
                  {guestSearchOpen && guestSearch.trim().length >= 2 && (
                    <>
                      {guestMatches.length > 0 ? (
                        <ul
                          id="wi-guest-suggestions"
                          role="listbox"
                          aria-label="Returning guest suggestions"
                          className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-64 overflow-y-auto"
                        >
                          {guestMatches.map((g, i) => (
                            <li key={`${phoneKey(g.phone) || g.email || g.name}-${i}`} role="presentation">
                              <button
                                id={`wi-guest-opt-${i}`}
                                type="button"
                                role="option"
                                aria-selected={i === highlightedGuestIdx}
                                onMouseEnter={() => setHighlightedGuestIdx(i)}
                                onClick={() => pickReturningGuest(g)}
                                className={`w-full text-left px-3 py-2.5 min-h-11 flex items-baseline justify-between gap-3 border-b border-slate-100 last:border-b-0 transition-colors focus:outline-none ${
                                  i === highlightedGuestIdx ? 'bg-sky-50' : 'hover:bg-slate-50'
                                }`}
                              >
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium text-slate-800 truncate">{g.name}</p>
                                  <p className="text-xs text-slate-600 truncate">
                                    {g.phone || <span className="italic text-slate-500">no phone</span>}
                                    {g.email && ` · ${g.email}`}
                                  </p>
                                </div>
                                <span className="text-[10px] text-slate-600 shrink-0 tabular-nums whitespace-nowrap">
                                  {g.visits} {g.visits === 1 ? 'visit' : 'visits'}
                                  {g.source === 'account' && (
                                    <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 text-[9px] font-semibold">account</span>
                                  )}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg px-3 py-3 text-xs text-slate-600">
                          <i className="fas fa-circle-info mr-1.5 text-slate-400" aria-hidden="true"></i>
                          No matches — fill in the form below to register a new guest.
                        </div>
                      )}
                    </>
                  )}

                  {/* SR-only live region for suggestion count */}
                  <p className="sr-only" aria-live="polite">
                    {guestSearchOpen && guestSearch.trim().length >= 2
                      ? `${guestMatches.length} matching ${guestMatches.length === 1 ? 'guest' : 'guests'}.`
                      : ''}
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
                  <div className="col-span-2">
                    <label htmlFor="wi-fullname" className="block text-xs font-medium text-slate-700 mb-1">
                      Full Name *
                      {selectedReturningGuest && (
                        <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 normal-case tracking-normal">
                          <i className="fas fa-check-circle" aria-hidden="true"></i>
                          Returning guest
                          {selectedReturningGuest.source === 'account' && ' · linked to account'}
                          <button type="button" onClick={clearReturningGuest} className="ml-1 underline hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded">Clear</button>
                        </span>
                      )}
                    </label>
                    <input id="wi-fullname" type="text" value={form.fullName}
                      onChange={e => { setField('fullName', e.target.value); if (selectedReturningGuest) clearReturningGuest(); }}
                      placeholder="e.g. Juan dela Cruz Jr."
                      className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400" required />
                  </div>
                  <div>
                    <label htmlFor="wi-phone" className="block text-xs font-medium text-slate-700 mb-1">Phone <span className="text-slate-400 font-normal">(optional)</span></label>
                    <input id="wi-phone" type="tel" value={form.phone}
                      onChange={e => { setField('phone', e.target.value); if (selectedReturningGuest) clearReturningGuest(); }}
                      className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400" placeholder="+639XXXXXXXXX" />
                  </div>
                  <div>
                    <label htmlFor="wi-email" className="block text-xs font-medium text-slate-700 mb-1">Email</label>
                    <input id="wi-email" type="email" value={form.email}
                      onChange={e => { setField('email', e.target.value); if (selectedReturningGuest) clearReturningGuest(); }}
                      className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400" />
                  </div>
                </div>

                {/* Booking details */}
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-px flex-1 bg-slate-200"></div>
                  <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Booking Details</span>
                  <div className="h-px flex-1 bg-slate-200"></div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">

                  {/* Date — must be chosen first */}
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-slate-700 mb-1">Date *</label>
                    <input type="date" value={form.date} min={today}
                      onChange={e => setField('date', e.target.value)}
                      aria-label="Booking date"
                      className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400" required />
                  </div>

                  {/* Booking type — compact pills. Walk-in form defaults
                      date to today so the empty-date case is rare, but if
                      staff blanks the date input out, lock the pills out
                      the same way BookingModal does. dayPassed + typeAllowed
                      both read form.date, so their enable-state is
                      meaningless without a date. */}
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-slate-700 mb-2" id="walkin-booking-type-label">
                      Booking Type *
                      {!form.date && (
                        <span className="ml-2 text-slate-600 font-normal">Pick a date first</span>
                      )}
                    </label>
                    <div className="flex gap-2" role="group" aria-labelledby="walkin-booking-type-label">
                      {[
                        { type: 'day',     icon: 'fa-sun',   label: 'Day',       disabled: !form.date || dayPassed || !typeAllowed('day') },
                        { type: 'night',   icon: 'fa-moon',  label: 'Night',     disabled: !form.date || !typeAllowed('night') },
                        { type: '24hr',    icon: 'fa-clock', label: '24 Hrs AM', disabled: !form.date || twentyFourPassed || !typeAllowed('24hr') },
                        { type: '24hr-pm', icon: 'fa-clock', label: '24 Hrs PM', disabled: !form.date || !typeAllowed('24hr-pm') },
                      ].map(opt => {
                        // Compare directly — is24hr covers both 24hr and 24hr-pm, so
                        // using it to light up the AM tab would also light up when
                        // PM is picked.
                        const active = form.bookingType === opt.type;
                        return (
                          <button key={opt.type} type="button"
                            disabled={opt.disabled}
                            aria-pressed={active}
                            onClick={() => { if (!opt.disabled) setField('bookingType', opt.type); }}
                            className={`flex-1 flex items-center justify-center gap-1.5 py-3 md:py-2 border-2 rounded-lg text-sm font-medium transition-colors ${
                              opt.disabled
                                ? 'border-slate-100 bg-slate-50 opacity-50 cursor-not-allowed'
                                : active ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-200 text-slate-600 hover:border-slate-300'
                            }`}
                          >
                            <i className={`fas ${opt.icon} text-xs ${active && !opt.disabled ? 'text-sky-500' : 'text-slate-400'}`} aria-hidden="true"></i>
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                    {form.roomId && (
                      <p className="mt-1 text-xs text-slate-500 text-center">
                        {fmtMoney(form.bookingType === 'night' ? nightRate : is24hr ? rate24 : dayRate)} / {form.bookingType === 'night' ? 'night' : is24hr ? '24 hrs' : 'day'}
                      </p>
                    )}

                    {/* 24hr: fixed window (7 AM – next day 6 AM); no start-hour picker.
                        Multi-night stretches the window to 6 AM on the (N+1)th day. */}
                    {is24hr && (
                      <div className="mt-3 space-y-2">
                        <div className="rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 text-xs text-purple-900">
                          <i className="fas fa-circle-info mr-1.5" aria-hidden="true"></i>
                          {is24hrPm ? (
                            <>Guest may arrive any time from 6:00 PM on the selected date. Check-out is 6:00 PM {form.nights > 1 ? `on day ${form.nights + 1}.` : 'the next day.'}</>
                          ) : (
                            <>Guest may arrive any time on the selected date. Check-out is 6:00 AM {form.nights > 1 ? `on day ${form.nights + 1}.` : 'the next morning.'}</>
                          )}
                        </div>

                        {/* Multi-night stepper. Caps at 14 nights to match
                            backend validator. Buttons mutate form.nights;
                            display is tabular so layout doesn't shift. */}
                        <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                          <div className="text-xs text-amber-900">
                            <i className="fas fa-moon mr-1.5" aria-hidden="true"></i>
                            Number of nights
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setField('nights', Math.max(1, Number(form.nights) - 1))}
                              disabled={form.nights <= 1}
                              className="w-7 h-7 rounded-md bg-white border border-amber-300 text-amber-700 text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-amber-100"
                              aria-label="Decrease nights"
                            >
                              <i className="fas fa-minus" aria-hidden="true"></i>
                            </button>
                            <span className="min-w-[2.5rem] text-center text-sm font-bold text-amber-900 tabular-nums">
                              {form.nights} {form.nights === 1 ? 'night' : 'nights'}
                            </span>
                            <button
                              type="button"
                              onClick={() => setField('nights', Math.min(30, Number(form.nights) + 1))}
                              disabled={form.nights >= 30}
                              className="w-7 h-7 rounded-md bg-white border border-amber-300 text-amber-700 text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-amber-100"
                              aria-label="Increase nights"
                            >
                              <i className="fas fa-plus" aria-hidden="true"></i>
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Multi-room gate — placed ABOVE the room picker so
                      staff sees the toggle before committing a room.
                      Visible regardless of whether a room has been
                      picked or not. */}
                  <div className="col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer select-none mb-1">
                      <input
                        type="checkbox"
                        checked={form.multiRoomMode}
                        onChange={e => setField('multiRoomMode', e.target.checked)}
                        className="w-4 h-4 text-sky-600 bg-white border-slate-300 rounded focus:ring-2 focus:ring-sky-500"
                        aria-label="Book multiple rooms"
                      />
                      <span className="text-sm text-slate-800 font-medium">
                        <i className="fas fa-layer-group mr-1 text-sky-600" aria-hidden="true"></i>
                        Book multiple rooms
                      </span>
                      <span className="text-xs text-slate-600">
                        (same reservation, one entrance fee)
                      </span>
                    </label>
                  </div>

                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Room *
                      {!form.date ? (
                        <span className="ml-1 text-slate-600 font-normal">Pick a date first</span>
                      ) : availChecking && (
                        <span className="ml-1 text-slate-600 font-normal">Checking availability...</span>
                      )}
                    </label>
                    <select value={form.roomId} onChange={e => setField('roomId', e.target.value)}
                      aria-label="Room selection"
                      disabled={!form.date}
                      className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed" required>
                      <option value="">Select room / cottage / pavilion
                      </option>
                      {(() => {
                        const visible = rooms.filter(r => availability === null || availability?.[String(r.id)] === true);
                        // Name-based fallback matches owner/Rooms.jsx so
                        // rooms without an explicit category column still
                        // land in the right optgroup. Adding 'tent' here
                        // fixes a pre-existing bug where tent rooms fell
                        // through to 'room' and made the Tent Pitching
                        // optgroup render empty (which then got hidden
                        // entirely by the !items.length guard below).
                        //
                        // 'admission' — backing the "Entrance Only"
                        // pseudo-room. Matches on both category and
                        // name-substring so even a DB without the
                        // category column drifts into the right group.
                        const getCat  = r => r.category || (
                          r.name.toLowerCase().includes('cottage')   ? 'cottage'   :
                          r.name.toLowerCase().includes('pavilion')  ? 'pavilion'  :
                          r.name.toLowerCase().includes('tent')      ? 'tent'      :
                          r.name.toLowerCase().includes('entrance')  ? 'admission' :
                          'room'
                        );
                        // Price shown matches the booking type the user
                        // picked on the previous step. Fallback matches
                        // the defaults computed at line 175-177.
                        const rateFor = (r) => {
                          if (form.bookingType === 'night')  return Number(r.overnight_rate ?? 1500);
                          if (form.bookingType === '24hr' || form.bookingType === '24hr-pm') return Number(r.rate_24hr ?? 2000);
                          return Number(r.day_rate ?? 1500); // 'day'
                        };
                        // Emoji prefixes live HERE — and only here —
                        // because <optgroup>/<option> in a native <select>
                        // cannot render Font Awesome glyphs or any HTML.
                        // The FA icons used on the /frontdesk/rooms
                        // category headers work there because those are
                        // real <h2> elements. Inside a native select,
                        // emoji Unicode is the only category-icon option.
                        // Category headers are structural, not decorative
                        // chrome — so this is an intentional exception to
                        // the broader "no emoji in labels" rule.
                        const groups  = [
                          // 'admission' first — it's the shortest path
                          // through the form for walk-in day-trippers
                          // who just want gate entry + maybe add-ons.
                          // Rate column shows ₱0 because only entrance
                          // fee + add-ons charge, not a room rate.
                          { key: 'admission', label: '🎫  Entrance Only'  },
                          { key: 'room',      label: '🛏️  Rooms'         },
                          { key: 'cottage',   label: '⛱️  Cottages'      },
                          { key: 'pavilion',  label: '🏛️  Pavilions'     },
                          { key: 'tent',      label: '⛺  Tent Pitching' },
                        ];
                        return groups.map(g => {
                          const items = visible.filter(r => getCat(r) === g.key);
                          if (!items.length) return null;
                          return (
                            <optgroup key={g.key} label={g.label}>
                              {items.map(r => (
                                <option key={r.id} value={r.id}>
                                  {r.name} — ₱{rateFor(r).toLocaleString('en-PH')}{r.capacity_label ? ` · ${r.capacity_label}` : ''}
                                </option>
                              ))}
                            </optgroup>
                          );
                        });
                      })()}
                    </select>
                    {(() => {
                      const sel = rooms.find(r => String(r.id) === String(form.roomId));
                      const avail = sel ? availability?.[String(sel.id)] : undefined;
                      if (avail === false) return (
                        <p className="mt-1 text-xs text-rose-600 flex items-center gap-1">
                          <i className="fas fa-times-circle"></i>
                          This room is not available for the selected date.
                        </p>
                      );
                      if (avail === true) return (
                        <p className="mt-1 text-xs text-emerald-600 flex items-center gap-1">
                          <i className="fas fa-check-circle"></i>
                          Room is available.
                        </p>
                      );
                      return null;
                    })()}
                    {/* Primary room qty stepper — only shown when
                        the selected room has multiple physical
                        units (cottages, pavilions where quantity
                        > 1) AND we're in multi-room mode. For
                        single-unit rooms this stays hidden; single-
                        room mode doesn't need it either. */}
                    {form.multiRoomMode && selectedRoom && Number(selectedRoom.quantity ?? 1) > 1 && (
                      <div className="mt-2 flex items-center justify-between rounded-lg bg-sky-50 border border-sky-200 px-3 py-2">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-sky-900">
                          <i className="fas fa-cubes text-sky-500" aria-hidden="true"></i>
                          How many {selectedRoom.name}?
                        </div>
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setField('primaryQty', Math.max(1, Number(form.primaryQty) - 1))}
                            disabled={Number(form.primaryQty) <= 1}
                            aria-label={`Decrease ${selectedRoom.name} count`}
                            className="w-7 h-7 inline-flex items-center justify-center rounded-full bg-white border border-sky-300 text-sky-700 hover:bg-sky-100 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <i className="fas fa-minus text-[11px]" aria-hidden="true"></i>
                          </button>
                          <span className="min-w-[1.75rem] text-center text-sm font-bold tabular-nums text-sky-900">
                            {form.primaryQty}
                          </span>
                          <button
                            type="button"
                            onClick={() => setField('primaryQty', Math.min(Number(selectedRoom.quantity), Number(form.primaryQty) + 1))}
                            disabled={Number(form.primaryQty) >= Number(selectedRoom.quantity)}
                            aria-label={`Increase ${selectedRoom.name} count`}
                            title={Number(form.primaryQty) >= Number(selectedRoom.quantity) ? `Max ${selectedRoom.quantity} units` : undefined}
                            className="w-7 h-7 inline-flex items-center justify-center rounded-full bg-white border border-sky-300 text-sky-700 hover:bg-sky-100 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <i className="fas fa-plus text-[11px]" aria-hidden="true"></i>
                          </button>
                          <span className="text-[10px] text-sky-700 font-medium">
                            / {selectedRoom.quantity} units
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Additional rooms in the SAME reservation. All share
                      the same booking type + date + nights + guest count.
                      Add-ons for additional rooms are added via the
                      per-booking staff flow post-check-in — shared-pool
                      items like pillows should be added on the primary
                      room above since the pool is reservation-wide. */}
                  {form.multiRoomMode && (
                  <div className="col-span-2">
                    {form.additionalRooms.map((ar, idx) => {
                      const row = additionalRoomRows[idx];
                      const effType = row.type;
                      const effN    = row.nights;
                      const rate    = row.rate;
                      const addedIds = new Set([
                        String(form.roomId),
                        ...form.additionalRooms.map(x => String(x.roomId)).filter((_, i) => i !== idx),
                      ]);
                      const pickableRooms = rooms.filter(r =>
                        (availability === null || availability?.[String(r.id)] === true)
                        && !addedIds.has(String(r.id))
                        && r.category !== 'tent'
                        && (!r.allowed_booking_types || r.allowed_booking_types.includes(effType))
                      );
                      const patchRoom = (patch) => setForm(f => ({
                        ...f,
                        additionalRooms: f.additionalRooms.map(x =>
                          x.tempId === ar.tempId ? { ...x, ...patch } : x
                        ),
                      }));
                      return (
                        <div key={ar.tempId} className="mt-3 rounded-xl border-2 border-sky-200 bg-sky-50/40 p-3">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-900">
                              <i className="fas fa-plus-circle text-sky-600"></i>
                              Additional Room #{idx + 1}
                            </div>
                            <button type="button"
                              onClick={() => setForm(f => ({
                                ...f,
                                additionalRooms: f.additionalRooms.filter(x => x.tempId !== ar.tempId),
                              }))}
                              className="text-xs text-rose-600 hover:text-rose-700 font-medium px-2 py-1 rounded hover:bg-rose-50"
                              aria-label={`Remove additional room ${idx + 1}`}
                            >
                              <i className="fas fa-times mr-1"></i>Remove
                            </button>
                          </div>
                          <select value={ar.roomId}
                            onChange={e => patchRoom({ roomId: e.target.value, qty: 1 })}
                            disabled={!form.date}
                            aria-label={`Additional room ${idx + 1} selection`}
                            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400 disabled:bg-slate-100">
                            <option value="">Select additional room</option>
                            {pickableRooms.map(r => (
                              <option key={r.id} value={r.id}>
                                {r.name} — ₱{Number(rateForRoom(r, effType)).toLocaleString()}
                                {effN > 1 ? ` × ${effN} nights` : ''}
                              </option>
                            ))}
                          </select>
                          {/* Sibling qty stepper — appears when the
                              picked room has quantity > 1. Lets staff
                              book e.g. 3 Medium Cottages in one
                              sibling without needing to add 3 rows. */}
                          {row.room && Number(row.room.quantity ?? 1) > 1 && (
                            <div className="mt-2 flex items-center justify-between rounded-md bg-sky-50 border border-sky-200 px-2 py-1.5">
                              <div className="flex items-center gap-1.5 text-[11px] font-medium text-sky-900">
                                <i className="fas fa-cubes text-sky-500" aria-hidden="true"></i>
                                How many {row.room.name}?
                              </div>
                              <div className="inline-flex items-center gap-1.5">
                                <button type="button"
                                  onClick={() => patchRoom({ qty: Math.max(1, Number(ar.qty ?? 1) - 1) })}
                                  disabled={Number(ar.qty ?? 1) <= 1}
                                  aria-label={`Decrease ${row.room.name} count`}
                                  className="w-6 h-6 inline-flex items-center justify-center rounded bg-white border border-sky-300 text-sky-700 text-[10px] font-bold disabled:opacity-40"
                                ><i className="fas fa-minus"></i></button>
                                <span className="min-w-[1.5rem] text-center text-xs font-bold tabular-nums text-sky-900">
                                  {ar.qty ?? 1}
                                </span>
                                <button type="button"
                                  onClick={() => patchRoom({ qty: Math.min(Number(row.room.quantity), Number(ar.qty ?? 1) + 1) })}
                                  disabled={Number(ar.qty ?? 1) >= Number(row.room.quantity)}
                                  aria-label={`Increase ${row.room.name} count`}
                                  title={Number(ar.qty ?? 1) >= Number(row.room.quantity) ? `Max ${row.room.quantity} units` : undefined}
                                  className="w-6 h-6 inline-flex items-center justify-center rounded bg-white border border-sky-300 text-sky-700 text-[10px] font-bold disabled:opacity-40"
                                ><i className="fas fa-plus"></i></button>
                                <span className="text-[10px] text-sky-700 font-medium pl-0.5">
                                  / {row.room.quantity}
                                </span>
                              </div>
                            </div>
                          )}
                          {rate > 0 && (
                            <p className="mt-1 text-xs text-sky-700">
                              Subtotal: ₱{(rate * effN * (ar.qty ?? 1)).toLocaleString()}
                              {(ar.qty ?? 1) > 1 && (
                                <span className="text-sky-600 ml-1">
                                  (× {ar.qty} units)
                                </span>
                              )}
                              {effN > 1 && (
                                <span className="text-sky-600 ml-1">
                                  (₱{rate.toLocaleString()} × {effN} nights)
                                </span>
                              )}
                            </p>
                          )}
                        </div>
                      );
                    })}

                    <button type="button"
                      disabled={!form.roomId}
                      onClick={() => setForm(f => ({
                        ...f,
                        additionalRooms: [
                          ...f.additionalRooms,
                          {
                            tempId: `room-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                            roomId: '',
                            // Default to the primary's type + nights.
                            // Staff can override to build a mixed-type
                            // group (Day cottage + Night pavilion in
                            // the same reservation).
                            bookingType: f.bookingType,
                            nights: (f.bookingType === '24hr' || f.bookingType === '24hr-pm') ? f.nights : 1,
                          },
                        ],
                      }))}
                      className="mt-3 w-full flex items-center justify-center gap-2 border-2 border-dashed border-sky-300 bg-white hover:bg-sky-50 text-sky-700 font-medium text-sm py-2.5 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <i className="fas fa-plus" aria-hidden="true"></i>
                      Add Another Room
                      {!form.roomId && (
                        <span className="text-xs text-slate-500 font-normal">(pick primary room first)</span>
                      )}
                    </button>
                  </div>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      No. of Guests *
                      <span className="ml-1 text-slate-600 font-normal">(for entrance fee)</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <button type="button"
                        onClick={() => setField('guests', Math.max(1, Number(form.guests) - 1))}
                        className="w-11 h-11 border border-slate-200 rounded-lg text-lg font-bold text-slate-600 hover:bg-slate-100">−</button>
                      <input type="number" min="1" max="200" value={form.guests}
                        onChange={e => setField('guests', Math.max(1, Number(e.target.value) || 1))}
                        aria-label="Number of guests"
                        className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-sky-400" />
                      <button type="button"
                        onClick={() => setField('guests', Number(form.guests) + 1)}
                        className="w-11 h-11 border border-slate-200 rounded-lg text-lg font-bold text-slate-600 hover:bg-slate-100">+</button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Payment Method *</label>
                    <div className="flex gap-2">
                      {[
                        { value: 'Cash',  icon: 'fa-money-bill-wave', color: 'text-emerald-600' },
                        { value: 'GCash', icon: 'fa-mobile-alt',      color: 'text-sky-500'  },
                          ].map(opt => (
                        <button key={opt.value} type="button"
                          onClick={() => {
                            setField('payMethod', opt.value);
                            // Clear the OTHER method's evidence so a stale
                            // entry from an aborted switch can't tag along
                            // on submit. Backend ignores either way, but
                            // the UI shouldn't carry stale state across
                            // method changes.
                            if (opt.value !== 'GCash') {
                              setField('gcashRef', '');
                              setField('gcashRefImageUrl', '');
                            } else {
                              setField('cashTender', '');
                            }
                          }}
                          className={`flex-1 flex items-center justify-center gap-1.5 py-2 border-2 rounded-lg text-xs font-medium transition-colors ${
                            form.payMethod === opt.value
                              ? 'border-sky-500 bg-sky-50 text-sky-700'
                              : 'border-slate-200 text-slate-600 hover:border-slate-300'
                          }`}
                        >
                          <i className={`fas ${opt.icon} text-xs ${form.payMethod === opt.value ? '' : opt.color}`}></i>
                          {opt.value}
                        </button>
                      ))}
                    </div>
                    {/* GCash sub-mode — same as Billing Collect modal.
                        Scan QR mode creates the walk-in as Pending and
                        opens a Xendit invoice; Manual Ref mode collects
                        a typed reference + screenshot. */}
                    {form.payMethod === 'GCash' && (
                      <div className="mt-2 grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded">
                        <button
                          type="button"
                          onClick={() => setField('gcashMode', 'qr')}
                          className={`py-1.5 rounded text-[11px] font-medium transition-colors ${
                            form.gcashMode === 'qr'
                              ? 'bg-white text-sky-700 shadow-sm'
                              : 'text-slate-600 hover:text-slate-800'
                          }`}
                        >
                          <i className="fas fa-qrcode mr-1"></i>Scan QR
                        </button>
                        <button
                          type="button"
                          onClick={() => setField('gcashMode', 'ref')}
                          className={`py-1.5 rounded text-[11px] font-medium transition-colors ${
                            form.gcashMode === 'ref'
                              ? 'bg-white text-sky-700 shadow-sm'
                              : 'text-slate-600 hover:text-slate-800'
                          }`}
                        >
                          <i className="fas fa-keyboard mr-1"></i>Manual Ref
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                </>)}

                {/* ═══ STEP 2 — Extras & Summary ═══ */}
                {wiStep === 2 && (<>

                {/* Check-in / Check-out display */}
                <div className="mb-4">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Check-in / Check-out</label>
                  <div className={`border border-slate-200 rounded-xl px-3 py-2 w-full text-sm font-medium flex items-center gap-2 ${
                    form.bookingType === 'night'   ? 'bg-indigo-50 text-indigo-700' :
                    is24hr                         ? 'bg-purple-50 text-purple-700' :
                                                     'bg-sky-50 text-sky-700'
                  }`}>
                    <i className={`fas ${form.bookingType === 'night' ? 'fa-moon' : is24hr ? 'fa-clock' : 'fa-sun'}`}></i>
                    {(() => {
                      if (form.bookingType === 'night') return '6:00 PM → 6:00 AM (next day)';
                      if (form.bookingType === '24hr')    return '7:00 AM → 6:00 AM (next day)';
                      if (form.bookingType === '24hr-pm') return '6:00 PM → 6:00 PM (next day)';
                      return '7:00 AM → 5:00 PM';
                    })()}
                  </div>
                </div>

                {/* Notes */}
                {showWiNotes ? (
                  <div className="mb-4">
                    <label className="block text-xs font-medium text-slate-700 mb-1">Notes</label>
                    <input type="text" value={form.notes} onChange={e => setField('notes', e.target.value)}
                      aria-label="Special requests"
                      className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
                      placeholder="Special requests, remarks..." />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowWiNotes(true)}
                    aria-label="Add notes or special requests"
                    className="inline-flex items-center min-h-11 mb-4 px-3 py-2 rounded-lg text-xs font-medium text-sky-700 hover:bg-sky-50 hover:text-sky-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
                  >
                    <i className="fas fa-plus mr-1.5" aria-hidden="true"></i>Add notes / special requests
                  </button>
                )}

                {/* Amenities — fetched from API */}
                {visibleAddons.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 mb-3">
                      <div className="h-px flex-1 bg-slate-200"></div>
                      <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Add-on Amenities</span>
                      <div className="h-px flex-1 bg-slate-200"></div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                      {visibleAddons.map(a => {
                        const qty       = Number(addonQtys[a.id] || 0);
                        const isFixed   = a.per_booking;
                        const active    = qty > 0;
                        const avail     = addonAvailability[a.id];
                        const remaining = avail?.remaining;
                        // Cap by both backend inventory (`remaining` across overlapping
                        // bookings) and catalog `max_qty`. If availability hasn't loaded
                        // yet, fall back to max_qty so the UI still works.
                        const cap       = remaining != null ? Math.min(remaining, a.max_qty) : a.max_qty;
                        const soldOut   = remaining === 0 && !active;
                        const atCap     = qty >= cap;
                        // Room-fixture rows get amber ring + bg tint + a
                        // bigger badge so they visually lead the picker.
                        // Staff scan top-to-bottom and see "this is for
                        // THIS room, don't miss it" before diving into the
                        // shared-pool list below.
                        const isOptional = a.relation === 'optional';
                        const roomTag = isOptional ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-400 text-white text-[10px] font-bold uppercase tracking-wide shadow-sm">
                            <i className="fas fa-link text-[9px]"></i>For {selectedRoom?.name}
                          </span>
                        ) : null;
                        // Baseline classes + amber accent layered on for
                        // optionals. Active/soldOut states still override.
                        const optionalAccent = isOptional
                          ? 'ring-2 ring-amber-300 bg-amber-50/60'
                          : '';
                        if (isFixed) {
                          return (
                            <button key={a.id} type="button"
                              disabled={soldOut}
                              onClick={() => !soldOut && setAddonQtys(q => ({ ...q, [a.id]: active ? 0 : 1 }))}
                              title={soldOut ? 'All units reserved for this window.' : undefined}
                              className={`border rounded-lg p-3 text-left transition-colors ${
                                soldOut
                                  ? 'border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed'
                                  : active
                                    ? 'border-indigo-400 bg-indigo-50'
                                    : `border-slate-200 hover:border-slate-300 ${optionalAccent}`
                              }`}
                            >
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <i className={`fas ${a.icon || 'fa-tag'} ${active ? 'text-indigo-600' : isOptional ? 'text-amber-600' : 'text-slate-400'}`}></i>
                                <p className={`text-sm font-medium ${active ? 'text-indigo-700' : soldOut ? 'text-slate-400' : 'text-slate-700'}`}>{a.name}</p>
                                {roomTag}
                              </div>
                              <p className="text-xs text-slate-500">₱{Number(a.price).toLocaleString()} flat</p>
                              {soldOut ? (
                                <p className="text-xs font-medium text-rose-500 mt-1">Sold out for this window</p>
                              ) : remaining != null ? (
                                <p className="text-[11px] text-slate-500 mt-1">{Math.max(0, remaining - (active ? 1 : 0))} of {a.max_qty} left in pool</p>
                              ) : null}
                              {active && <p className="text-xs font-medium text-indigo-700 mt-1">Added ✓</p>}
                            </button>
                          );
                        }
                        return (
                          <div key={a.id} className={`border rounded-lg p-3 ${
                            soldOut ? 'bg-slate-50 border-slate-200' : optionalAccent || ''
                          }`}>
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <i className={`fas ${a.icon || 'fa-tag'} ${isOptional ? 'text-amber-600' : 'text-slate-500'}`}></i>
                              <p className={`text-sm font-medium ${soldOut ? 'text-slate-400' : 'text-slate-700'}`}>{a.name}</p>
                              {roomTag}
                              <span className="ml-auto text-xs text-slate-500">₱{Number(a.price).toLocaleString()} each</span>
                            </div>
                            {soldOut ? (
                              <p className="text-xs font-medium text-rose-500 mb-1">Sold out for this window</p>
                            ) : remaining != null ? (
                              // Live pool free, decrementing as staff clicks +/−.
                              // `remaining` is pool minus existing bookings; staff's
                              // staged qty shrinks that further for the preview.
                              <p className="text-[11px] text-slate-500 mb-1">{Math.max(0, remaining - qty)} of {a.max_qty} left in pool</p>
                            ) : null}
                            <div className="flex items-center gap-2">
                              <button type="button"
                                disabled={qty === 0}
                                onClick={() => setAddonQtys(q => ({ ...q, [a.id]: Math.max(0, qty - 1) }))}
                                aria-label={`Decrease ${a.name} quantity`}
                                className="w-11 h-11 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 text-sm font-bold disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2">−</button>
                              <span className="w-8 text-center text-sm font-medium" aria-live="polite" aria-label={`${a.name} quantity ${qty}`}>{qty}</span>
                              <button type="button"
                                disabled={atCap}
                                onClick={() => setAddonQtys(q => ({ ...q, [a.id]: Math.min(cap, qty + 1) }))}
                                title={atCap && remaining != null ? `Only ${remaining} left for this window.` : undefined}
                                aria-label={`Increase ${a.name} quantity`}
                                className="w-11 h-11 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 text-sm font-bold disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2">+</button>
                              {qty > 0 && (
                                <span className="ml-auto text-xs font-medium text-sky-700">₱{(qty * a.price).toLocaleString()}</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                {/* Promo code */}
                <div className="mb-3">
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    <i className="fas fa-tag mr-1 text-sky-500"></i>Promo Code <span className="text-slate-600 font-normal text-xs">(optional)</span>
                  </label>
                  {promoResult ? (
                    <div className="flex items-center gap-2 px-3 py-2 bg-emerald-50 border border-emerald-300 rounded-md">
                      <i className="fas fa-check-circle text-emerald-600" aria-hidden="true"></i>
                      <span className="text-sm text-emerald-800 font-medium flex-1">{promoResult.message}</span>
                      <button
                        type="button"
                        onClick={removePromo}
                        aria-label="Remove promo code"
                        className="inline-flex items-center justify-center min-h-11 px-3 py-2 rounded text-xs font-medium text-slate-700 hover:text-rose-700 hover:bg-white underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2"
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={promoInput}
                        onChange={e => { setPromoInput(e.target.value.toUpperCase()); setPromoError(''); }}
                        onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), applyPromo())}
                        placeholder="Enter promo code"
                        aria-label="Promo code"
                        className="flex-1 px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500"
                      />
                      <button
                        type="button"
                        onClick={applyPromo}
                        disabled={!promoInput.trim() || promoLoading}
                        aria-label="Apply promo code"
                        className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white text-sm font-medium rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
                      >
                        {promoLoading ? <i className="fas fa-spinner fa-spin" aria-hidden="true"></i> : 'Apply'}
                      </button>
                    </div>
                  )}
                  {promoError && <p className="mt-1 text-xs text-rose-600"><i className="fas fa-times-circle mr-1"></i>{promoError}</p>}
                </div>

                {/* Pricing preview */}
                {(() => {
                  const typeColors = {
                    day:       { bg: 'bg-sky-50',     border: 'border-sky-200',    text: 'text-sky-800',    sub: 'text-sky-700',    hr: 'border-sky-200'    },
                    night:     { bg: 'bg-indigo-50',  border: 'border-indigo-200', text: 'text-indigo-800', sub: 'text-indigo-700', hr: 'border-indigo-200' },
                    '24hr':    { bg: 'bg-purple-50',  border: 'border-purple-200', text: 'text-purple-800', sub: 'text-purple-700', hr: 'border-purple-200' },
                    '24hr-pm': { bg: 'bg-purple-50',  border: 'border-purple-200', text: 'text-purple-800', sub: 'text-purple-700', hr: 'border-purple-200' },
                  };
                  const tc = typeColors[form.bookingType] ?? typeColors.day;
                  const ciLabel = form.bookingType === 'night'    ? '6:00 PM'
                                : form.bookingType === '24hr'     ? 'Any time (from 7 AM)'
                                : form.bookingType === '24hr-pm'  ? 'Any time (from 6 PM)'
                                : '7:00 AM';
                  const coLabel = form.bookingType === 'night'    ? '6:00 AM (next day)'
                                : form.bookingType === '24hr'     ? (effectiveNights > 1 ? `6:00 AM (day ${effectiveNights + 1})` : '6:00 AM (next day)')
                                : form.bookingType === '24hr-pm'  ? (effectiveNights > 1 ? `6:00 PM (day ${effectiveNights + 1})` : '6:00 PM (next day)')
                                : '5:00 PM';
                  const rateLabel = form.bookingType === 'night' ? 'Night rate' : is24hr ? '24 hr rate' : 'Day rate';
                  return (
                    <div className={`p-3 rounded text-sm border ${tc.bg} ${tc.border}`}>
                      <div className={`space-y-0.5 ${tc.sub}`}>
                        <div className="flex justify-between">
                          <span>
                            {form.additionalRooms.length > 0 ? `Primary room (${rateLabel})` : rateLabel}
                            {is24hr && effectiveNights > 1 && (
                              <span className="text-xs opacity-70 ml-1">
                                · {fmtMoney(baseRate)} × {effectiveNights} nights
                              </span>
                            )}
                          </span>
                          <span>{fmtMoney(primaryRoomSubtotal)}</span>
                        </div>
                        {additionalRoomRows.filter(r => r.room).map((r) => {
                          const typeLbl = r.type === 'night' ? 'Night' : r.type === '24hr' ? '24hr AM' : r.type === '24hr-pm' ? '24hr PM' : 'Day';
                          return (
                            <div key={r.room.id} className="flex justify-between">
                              <span>
                                + {r.room.name}
                                <span className="text-xs opacity-70 ml-1">
                                  · {typeLbl}
                                  {(r.type === '24hr' || r.type === '24hr-pm') && r.nights > 1
                                    ? ` · ${fmtMoney(r.rate)} × ${r.nights} nights`
                                    : ''}
                                </span>
                              </span>
                              <span>{fmtMoney(r.rate * r.nights)}</span>
                            </div>
                          );
                        })}
                        {visibleAddons.filter(a => Number(addonQtys[a.id] || 0) > 0).map(a => {
                          const qty = Number(addonQtys[a.id]);
                          const subtotal = a.per_booking ? a.price : a.price * qty;
                          return (
                            <div key={a.id} className="flex justify-between">
                              <span>{a.name}{!a.per_booking && ` × ${qty}`}</span>
                              <span>{fmtMoney(subtotal)}</span>
                            </div>
                          );
                        })}
                        {promoDiscount > 0 && (
                          <div className="flex justify-between text-emerald-700 font-medium">
                            <span><i className="fas fa-tag mr-1 text-xs"></i>Promo ({promoInput})</span>
                            <span>− {fmtMoney(promoDiscount)}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-amber-700 pt-0.5">
                          <span>Entrance ({form.guests} pax × ₱{entranceFeeRate})</span>
                          <span>{fmtMoney(entranceFeeTotal)}</span>
                        </div>
                      </div>
                      <div className="flex justify-between font-bold text-base border-t border-slate-300 pt-1.5 mt-1.5 text-slate-900">
                        <span>Total to Collect</span>
                        <span>{fmtMoney(previewTotal + entranceFeeTotal)}</span>
                      </div>
                    </div>
                  );
                })()}

                {/* Cash tender — required when payMethod === 'Cash'.
                    Staff types what the guest handed over, UI shows
                    change due below. Mirrors the Billing Collect modal's
                    Amount Tendered field. Nothing new reaches the
                    backend — paid_amount stays at grand total. */}
                {form.payMethod === 'Cash' && (() => {
                  const grandTotal = previewTotal + entranceFeeTotal;
                  const typed = form.cashTender.trim() === '' ? null : Number(form.cashTender);
                  const hasTender = typed != null && Number.isFinite(typed) && typed > 0;
                  const shortByCash = hasTender && typed < grandTotal - 0.009;
                  const overByCash  = hasTender && typed > grandTotal + 0.009;
                  const changeDue   = overByCash ? typed - grandTotal : 0;
                  return (
                    <div className="mt-4 p-3 border border-emerald-200 bg-emerald-50 rounded-lg">
                      <label htmlFor="walkin-cash-tender" className="block text-xs font-semibold text-emerald-900 mb-1">
                        <i className="fas fa-money-bill-wave mr-1"></i>
                        Amount Tendered <span className="text-rose-600">*</span>
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm pointer-events-none">₱</span>
                        <input
                          id="walkin-cash-tender"
                          type="number"
                          inputMode="decimal"
                          min="1"
                          step="1"
                          value={form.cashTender}
                          onChange={(e) => setField('cashTender', e.target.value)}
                          placeholder={`${Math.round(grandTotal)} — or more (change will show below)`}
                          className={`w-full pl-7 pr-3 py-2 border rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
                            shortByCash ? 'border-rose-400' : 'border-slate-300'
                          }`}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setField('cashTender', String(Math.round(grandTotal)))}
                        className="mt-1 text-[11px] text-emerald-700 hover:text-emerald-800 underline underline-offset-2"
                      >
                        Exact: {fmtMoney(grandTotal)}
                      </button>
                      {overByCash && (
                        <div className="mt-2 rounded border border-emerald-300 bg-white px-3 py-2 flex items-center justify-between">
                          <span className="text-xs text-emerald-800 font-semibold flex items-center gap-1">
                            <i className="fas fa-coins text-emerald-600"></i>
                            Change due
                          </span>
                          <span className="text-base font-bold text-emerald-700 tabular-nums">
                            {fmtMoney(changeDue)}
                          </span>
                        </div>
                      )}
                      {shortByCash && (
                        <p className="mt-1 text-xs text-rose-700">
                          <i className="fas fa-exclamation-circle mr-1"></i>
                          Tender is less than the total. Guest still owes {fmtMoney(grandTotal - typed)}.
                        </p>
                      )}
                    </div>
                  );
                })()}

                {/* GCash evidence — ref number + confirmation screenshot.
                    Placed AFTER the total so staff show the guest the
                    exact grand total (including amenities + entrance),
                    guest pays that amount through GCash, then staff
                    captures the proof. Mirrors the Billing Manual Ref
                    contract — both required to submit. Scan-QR mode
                    uses the inline QR panel below instead. */}
                {form.payMethod === 'GCash' && form.gcashMode === 'ref' && (
                  <div className="mt-4 p-3 border border-sky-200 bg-sky-50 rounded-lg space-y-3">
                    <p className="text-xs font-semibold text-sky-900">
                      <i className="fas fa-mobile-alt mr-1"></i>
                      GCash Payment Evidence
                    </p>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        GCash Reference Number <span className="text-rose-600">*</span>
                      </label>
                      <input
                        type="text"
                        value={form.gcashRef}
                        onChange={(e) => setField('gcashRef', e.target.value)}
                        placeholder="e.g. 1234 567 8901"
                        className="w-full px-3 py-2 border border-slate-300 rounded text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
                        autoComplete="off"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Confirmation Screenshot <span className="text-rose-600">*</span>
                      </label>
                      {!form.gcashRefImageUrl ? (
                        <label className={`flex flex-col items-center justify-center w-full py-5 border-2 border-dashed rounded cursor-pointer transition-colors ${
                          gcashImageUploading
                            ? 'border-sky-300 bg-white cursor-wait'
                            : 'border-slate-300 bg-white hover:border-sky-400'
                        }`}>
                          <input
                            type="file"
                            accept="image/*"
                            capture="environment"
                            disabled={gcashImageUploading}
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              e.target.value = '';
                              if (!file) return;
                              if (!file.type.startsWith('image/')) {
                                setFormError('Please select an image file.');
                                return;
                              }
                              if (file.size > 5 * 1024 * 1024) {
                                setFormError('Image must be 5 MB or smaller.');
                                return;
                              }
                              setFormError('');
                              setGcashImageUploading(true);
                              try {
                                const url = await uploadFile(file, 'gcash-refs');
                                setField('gcashRefImageUrl', url);
                              } catch (err) {
                                setFormError(err?.response?.data?.message || 'Failed to upload image.');
                              } finally {
                                setGcashImageUploading(false);
                              }
                            }}
                            className="hidden"
                          />
                          <i className={`fas ${gcashImageUploading ? 'fa-spinner fa-spin text-sky-500' : 'fa-camera text-slate-400'} text-xl mb-1`}></i>
                          <span className="text-xs font-medium text-slate-600">
                            {gcashImageUploading ? 'Uploading…' : 'Tap to take a photo or choose an image'}
                          </span>
                          <span className="text-[10px] text-slate-500 mt-0.5">
                            Guest's GCash confirmation — max 5 MB
                          </span>
                        </label>
                      ) : (
                        <div className="rounded border border-slate-200 bg-white p-2">
                          <img
                            src={form.gcashRefImageUrl}
                            alt="GCash confirmation screenshot"
                            className="w-full max-h-48 object-contain rounded"
                          />
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <span className="text-[11px] text-emerald-700">
                              <i className="fas fa-check-circle mr-1"></i>
                              Uploaded
                            </span>
                            <button
                              type="button"
                              onClick={() => setField('gcashRefImageUrl', '')}
                              className="text-[11px] text-rose-600 hover:text-rose-700 font-medium"
                            >
                              <i className="fas fa-trash-alt mr-1"></i>
                              Remove
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* GCash Scan-QR panel. Shown only after staff clicks
                    "Generate GCash QR" in the footer — before that, the
                    body renders normally (amenities, total). Once an
                    invoice exists the Pending booking is already in the
                    DB; staff cannot edit the form, only wait or cancel. */}
                {form.payMethod === 'GCash' && form.gcashMode === 'qr' && qrInvoice && (
                  <div className={`mt-4 p-4 rounded border ${
                    qrInvoice.state === 'paid' ? 'border-emerald-300 bg-emerald-50'
                    : qrInvoice.state === 'failed' ? 'border-rose-300 bg-rose-50'
                    : 'border-sky-300 bg-sky-50'
                  }`}>
                    {qrInvoice.state === 'pending' && (
                      <>
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-sm font-semibold text-sky-900">
                            <i className="fas fa-spinner fa-spin mr-1"></i>
                            Waiting for guest to pay…
                          </span>
                          <span className="text-xs text-sky-700 font-mono">{fmtMoney(qrInvoice.amount)}</span>
                        </div>
                        <div className="flex justify-center mb-3">
                          <div className="bg-white p-3 rounded shadow-inner border border-sky-100">
                            <QRCodeSVG
                              value={qrInvoice.invoice_url}
                              size={200}
                              level="M"
                              includeMargin={false}
                            />
                          </div>
                        </div>
                        <p className="text-[11px] text-center text-sky-800 mb-3 leading-snug">
                          Guest scans this QR with their phone camera, then taps the link to open the Xendit page and pays via GCash.
                        </p>
                        <p className="text-[10px] text-sky-700/80 font-mono break-all text-center">
                          Invoice: {qrInvoice.invoice_id}
                        </p>
                      </>
                    )}
                    {qrInvoice.state === 'paid' && (
                      <div className="text-center py-2">
                        <i className="fas fa-check-circle text-emerald-600 text-2xl"></i>
                        <p className="mt-1 text-sm font-semibold text-emerald-900">Payment received.</p>
                        <p className="text-xs text-emerald-700">Closing…</p>
                      </div>
                    )}
                    {qrInvoice.state === 'failed' && (
                      <div className="text-center py-2">
                        <i className="fas fa-exclamation-triangle text-rose-600 text-xl"></i>
                        <p className="mt-1 text-sm font-semibold text-rose-900">Invoice expired or failed.</p>
                        <p className="text-xs text-rose-700">The Pending booking will auto-cancel at 30 minutes. Close this dialog and try again.</p>
                      </div>
                    )}
                  </div>
                )}

                </>)}
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-slate-100 flex gap-3 shrink-0 bg-white">
              {wiStep === 1 ? (<>
                <button type="button" onClick={() => { setFormOpen(false); setFormError(''); closeWizard(); }}
                  className="flex-1 inline-flex items-center justify-center min-h-11 px-4 py-2.5 border border-slate-300 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
                  Cancel
                </button>
                <button type="button"
                  onClick={() => {
                    setFormError('');
                    if (!form.fullName.trim()) { setFormError('Guest name is required.'); return; }
                    if (!form.roomId) { setFormError('Please select a room.'); return; }
                    setWiStep(2);
                    document.getElementById('walkin-scroll')?.scrollTo(0, 0);
                  }}
                  className="flex-1 inline-flex items-center justify-center min-h-11 px-4 py-2.5 bg-brand hover:bg-brand-dark text-white rounded-xl text-sm font-bold gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
                  Next <i className="fas fa-arrow-right" aria-hidden="true"></i>
                </button>
              </>) : (<>
                {qrInvoice ? (
                  /* QR invoice in flight — Pending rows exist in the DB
                     and are being watched by the poller. Only safe exit
                     is Close; cancel-expired will sweep the Pending row
                     at 30 min if the guest never pays. */
                  <button type="button"
                    onClick={() => { setFormOpen(false); setFormError(''); closeWizard(); setQrInvoice(null); }}
                    className="flex-1 inline-flex items-center justify-center min-h-11 px-4 py-2.5 border border-slate-300 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
                    Close
                  </button>
                ) : (<>
                  <button type="button" onClick={() => { setWiStep(1); document.getElementById('walkin-scroll')?.scrollTo(0, 0); }}
                    className="flex-1 inline-flex items-center justify-center min-h-11 px-4 py-2.5 border border-slate-300 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
                    <i className="fas fa-arrow-left mr-1" aria-hidden="true"></i>Back
                  </button>
                  {form.payMethod === 'GCash' && form.gcashMode === 'qr' ? (
                    <button type="button"
                      onClick={handleGenerateQr}
                      disabled={submitting || qrGenerating}
                      className="flex-1 inline-flex items-center justify-center min-h-11 px-4 py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-xl text-sm font-bold gap-2 disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2">
                      <i className={`fas ${qrGenerating ? 'fa-spinner fa-spin' : 'fa-qrcode'}`} aria-hidden="true"></i>
                      {qrGenerating ? 'Generating…' : 'Generate GCash QR'}
                    </button>
                  ) : (
                    <button type="button"
                      onClick={handleCreate}
                      disabled={submitting}
                      className="flex-1 inline-flex items-center justify-center min-h-11 px-4 py-2.5 bg-brand hover:bg-brand-dark text-white rounded-xl text-sm font-bold gap-2 disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
                      <i className="fas fa-eye" aria-hidden="true"></i>
                      {submitting ? 'Creating...' : 'Review & Confirm'}
                    </button>
                  )}
                </>)}
              </>)}
            </div>
          </div>
        </Modal>
      )}

      {/* ── Main ── */}
      {/* This route exists purely to host the walk-in wizard modal. The
          wizard opens on mount and every close path navigates to
          /frontdesk/bookings, so this background is only briefly visible
          while the form loads. The Today's Bookings table lives in the
          consolidated Bookings page now. */}
      <main className="p-6">
        {error && (
          <div role="alert" aria-live="assertive" className="mb-4 p-3 bg-rose-50 text-rose-700 rounded text-sm">
            <i className="fas fa-exclamation-circle mr-2" aria-hidden="true"></i>{error}
          </div>
        )}
        <div className="bg-white rounded-lg shadow p-10 text-center text-slate-600">
          <i className="fas fa-spinner fa-spin text-2xl mb-3 block"></i>
          <p className="text-sm">Opening walk-in wizard…</p>
          <button
            onClick={() => navigate(bookingsPath)}
            className="mt-4 text-xs text-sky-600 hover:text-sky-800 font-medium"
          >
            ← Back to Bookings
          </button>
        </div>
      </main>
    </Shell>
  );
}
