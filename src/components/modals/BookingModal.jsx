import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Modal from "./Modal.jsx";
import { createBooking, createGuestBooking, cancelBooking, cancelGuestBooking, createGuestPaymentLink, getGuestPaymentStatus, guestConfirmPayment } from "../../lib/bookingApi.js";
import { createPaymentLink, getPaymentStatus } from "../../lib/paymentApi.js";
import { api } from "../../lib/api.js";
import { validatePromo } from "../../lib/adminApi.js";
import { fmtDateTime } from "../../lib/format";
import { savePendingPayment, clearPendingPayment } from "../../hooks/usePendingPayment.js";
import { useAuth } from "../../context/AuthContext.jsx";
import VerifyEmailModal from "./VerifyEmailModal.jsx";
import useFocusTrap from "../../hooks/useFocusTrap.js";

// Payment countdown length (seconds). Bumped from 5 to 15 min because
// GCash users often need to unlock their phone, open the app, and
// authorize — 5 min is tight. The backend's stale-Pending sweep uses
// the same 15-min threshold so a browser close / crash closes the
// booking at the same visible SLA.
const PAYMENT_WINDOW_SECONDS = 15 * 60;

// Threshold at which the "Keep booking" warning banner appears.
const PAYMENT_WARNING_SECONDS = 60;

// Fallback defaults — replaced immediately by /api/pricing on mount
const DEFAULTS = {
  day_rate:            1500,
  overnight_rate:      1500,
  rate_24hr:           2000,
  // Per-slot online reservation fee percentages. Owner controls each
  // from /owner/settings. 100 = pay in full at booking. These defaults
  // are only used before /api/pricing responds. reservation_fee_pct is
  // kept as a last-resort fallback for the per-slot resolver below.
  reservation_fee_pct:       20,
  reservation_fee_pct_day:   20,
  reservation_fee_pct_night: 20,
  reservation_fee_pct_24hr:  20,
  // Gate entrance fees per pax. Pre-check-in these are ESTIMATES — the
  // actual amount is computed at check-in from the real arrival count.
  // Shown in the review + confirmation steps so guests aren't surprised
  // by a fee at the gate after they've already paid the room online.
  entrance_fee_day:   50,
  entrance_fee_night: 80,
  entrance_fee_24hr:  100,
};

// Resolve the per-slot reservation fee percentage. Falls back to the
// legacy single key, then to DEFAULTS.reservation_fee_pct, so stale
// backends and offline initial renders still produce a usable number.
function reservationPctForSlot(pricing, bookingType) {
  const legacy = Number(pricing?.reservation_fee_pct ?? DEFAULTS.reservation_fee_pct);
  switch (bookingType) {
    case 'day':
      return Number(pricing?.reservation_fee_pct_day ?? legacy);
    case 'night':
      return Number(pricing?.reservation_fee_pct_night ?? legacy);
    case '24hr':
    case '24hr-pm':
      return Number(pricing?.reservation_fee_pct_24hr ?? legacy);
    default:
      return legacy;
  }
}

function formatPHP(n) {
  return `₱${Number(n || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function BookingModal({ open, onClose, selectedRoom, rooms, onBooked, guestMode = false, resumeBooking = null }) {
  // Resume mode: user clicked a Pending booking from MyBookings / Dashboard.
  // We skip the room/date/guests picker entirely — the booking exists
  // server-side with those values locked in. Only two actions are valid:
  // Continue Payment (reopen PayMongo via /resume-payment) or Cancel
  // Booking (so the user can start a fresh one — we enforce one-Pending-
  // at-a-time on the backend).
  const isResume = !!resumeBooking;
  // Unverified authenticated guests are blocked server-side
  // (BookingController::store returns 403) — surface that requirement
  // in the UI so they can verify inline instead of hitting a cryptic
  // error at the payment step. Guest-mode bookings skip this check
  // since they collect email on the form itself.
  const { user } = useAuth();
  const needsVerification = !guestMode && user && !user.email_verified_at;
  const [verifyOpen, setVerifyOpen] = useState(false);
  const modalRef        = useRef(null);
  const bookingResultRef = useRef(null); // stores API response after booking created
  const [bookingType, setBookingType] = useState("day"); // "day" | "night" | "24hr"
  // Multi-night count — only meaningful when bookingType === "24hr". Day
  // and Night stay single-slot. Resets to 1 whenever type changes away
  // from 24hr so a stale 3-night selection can't leak into a Day
  // booking.
  const [nights, setNights]           = useState(1);
  // Multi-room mode gate: a checkbox above the room picker flips
  // this on. When off the UI stays pure single-room (no "+ Add"
  // button, no sibling cards). Turning it off also wipes any
  // additional rooms the user had staged so they can't be submitted
  // by accident.
  const [multiRoomMode, setMultiRoomMode] = useState(false);
  // Additional rooms attached to the same reservation. Each entry
  // can carry its own bookingType and nights (mixed types supported).
  // Omitted fields inherit the top-level primary values. Optional
  // per-room addons aren't pickable from the guest modal for siblings
  // — fixture package addons still auto-attach server-side per-room.
  const [additionalRooms, setAdditionalRooms] = useState([]); // {tempId, roomId, bookingType?, nights?}
  const [visitDate, setVisitDate]     = useState("");
  // Room selection is tracked by its primary-key id so duplicate names
  // can't collapse availability / metadata / submitted-id onto the wrong
  // record. The optional `selectedRoom` prop is a display name from
  // the Resort / Rooms pages — resolved to an id when the modal opens.
  const initialRoomId = selectedRoom
    ? (rooms.find(r => r.name === selectedRoom)?.id ?? "")
    : "";
  const [roomId,   setRoomId]   = useState(initialRoomId);
  // Unavailable rooms in the picker collapse to a "Show N booked"
  // toggle so the visible card list stays focused on what the guest
  // can actually pick. Click reveals them as dimmed-disabled cards.
  const [showUnavailable, setShowUnavailable] = useState(false);
  // Picker category filter — defaults to 'all' showing every kind of
  // room. Chips above the picker let the guest narrow to just rooms,
  // cottages, or pavilions. Empty categories don't render a chip.
  const [pickerFilter, setPickerFilter] = useState('all');
  // Hover preview — when the user mouses over a room card with an
  // uploaded image, a fixed-positioned popover shows the image at a
  // larger size next to the card. Fixed positioning escapes the
  // picker's overflow-y-auto clipping. Skipped for touch devices
  // (mouseenter doesn't reliably fire there) and for cards without
  // an image (icon fallback alone isn't worth a popover).
  const [previewRoom, setPreviewRoom] = useState(null);
  const [previewPos,  setPreviewPos]  = useState(null);
  // Mobile equivalent of the desktop hover preview — tap the eye
  // icon on a card to open a fullscreen image lightbox. Touch
  // devices don't fire mouseenter reliably, so the explicit-tap
  // pattern gives mobile users their own way to see the room.
  const [lightboxRoom, setLightboxRoom] = useState(null);
  // Focus trap + initial focus + return focus for the photo lightbox.
  // Can't reuse Modal here because it's nested inside the parent
  // BookingModal, which already owns the window-level Escape listener;
  // we add our own capture-phase Escape below that calls
  // stopPropagation so only the photo closes — not the booking flow.
  const lightboxDialogRef = useFocusTrap(!!lightboxRoom);
  useEffect(() => {
    if (!lightboxRoom) return;
    function onKey(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setLightboxRoom(null);
      }
    }
    // Capture phase + stopPropagation: runs before Modal.jsx's own
    // window listener and prevents the parent BookingModal from also
    // seeing the Escape event.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [lightboxRoom]);
  const [specialRequests, setSpecialRequests] = useState("");
  const [submitting,   setSubmitting]   = useState(false);
  const [error,        setError]        = useState("");
  const [confirmOpen,  setConfirmOpen]  = useState(false);
  const confirmDialogRef = useFocusTrap(confirmOpen);

  // Guest mode — contact info collected when booking without an account
  const [guestName,  setGuestName]  = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  // Payment popup state: { bookingId, checkoutUrl, popup } while waiting for payment
  // popup can be null when the user closed the window (we keep bookingId/checkoutUrl for reopen)
  const [paymentPopup, setPaymentPopup] = useState(null);
  // Countdown in seconds — starts at 5 min, auto-cancels at 0
  const [timeLeft, setTimeLeft] = useState(null);

  // Pricing fetched from /api/pricing (admin-configurable)
  const [pricing,    setPricing]    = useState(DEFAULTS);
  const [rawPricing, setRawPricing] = useState(null);

  // Payment option: "reservation" = pay reservation fee only | "full" = pay full amount now
  const [paymentOption, setPaymentOption] = useState("reservation");

  // Promo code
  const [promoInput,   setPromoInput]   = useState("");
  const [promoResult,  setPromoResult]  = useState(null);  // { discount_amount, message, type, value }
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoError,   setPromoError]   = useState("");

  // Room availability: { [roomName]: true|false } — null means not yet checked
  const [availability,     setAvailability]     = useState(null);
  const [availChecking,    setAvailChecking]    = useState(false);

  // Wizard step (1 = Details, 2 = Payment)
  const [step, setStep] = useState(1);
  const [showRequests, setShowRequests] = useState(false);

  // Fetch admin-configured pricing on mount (reservation_fee_pct, entrance fees, etc.)
  useEffect(() => {
    api.get("/api/pricing")
      .then(r => setRawPricing(r.data?.data ?? null))
      .catch(() => {});
  }, []);

  // Derive rates from the selected room in the rooms prop (already fetched by parent)
  useEffect(() => {
    const r = rooms.find(rm => String(rm.id) === String(roomId));
    if (!r) return;
    setPricing({
      day_rate:            Number(r.day_rate        ?? DEFAULTS.day_rate),
      overnight_rate:      Number(r.overnight_rate  ?? DEFAULTS.overnight_rate),
      rate_24hr:           Number(r.rate_24hr       ?? DEFAULTS.rate_24hr),
      reservation_fee_pct:       Number(rawPricing?.reservation_fee_pct       ?? DEFAULTS.reservation_fee_pct),
      reservation_fee_pct_day:   Number(rawPricing?.reservation_fee_pct_day   ?? rawPricing?.reservation_fee_pct ?? DEFAULTS.reservation_fee_pct_day),
      reservation_fee_pct_night: Number(rawPricing?.reservation_fee_pct_night ?? rawPricing?.reservation_fee_pct ?? DEFAULTS.reservation_fee_pct_night),
      reservation_fee_pct_24hr:  Number(rawPricing?.reservation_fee_pct_24hr  ?? rawPricing?.reservation_fee_pct ?? DEFAULTS.reservation_fee_pct_24hr),
      entrance_fee_day:    Number(rawPricing?.entrance_fee_day   ?? DEFAULTS.entrance_fee_day),
      entrance_fee_night:  Number(rawPricing?.entrance_fee_night ?? DEFAULTS.entrance_fee_night),
      entrance_fee_24hr:   Number(rawPricing?.entrance_fee_24hr  ?? DEFAULTS.entrance_fee_24hr),
    });
  }, [rooms, roomId, rawPricing]);

  // Check room availability whenever date, time, or booking type changes.
  // Debounced so keyboard-scrolling the hour dropdown doesn't fire one
  // request per value; settles on the final pick after ~300ms.
  useEffect(() => {
    if (!visitDate) { setAvailability(null); return; }
    const params = new URLSearchParams({
      date:         visitDate,
      booking_type: bookingType,
    });

    setAvailChecking(true);
    const timer = setTimeout(() => {
      api.get(`/api/availability?${params}`)
        .then(r => {
          // Key by id, not name — duplicate names otherwise collapse to the
          // last entry in the list and mask one of the rooms as unavailable.
          const map = {};
          (r.data?.data ?? []).forEach(rm => { map[String(rm.id)] = rm.available; });
          setAvailability(map);
        })
        .catch(() => setAvailability(null)) // on error, show no indicators
        .finally(() => setAvailChecking(false));
    }, 300);

    return () => { clearTimeout(timer); };
  }, [visitDate, bookingType]);

  // Scroll modal to top whenever an error appears so it's always visible
  useEffect(() => {
    if (error && modalRef.current) {
      const scrollParent = modalRef.current.closest(".overflow-y-auto");
      if (scrollParent) scrollParent.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [error]);

  // Listen for postMessage from PaymentReturn page running inside the popup.
  // This fires immediately when PayMongo redirects back to /payment/success
  // or /payment/failed.
  useEffect(() => {
    if (!paymentPopup?.bookingId) return;

    function handleMessage(event) {
      // Only accept messages from our own origin
      if (event.origin !== window.location.origin) return;

      const isPaid      = event.data?.type === "paymongo_paid";
      const isCancelled = event.data?.type === "paymongo_cancelled";
      if (!isPaid && !isCancelled) return;

      try { paymentPopup?.popup?.close(); } catch { /* ignore */ }
      const bId = paymentPopup?.bookingId;
      setPaymentPopup(prev => prev ? { ...prev, popup: null } : null);
      if (!bId) return;

      const confirmFn = guestMode
        ? () => guestConfirmPayment(bId, paymentOption === "full")
        : () => api.post(`/api/bookings/${bId}/confirm-payment`, { fully_paid: paymentOption === "full" });

      // Abandons the pending-payment state and shows a cancelled error.
      // Also cancels the booking server-side so the room isn't held.
      const markCancelled = () => {
        setPaymentPopup(null);
        setTimeLeft(null);
        clearPendingPayment();
        (guestMode ? cancelGuestBooking(bId) : cancelBooking(bId)).catch(() => {});
        setError(isCancelled
          ? "Payment was cancelled. Your booking was not confirmed."
          : "Payment could not be completed. Your booking was not confirmed.");
      };

      // Only treat confirm-payment's response as success when it explicitly
      // says the booking is Confirmed. "Already processed" on a Cancelled
      // booking used to look like success here — now the backend returns
      // 410 for those, and we also sanity-check the body.
      const treatAsConfirmed = (resp) => {
        const data = resp?.data ?? {};
        return data.status === "Confirmed" || data.paid === true;
      };

      const success = () => {
        setPaymentPopup(null);
        setTimeLeft(null);
        clearPendingPayment();
        onBooked?.(bookingResultRef.current);
        onClose();
      };

      if (isCancelled) {
        // Cancel-url arrived. Do ONE verification in case the guest paid
        // then hit back/close (rare but possible on mobile), then give up.
        // No retry loop — a failed/cancelled session shouldn't hold the
        // user in limbo for 20 s pretending to verify.
        confirmFn()
          .then(resp => { if (treatAsConfirmed(resp)) success(); else markCancelled(); })
          .catch(() => markCancelled());
        return;
      }

      // Success-url arrived. GCash may take a few seconds to settle, so
      // retry on 402 (still pending). 410 means the session is dead —
      // don't retry, show failure immediately.
      let attempts = 0;
      const tryConfirm = () => {
        confirmFn()
          .then(resp => { if (treatAsConfirmed(resp)) success(); else markCancelled(); })
          .catch(err => {
            const status = err?.response?.status;
            if (status === 410) { markCancelled(); return; }
            attempts++;
            if ((status === 402 || status === 503) && attempts < 10) {
              setTimeout(tryConfirm, 2000);
              return;
            }
            // Other errors: the parallel status poller is still running,
            // so it may still resolve. The timer will expire otherwise.
          });
      };
      tryConfirm();
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [paymentPopup, onBooked, onClose, guestMode, paymentOption]);

  // Poll payment status — runs while waiting for payment.
  // The status endpoint checks PayMongo server-side and confirms when paid.
  useEffect(() => {
    if (!paymentPopup?.bookingId) return;
    const { bookingId, popup } = paymentPopup;

    const interval = setInterval(async () => {
      // Popup just closed by user — keep state but show "Reopen" button
      if (popup && popup.closed) {
        setPaymentPopup(prev => prev ? { ...prev, popup: null } : null);
        return;
      }
      // Check if payment went through (e.g. webhook already confirmed it)
      try {
        const status = guestMode
          ? await getGuestPaymentStatus(bookingId)
          : await getPaymentStatus(bookingId);
        if (status.paid) {
          clearInterval(interval);
          try { popup?.close(); } catch { /* ignore */ }
          setPaymentPopup(null);
          setTimeLeft(null);
          clearPendingPayment();
          onBooked?.(bookingResultRef.current);
          onClose();
          return;
        }
        // Backend tells us the PayMongo session is dead (last payment
        // attempt failed or user cancelled). Stop pretending to verify
        // and surface the failure immediately so the modal doesn't hang
        // on "Verifying payment…" for 15 min.
        if (status.state === "failed") {
          clearInterval(interval);
          try { popup?.close(); } catch { /* ignore */ }
          setPaymentPopup(null);
          setTimeLeft(null);
          clearPendingPayment();
          (guestMode ? cancelGuestBooking(bookingId) : cancelBooking(bookingId)).catch(() => {});
          setError("Payment was not completed. Your booking was not confirmed.");
        }
      } catch {
        // ignore transient errors; keep polling
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [paymentPopup, onBooked, onClose, guestMode]);

  // Countdown timer — decrements every second while payment is pending
  useEffect(() => {
    if (timeLeft === null) return;
    if (timeLeft <= 0) {
      // Time expired — cancel the booking automatically
      const bId = paymentPopup?.bookingId;
      try { paymentPopup?.popup?.close(); } catch { /* ignore */ }
      setPaymentPopup(null);
      setTimeLeft(null);
      clearPendingPayment();
      if (bId) {
        (guestMode ? cancelGuestBooking(bId) : cancelBooking(bId)).catch(() => {});
      }
      setError(`Payment timed out (${Math.floor(PAYMENT_WINDOW_SECONDS / 60)} minutes). Your booking was automatically cancelled.`);
      return;
    }
    const id = setTimeout(() => setTimeLeft(t => t - 1), 1000);
    return () => clearTimeout(id);
  }, [timeLeft, paymentPopup]);

  // Escape key to close (only when no confirmation overlay or payment popup)
  useEffect(() => {
    if (!open) return;
    function handleKey(e) {
      if (e.key === "Escape" && !confirmOpen && !paymentPopup) onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, confirmOpen, paymentPopup, onClose]);

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      setRoomId(selectedRoom ? (rooms.find(r => r.name === selectedRoom)?.id ?? "") : "");
      setVisitDate("");
      setError("");
      setBookingType("day");
      setNights(1);
      setMultiRoomMode(false);
      setAdditionalRooms([]);
      setAvailability(null);
      setPaymentPopup(null);
      setTimeLeft(null);
      setPromoInput("");
      setPromoResult(null);
      setPromoError("");
      setPaymentOption("reservation");
      setConfirmOpen(false);
      setGuestName("");
      setGuestEmail("");
      setGuestPhone("");
      setPricing(DEFAULTS);
      setStep(1);
      setShowRequests(false);
    }
  }, [open, selectedRoom]);

  // ── Selected room metadata ─────────────────────────────────────────────────
  const selectedRoomObj = useMemo(
    () => rooms.find(r => String(r.id) === String(roomId)) ?? null,
    [rooms, roomId]
  );
  const roomName = selectedRoomObj?.name ?? "";

  // null = unrestricted; array = only those types allowed for this room
  const allowedTypes = selectedRoomObj?.allowed_booking_types ?? null;
  const typeAllowed  = (type) => !allowedTypes || allowedTypes.includes(type);

  // Time-slot guard: disable booking types whose window already passed today
  const isToday     = visitDate === todayStr();
  const currentHour = new Date().getHours();
  const dayPassed    = isToday && currentHour >= 17;   // Day (7AM–5PM) window closed
  // 24hr covers 7 AM today → 6 AM tomorrow. Booking it at 4 PM or later
  // gives the guest only ~14 hours for a "24-hour" product, so we lock
  // it out from 4 PM onward and nudge them to a future date (or Night).
  const twentyFourPassed = isToday && currentHour >= 16;

  // Auto-switch away from Day or 24hr if its window passed
  useEffect(() => {
    if (dayPassed && bookingType === "day") setBookingType("night");
  }, [dayPassed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (twentyFourPassed && bookingType === "24hr") setBookingType("night");
  }, [twentyFourPassed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-switch to first allowed type when room with restrictions is selected
  useEffect(() => {
    if (!allowedTypes) return;
    if (!allowedTypes.includes(bookingType)) setBookingType(allowedTypes[0]);
  }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset nights to 1 whenever the booking type changes away from 24hr.
  // Multi-night only applies to 24hr; a leftover 3 from a prior 24hr
  // pick must not survive a switch to Day/Night.
  useEffect(() => {
    if (bookingType !== "24hr" && nights !== 1) setNights(1);
  }, [bookingType]); // eslint-disable-line react-hooks/exhaustive-deps

  // On primary room swap, drop any sibling that duplicates the new
  // primary (reservation disallows duplicates). Booking type is
  // independent per row now (mixed types), so we DO NOT clear
  // siblings when the primary type changes.
  useEffect(() => {
    if (additionalRooms.some(ar => String(ar.roomId) === String(roomId))) {
      setAdditionalRooms(list => list.filter(ar => String(ar.roomId) !== String(roomId)));
    }
  }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Multi-room checkbox toggled off → drop any siblings so they
  // don't silently end up in the submit payload.
  useEffect(() => {
    if (!multiRoomMode && additionalRooms.length > 0) {
      setAdditionalRooms([]);
    }
  }, [multiRoomMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived pricing — room rate only, 20% reservation fee ─────────────────
  const is24hr   = bookingType === "24hr";
  const baseRate = bookingType === "night"
    ? pricing.overnight_rate
    : is24hr
      ? pricing.rate_24hr
      : pricing.day_rate;
  const discount           = promoResult?.discount_amount ?? 0;
  // Package add-ons attached to the selected room (videoke on Blue
  // Pavilion, etc.). The backend auto-creates BookingAmenity rows for
  // each on booking creation and increments booking.total by the sum
  // — so the guest's visible total must include this up front.
  // `selectedRoomObj` is already memoized further up in the file.
  const packageAddons   = (selectedRoomObj?.attached_addons ?? [])
    .filter(a => a.relation === 'package');
  const packageTotal    = packageAddons.reduce(
    (sum, a) => sum + (Number(a.price) || 0) * (Number(a.qty) || 1), 0
  );
  const packageNames    = packageAddons.map(a => a.name);

  // Optional add-ons attached to this room (Patrice videoke at a
  // paid rate, for example). Guest picks qty per addon; the backend
  // looks up per-room price so we never need to trust a price field
  // from the client.
  const optionalAddons = useMemo(
    () => (selectedRoomObj?.attached_addons ?? []).filter(a => a.relation === 'optional'),
    [selectedRoomObj]
  );
  // Map of addon name → chosen qty. Resets when the room changes so
  // a half-selected videoke on Patrice doesn't leak into a Blue
  // Pavilion booking the guest switches to mid-flow.
  const [optionalQtys, setOptionalQtys] = useState({});
  useEffect(() => { setOptionalQtys({}); }, [roomId]);
  const optionalTotal = useMemo(
    () => optionalAddons.reduce((sum, a) => {
      const qty = Number(optionalQtys[a.name] || 0);
      return sum + qty * (Number(a.price) || 0);
    }, 0),
    [optionalAddons, optionalQtys]
  );
  // Name list for the summary line ("Optional: Videoke × 1").
  const optionalSummary = useMemo(
    () => optionalAddons
      .map(a => ({ name: a.name, qty: Number(optionalQtys[a.name] || 0) }))
      .filter(x => x.qty > 0),
    [optionalAddons, optionalQtys]
  );

  // Multi-night 24hr: the per-night rate rolls up to roomSubtotal
  // before promo and package/optional add-ons fold in. room_rate on
  // the booking row stays per-night; `nights` is a separate column.
  const effectiveNights    = is24hr ? Math.max(1, Math.min(14, Number(nights) || 1)) : 1;

  // Per-room rate helper. Honors mixed-type bookings: an additional
  // room can override `type` and the rate column switches to match.
  function rateForRoom(roomRecord, type) {
    if (!roomRecord) return 0;
    const t = type ?? bookingType;
    if (t === 'night') return Number(roomRecord.overnight_rate ?? 0);
    if (t === '24hr' || t === '24hr-pm') return Number(roomRecord.rate_24hr ?? 0);
    return Number(roomRecord.day_rate ?? 0);
  }
  // Each additional room resolves its effective type + nights. All
  // siblings share the PRIMARY's slot by resort rule — a group
  // visit has one check-in window, same across rooms. (Earlier
  // builds supported mixed types per sibling; that got dropped in
  // favor of a simpler UX after user feedback.)
  const additionalRoomRows = additionalRooms.map(ar => {
    const room = rooms.find(r => String(r.id) === String(ar.roomId));
    const type = bookingType;
    const n    = type === '24hr' ? effectiveNights : 1;
    return { ar, room, type, nights: n, rate: rateForRoom(room, type) };
  });
  const additionalRoomObjs = additionalRoomRows.map(r => r.room).filter(Boolean);
  const additionalRoomsSubtotal = additionalRoomRows
    .filter(r => r.room)
    .reduce((sum, r) => sum + r.rate * r.nights, 0);
  const primaryRoomSubtotal = baseRate * effectiveNights;
  const roomSubtotal        = primaryRoomSubtotal + additionalRoomsSubtotal;
  // Discounted room-only subtotal — matches backend `reservation_fee`
  // math which is `pct × (roomSubtotal - discount)`, excluding package.
  const discountedRoom     = Math.max(roomSubtotal - discount, 0);
  // What the guest actually pays for room + bundle: discounted room
  // + package add-ons + picked optional add-ons.
  const discountedTotal    = discountedRoom + packageTotal + optionalTotal;
  // Per-slot reservation fee percentage — owner sets each slot from
  // /owner/settings. Full-payment-at-booking is triggered by EITHER:
  //   (a) the slot pct being set to 100, or
  //   (b) a promo code being applied (anti-double-dip).
  // Backend applies the same rule when creating the booking (re-syncs
  // reservation_fee to booking.total after addons attach).
  const slotPct            = reservationPctForSlot(pricing, bookingType);
  const hasPromo           = Boolean(promoResult?.valid);
  const requiresFullPay    = slotPct >= 100 || hasPromo;
  const reservationFee     = requiresFullPay
    ? discountedTotal
    : Math.round(discountedRoom * (slotPct / 100));
  // When full payment is required, force paymentOption to "full" so the
  // backend's confirm-payment payload reports fully_paid=true. Picker UI
  // hides the Reserve/Full toggle in this case.
  const effectivePaymentOption = requiresFullPay ? "full" : paymentOption;
  const amountDue          = effectivePaymentOption === "full" ? discountedTotal : reservationFee;
  const balanceDue         = discountedTotal - amountDue;
  // Legacy alias — many downstream UI blocks still reference isSlotFullPay.
  // Keep for render compatibility during the transition.
  const isSlotFullPay      = requiresFullPay;
  // Gate entrance fee — BookingModal doesn't collect guest count, so the
  // estimate assumes 1 pax (backend default). Real amount is computed at
  // check-in from actual arrivals. Surfacing it here prevents the
  // "fully paid online → surprise charge at gate" complaint.
  const entranceRate       = bookingType === "night"
    ? pricing.entrance_fee_night
    : is24hr
      ? pricing.entrance_fee_24hr
      : pricing.entrance_fee_day;
  const estimatedEntrance  = entranceRate; // 1 pax; scales at check-in
  const grandEstimate      = discountedTotal + estimatedEntrance;
  const resortBalance      = balanceDue + estimatedEntrance;

  async function applyPromo() {
    const code = promoInput.trim();
    if (!code) return;
    setPromoLoading(true);
    setPromoError("");
    setPromoResult(null);
    try {
      // Backend computes the discount against the full stay subtotal
      // (per-night × nights), so multi-night 24hr stays discount their
      // whole stay. Match that here so the UI preview and the server
      // charge agree.
      const res = await validatePromo(code, roomSubtotal);
      const d   = res.data;
      if (d.valid) {
        setPromoResult(d);
      } else {
        setPromoError(d.message || "Invalid promo code.");
      }
    } catch {
      setPromoError("Could not validate promo code. Please try again.");
    } finally {
      setPromoLoading(false);
    }
  }

  function removePromo() {
    setPromoResult(null);
    setPromoInput("");
    setPromoError("");
  }

  // ── Step 1: validate → show confirmation ──────────────────────────────────
  function submit() {
    setError("");
    // Guest mode: require contact info
    if (guestMode) {
      if (!guestName.trim())  { setError("Please enter your full name."); return; }
      if (!guestEmail.trim()) { setError("Please enter your email address."); return; }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(guestEmail.trim())) { setError("Please enter a valid email address."); return; }
    }
    if (!visitDate) { setError("Please select a visit date."); return; }
    if (!roomId)    { setError("Please select a room/cottage."); return; }
    if (availability !== null && availability[String(roomId)] !== true) {
      setError("Selected room is not available for the chosen date. Please select another."); return;
    }
    if (!selectedRoomObj?.id) { setError("Could not determine room. Please try again."); return; }

    // Validate additional rooms: each must have a selection, no
    // duplicates, available for the date, and accepting its own
    // effective type (mixed types honored).
    const seen = new Set([String(roomId)]);
    for (const [idx, row] of additionalRoomRows.entries()) {
      const ar = row.ar;
      if (!ar.roomId) {
        setError(`Additional room #${idx + 1} needs a selection — remove it or pick a room.`); return;
      }
      if (seen.has(String(ar.roomId))) {
        setError(`Additional room #${idx + 1} duplicates a room already in this reservation.`); return;
      }
      seen.add(String(ar.roomId));
      const adRoom = row.room;
      if (!adRoom) {
        setError(`Additional room #${idx + 1} no longer exists — remove it.`); return;
      }
      if (adRoom.allowed_booking_types && !adRoom.allowed_booking_types.includes(row.type)) {
        const tLbl = row.type === 'night' ? 'Night' : row.type === '24hr' ? '24 Hours' : 'Day';
        setError(`${adRoom.name} does not support the ${tLbl} booking type.`); return;
      }
      if (availability !== null && availability[String(adRoom.id)] !== true) {
        setError(`${adRoom.name} is not available for the selected date.`); return;
      }
    }

    setConfirmOpen(true);
  }

  // ── Step 2: confirmed → call API ───────────────────────────────────────────
  // Resume flow: reopen PayMongo for an existing Pending booking.
  // Skips the createBooking step entirely — the row already exists.
  // Reuses the same paymentPopup state machine (polling + timer +
  // postMessage listener) as a fresh booking so the confirmed-payment
  // path is identical.
  async function handleResume() {
    if (!resumeBooking) return;
    setError("");
    setSubmitting(true);
    try {
      // Authed user → /api/bookings/{id}/resume-payment
      // Guest token → /api/guest-resume-payment (not used from MyBookings
      // since those are authed, but supported for completeness)
      const res = resumeBooking.guestToken
        ? await api.post('/api/guest-resume-payment', {
            guest_token: resumeBooking.guestToken,
            pay_full:    Boolean(resumeBooking.payFull),
          })
        : await api.post(`/api/bookings/${resumeBooking.bookingId}/resume-payment`, {
            pay_full: Boolean(resumeBooking.payFull),
          });

      const checkoutUrl = res?.data?.checkout_url;
      if (!checkoutUrl) throw new Error('No checkout URL returned');

      // Prep bookingResultRef so the onBooked callback fires with the
      // same shape a fresh booking would emit.
      bookingResultRef.current = {
        roomType:      resumeBooking.roomName ?? '',
        checkIn:       resumeBooking.checkIn ?? '',
        checkOut:      resumeBooking.checkOut ?? '',
        guests:        resumeBooking.guests ?? 1,
        paymentMethod: 'Online',
        totals: {
          reservationFee: resumeBooking.reservationFee ?? 0,
          balanceDue:     Math.max(0, (resumeBooking.total ?? 0) - (resumeBooking.reservationFee ?? 0)),
        },
        bookingData: resumeBooking,
        guestToken:  resumeBooking.guestToken ?? null,
      };

      const pw = 600, ph = 700;
      const pl = Math.round(window.screen.width  / 2 - pw / 2);
      const pt = Math.round(window.screen.height / 2 - ph / 2);
      const popup = window.open(
        checkoutUrl,
        "paymongo_checkout",
        `width=${pw},height=${ph},left=${pl},top=${pt},resizable=yes,scrollbars=yes`
      );

      savePendingPayment({
        bookingId:  resumeBooking.bookingId,
        resId:      resumeBooking.resId ?? null,
        roomName:   resumeBooking.roomName ?? null,
        guestToken: resumeBooking.guestToken ?? null,
        payFull:    Boolean(resumeBooking.payFull),
        expiresAt:  new Date(Date.now() + PAYMENT_WINDOW_SECONDS * 1000).toISOString(),
      });

      const bId = resumeBooking.guestToken ?? resumeBooking.bookingId;
      if (!popup || popup.closed) {
        const tab = window.open(checkoutUrl, '_blank');
        setPaymentPopup({ bookingId: bId, checkoutUrl, popup: tab });
        setTimeLeft(PAYMENT_WINDOW_SECONDS);
        return;
      }
      setPaymentPopup({ bookingId: bId, checkoutUrl, popup });
      setTimeLeft(PAYMENT_WINDOW_SECONDS);
    } catch (err) {
      const msg = err?.response?.data?.message
        ?? 'Could not reopen payment. The booking may have expired.';
      setError(msg);
      // 422 = no longer Pending on server — drop local reminder
      if (err?.response?.status === 422) clearPendingPayment();
    } finally {
      setSubmitting(false);
    }
  }

  // Cancel the Pending booking from resume mode so the user can start
  // a fresh one. Uses the same cancelBooking endpoint the normal cancel
  // button uses — backend marks status=Cancelled + releases the room
  // hold. After success we close the modal; the parent's polling will
  // show the Cancelled row.
  async function handleCancelResume() {
    if (!resumeBooking) return;
    setError("");
    setSubmitting(true);
    try {
      if (resumeBooking.guestToken) {
        await cancelGuestBooking(resumeBooking.guestToken);
      } else {
        await cancelBooking(resumeBooking.bookingId);
      }
      clearPendingPayment();
      onBooked?.(null); // signal parent to refresh
      onClose();
    } catch (err) {
      setError(err?.response?.data?.message ?? 'Could not cancel booking. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirm() {
    setError("");
    const room = selectedRoomObj;
    if (!room?.id) { setError("Could not determine room. Please try again."); return; }

    setConfirmOpen(false);
    setSubmitting(true);
    try {
      const bookingPayload = {
        check_in:         visitDate,
        payment_method:   "Online",
        special_requests: specialRequests || null,
        booking_type:     bookingType,
        // Multi-night, 24hr only. Backend rejects nights > 1 for
        // Day/Night with a 422; effectiveNights already clamps to 1
        // for non-24hr types here, so this is belt-and-braces.
        nights:           effectiveNights,
        promo_code:       promoResult ? promoInput.trim().toUpperCase() : null,
        discount:         discount,
      };

      // Optional add-ons picked from the PRIMARY room's attached_addons.
      // Backend resolves price per-room so we only send {name, qty}
      // — never trust a client-supplied price.
      const pickedAmenities = Object.entries(optionalQtys)
        .filter(([, qty]) => Number(qty) > 0)
        .map(([name, qty]) => ({ name, qty: Number(qty) }));

      // Multi-room: all siblings share the primary's slot (top-level
      // booking_type + nights), so we don't send per-row overrides.
      // Backend treats missing per-row type/nights as "inherit from
      // top-level" — degenerating exactly to single-type-per-group.
      if (additionalRooms.length > 0) {
        bookingPayload.rooms = [
          { room_id: room.id, amenities: pickedAmenities },
          ...additionalRoomRows.map(r => ({
            room_id: Number(r.ar.roomId),
            amenities: [],
          })),
        ];
      } else {
        bookingPayload.room_id = room.id;
        if (pickedAmenities.length > 0) bookingPayload.amenities = pickedAmenities;
      }

      // Guest mode: add contact info + use public endpoint
      if (guestMode) {
        bookingPayload.guest_name  = guestName.trim();
        bookingPayload.guest_email = guestEmail.trim();
        bookingPayload.guest_phone = guestPhone.trim() || null;
      }

      const result = guestMode
        ? await createGuestBooking(bookingPayload)
        : await createBooking(bookingPayload);

      const raw = result.data?.data ?? result.data;
      const fmtDT = fmtDateTime;
      bookingResultRef.current = {
        roomType:      raw.room?.name ?? '',
        checkIn:       fmtDT(raw.check_in),
        checkOut:      fmtDT(raw.check_out),
        guests:        raw.guests,
        paymentMethod: raw.payment_method,
        totals: {
          reservationFee: raw.reservation_fee ?? 0,
          balanceDue:     Math.max(0, (raw.total ?? 0) - (raw.reservation_fee ?? 0)),
        },
        bookingData: raw,
        guestToken: result.guest_token ?? null,
      };
      // For guest bookings, use the guest_token (UUID) for all subsequent API calls
      // to prevent ID enumeration. For logged-in users, use the numeric booking ID.
      const guestToken = result.guest_token;
      const bookingId = guestMode ? guestToken : raw.id;
      const { checkout_url } = guestMode
        ? await createGuestPaymentLink(guestToken, effectivePaymentOption === "full")
        : await createPaymentLink(raw.id, effectivePaymentOption === "full");

      // Open PayMongo in a small centered popup so the main page stays visible
      const pw = 600, ph = 700;
      const pl = Math.round(window.screen.width  / 2 - pw / 2);
      const pt = Math.round(window.screen.height / 2 - ph / 2);
      const popup = window.open(
        checkout_url,
        "paymongo_checkout",
        `width=${pw},height=${ph},left=${pl},top=${pt},resizable=yes,scrollbars=yes`
      );

      // Persist a pending-payment context so the floating banner can
      // offer a resume path if the guest closes this modal / tab while
      // the booking is still Pending. Cleared on successful payment,
      // explicit cancel, and timer expiry further down.
      savePendingPayment({
        bookingId:  raw.id,
        resId:      raw.res_id ?? null,
        roomName:   raw.room?.name ?? null,
        guestToken: guestMode ? guestToken : null,
        payFull:    effectivePaymentOption === 'full',
        // 15-min TTL matches the backend's stale-Pending sweep window.
        expiresAt:  new Date(Date.now() + PAYMENT_WINDOW_SECONDS * 1000).toISOString(),
      });

      if (!popup || popup.closed) {
        // Popup blocked — open in a new tab instead of redirecting away
        const tab = window.open(checkout_url, '_blank');
        setPaymentPopup({ bookingId, checkoutUrl: checkout_url, popup: tab });
        setTimeLeft(PAYMENT_WINDOW_SECONDS);
        return;
      }

      setPaymentPopup({ bookingId, checkoutUrl: checkout_url, popup });
      setTimeLeft(PAYMENT_WINDOW_SECONDS);
    } catch (err) {
      const msg =
        err?.response?.data?.message ||
        Object.values(err?.response?.data?.errors || {})?.[0]?.[0] ||
        "Booking failed. Please try again.";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-2xl" labelledBy="booking-modal-title">
      {/* Hover/focus preview popover. Portaled directly to document.body
          so position:fixed is anchored to the viewport. Without the
          portal, the Modal dialog wrapper has animate-hero-fade-in
          (which uses transform: translateY) and any ancestor with a
          transform becomes the containing block for fixed-positioned
          descendants — so the popover would render relative to the
          dialog instead of the viewport and get clipped by the modal
          bounds. Hidden on small screens — mouse-only by design. */}
      {previewRoom && previewPos && previewRoom.image && createPortal(
        <div
          style={{ position: 'fixed', top: previewPos.top, left: previewPos.left, transform: 'translateY(-50%)' }}
          className="hidden md:block z-[10000] pointer-events-none"
          aria-hidden="true"
        >
          <div className="bg-white rounded-xl shadow-2xl ring-1 ring-slate-200 p-2 w-[320px]">
            <img
              src={previewRoom.image}
              alt=""
              className="w-full h-56 object-cover rounded-lg"
            />
            <div className="px-1 pt-2 pb-1">
              <p className="text-sm font-semibold text-slate-900 truncate">{previewRoom.name}</p>
              <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
                <i className="fas fa-users text-[10px]"></i>
                {previewRoom.capacity_label || `Up to ${previewRoom.capacity} guests`}
              </p>
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* Fullscreen image lightbox — opened by the mobile eye icon.
          Portaled to body so it sits above the modal. Tap backdrop or
          close button to dismiss. */}
      {lightboxRoom && lightboxRoom.image && createPortal(
        <div
          ref={lightboxDialogRef}
          className="fixed inset-0 z-[10001] bg-black/85 flex items-center justify-center p-4"
          onClick={() => setLightboxRoom(null)}
          role="dialog"
          aria-modal="true"
          aria-label={`Photo of ${lightboxRoom.name}`}
          tabIndex={-1}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setLightboxRoom(null); }}
            aria-label="Close photo preview"
            className="absolute top-4 right-4 w-11 h-11 inline-flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 text-white text-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <i className="fas fa-times" aria-hidden="true"></i>
          </button>
          <div className="max-w-3xl w-full" onClick={(e) => e.stopPropagation()}>
            <img
              src={lightboxRoom.image}
              alt={lightboxRoom.name}
              className="w-full max-h-[75vh] object-contain rounded-lg shadow-2xl"
            />
            <div className="mt-3 text-white">
              <p className="text-lg font-bold">{lightboxRoom.name}</p>
              <p className="text-sm text-white/80 mt-0.5 flex items-center gap-1.5">
                <i className="fas fa-users text-xs"></i>
                {lightboxRoom.capacity_label || `Up to ${lightboxRoom.capacity} guests`}
              </p>
            </div>
          </div>
        </div>,
        document.body
      )}
      <div className="p-6" ref={modalRef}>
        <div className="flex items-center justify-between mb-5">
          <h3 id="booking-modal-title" className="text-2xl font-bold text-gray-900">
            {isResume ? 'Continue Pending Booking' : 'Book Your Visit at Aplaya'}
            {!isResume && guestMode && <span className="ml-2 text-sm font-normal text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">Guest</span>}
          </h3>
          <button onClick={onClose} type="button" className="w-11 h-11 inline-flex items-center justify-center rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" aria-label="Close booking modal"><i className="fas fa-times" aria-hidden="true"></i></button>
        </div>

        {error && (
          <div role="alert" aria-live="assertive" className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 flex items-start gap-2">
            <i className="fas fa-exclamation-circle mt-0.5 shrink-0" aria-hidden="true"></i>
            <span>{error}</span>
          </div>
        )}

        <div>
          {/* Guest info — shown only in guest (no-account) mode, always visible outside steps */}
          {!isResume && guestMode && (
            <div className="mb-5">
              <div className="mb-4 rounded-lg bg-amber-50 border border-amber-300 px-4 py-3 flex items-start gap-3">
                <i className="fas fa-user-secret text-amber-500 mt-0.5 shrink-0"></i>
                <div>
                  <p className="text-sm font-semibold text-amber-800">Booking as Guest</p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    We need your contact details to send your booking confirmation. You won't be able to manage this booking online.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label htmlFor="bm-guest-name" className="block text-sm font-medium text-gray-700 mb-1">
                    Full Name <span className="text-red-600" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="bm-guest-name"
                    type="text"
                    value={guestName}
                    onChange={e => setGuestName(e.target.value)}
                    placeholder="Your full name"
                    autoComplete="name"
                    className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label htmlFor="bm-guest-email" className="block text-sm font-medium text-gray-700 mb-1">
                    Email address <span className="text-gray-600 font-normal">— for your receipt and booking link</span>{' '}
                    <span className="text-red-600" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="bm-guest-email"
                    type="email"
                    value={guestEmail}
                    onChange={e => setGuestEmail(e.target.value)}
                    placeholder="your@email.com"
                    autoComplete="email"
                    className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label htmlFor="bm-guest-phone" className="block text-sm font-medium text-gray-700 mb-1">
                    Phone Number <span className="text-gray-600 font-normal text-xs">(optional)</span>
                  </label>
                  <input
                    id="bm-guest-phone"
                    type="tel"
                    value={guestPhone}
                    onChange={e => setGuestPhone(e.target.value)}
                    placeholder="+63 9xx xxx xxxx"
                    autoComplete="tel"
                    className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <hr className="mt-5 border-gray-200" />
            </div>
          )}

          {/* Step indicator — hidden in resume mode (no steps to show) */}
          {!isResume && <div className="flex items-center gap-2 mb-5">
            {[{ num: 1, label: 'Details' }, { num: 2, label: 'Payment' }].map((s, i) => (
              <React.Fragment key={s.num}>
                {i > 0 && <div className={`flex-1 h-px ${step >= s.num ? 'bg-blue-400' : 'bg-gray-200'}`} />}
                <button type="button" onClick={() => s.num < step && setStep(s.num)}
                  disabled={s.num >= step}
                  className={`flex items-center gap-1.5 text-sm font-medium rounded ${
                    step === s.num ? 'text-blue-700' : step > s.num ? 'text-blue-700 cursor-pointer' : 'text-gray-600'
                  }`}>
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                    step >= s.num ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'
                  }`}>{step > s.num ? '\u2713' : s.num}</span>
                  {s.label}
                </button>
              </React.Fragment>
            ))}
          </div>}

          {/* ═══ Step 1 — Details ═══ */}
          {!isResume && step === 1 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Visit date */}
              <div className="md:col-span-2">
                <label htmlFor="bm-visit-date" className="block text-sm font-medium text-gray-700 mb-1">
                  Date <span className="text-red-600" aria-hidden="true">*</span>
                </label>
                <input
                  id="bm-visit-date"
                  type="date"
                  min={todayStr()}
                  value={visitDate}
                  onChange={(e) => setVisitDate(e.target.value)}
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Booking type — compact pills. Locked out until a date is
                  picked, so the user can't pick "Day" before noon on a
                  date that's already past 3pm, or select a 24-hour slot
                  without knowing which day we're checking availability
                  against. dayPassed + typeAllowed both depend on the
                  selected date + room, so their semantics aren't
                  meaningful until visitDate is set. */}
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-2" id="booking-type-label">
                  Booking Type <span className="text-red-600" aria-hidden="true">*</span>
                  {!visitDate && (
                    <span className="ml-2 text-xs text-gray-600 font-normal">Pick a date first</span>
                  )}
                </label>
                <div className="flex gap-2" role="group" aria-labelledby="booking-type-label">
                  {[
                    { key: "day",   icon: "fa-sun",   label: "Day",    time: "7AM\u20135PM",  disabled: !visitDate || dayPassed || !typeAllowed("day") },
                    { key: "night", icon: "fa-moon",  label: "Night",   time: "6PM\u20136AM",  disabled: !visitDate || !typeAllowed("night") },
                    { key: "24hr",  icon: "fa-clock", label: "24 Hrs", time: "7AM–next 6AM", disabled: !visitDate || twentyFourPassed || !typeAllowed("24hr") },
                  ].map(opt => {
                    const active = bookingType === opt.key;
                    return (
                      <button key={opt.key} type="button" disabled={opt.disabled}
                        aria-pressed={active}
                        aria-label={`${opt.label} (${opt.time})`}
                        onClick={() => { if (!opt.disabled) { setBookingType(opt.key); setPromoResult(null); setPromoInput(""); } }}
                        className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 md:py-2 border-2 rounded-lg text-sm font-medium transition-colors ${
                          active ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'
                        } ${opt.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
                        <span className="flex items-center gap-1.5 leading-none">
                          <i className={`fas ${opt.icon} text-xs`} aria-hidden="true"></i>
                          {opt.label}
                        </span>
                        <span className={`text-[10px] tabular-nums leading-none ${active ? 'text-blue-700' : 'text-gray-600'}`}>
                          {opt.time}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {/* Rate shown below — pill-styled so the live rate is
                    legible at a glance instead of disappearing as gray
                    fine print. Accent color tracks the active booking
                    type so the eye lands here right after the click. */}
                {roomId && (
                  <div className="mt-2 flex justify-center">
                    <span className={`inline-flex items-baseline gap-1.5 px-3 py-1 rounded-full text-base font-bold tabular-nums shadow-sm ${
                      bookingType === "night"
                        ? "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200"
                        : is24hr
                          ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                          : "bg-sky-50 text-sky-700 ring-1 ring-sky-200"
                    }`}>
                      {formatPHP(baseRate)}
                      <span className="text-[11px] font-medium opacity-70">
                        / {bookingType === "night" ? "night" : is24hr ? "24 hrs" : "day"}
                      </span>
                    </span>
                  </div>
                )}

                {/* 24hr bookings have a fixed window (7 AM – next day 6 AM).
                    Guests arrive any time during the day; no start-hour
                    picker needed. Multi-night (`nights`) stretches the
                    window to 6 AM on the (N+1)th day. */}
                {is24hr && (
                  <div className="mt-3 space-y-2">
                    <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs text-blue-900">
                      <i className="fas fa-circle-info mr-1.5" aria-hidden="true"></i>
                      You can arrive any time on the selected date. Check-out is 6:00 AM
                      {nights > 1 ? ` on day ${nights + 1}.` : " the next morning."}
                    </div>

                    {/* Multi-night stepper. Caps at 14 nights (backend validator
                        matches). Buttons change state only; display is tabular
                        so layout doesn't shift as the number grows. */}
                    <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                      <div className="text-xs text-amber-900">
                        <i className="fas fa-moon mr-1.5" aria-hidden="true"></i>
                        Number of nights
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setNights(n => Math.max(1, Number(n) - 1))}
                          disabled={nights <= 1}
                          className="w-7 h-7 rounded-lg bg-white border border-amber-300 text-amber-700 text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-amber-100"
                          aria-label="Decrease nights"
                        >
                          <i className="fas fa-minus" aria-hidden="true"></i>
                        </button>
                        <span className="min-w-[2.5rem] text-center text-sm font-bold text-amber-900 tabular-nums">
                          {nights} {nights === 1 ? "night" : "nights"}
                        </span>
                        <button
                          type="button"
                          onClick={() => setNights(n => Math.min(14, Number(n) + 1))}
                          disabled={nights >= 14}
                          className="w-7 h-7 rounded-lg bg-white border border-amber-300 text-amber-700 text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-amber-100"
                          aria-label="Increase nights"
                        >
                          <i className="fas fa-plus" aria-hidden="true"></i>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Multi-room gate. Lives above the room picker so the
                  guest sees the toggle before picking anything —
                  turning it on changes the picker into multi-select
                  mode and the first card they tap becomes the primary.
                  Checkbox is visible as soon as the modal is open; it
                  doesn't depend on a room being picked. */}
              <div className="md:col-span-2">
                <label className="flex items-center gap-2 cursor-pointer select-none mb-1">
                  <input
                    type="checkbox"
                    checked={multiRoomMode}
                    onChange={e => setMultiRoomMode(e.target.checked)}
                    className="w-4 h-4 text-blue-600 bg-white border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                    aria-label="Book multiple rooms"
                  />
                  <span className="text-sm text-gray-800 font-medium">
                    <i className="fas fa-layer-group mr-1 text-blue-500" aria-hidden="true"></i>
                    Book multiple rooms
                  </span>
                  <span className="text-xs text-gray-500">
                    (same reservation, one payment, one entrance fee)
                  </span>
                </label>
              </div>

              {/* Room / Cottage — locked until visitDate is chosen. The
                  availability list is filtered by the selected date, so
                  showing rooms before a date is picked would surface
                  rooms that could be unavailable for the slot the user
                  eventually chooses. */}
              <div className="md:col-span-2">
                <label id="booking-room-picker-label" className="block text-sm font-medium text-gray-700 mb-2">
                  Room / Cottage <span className="text-red-600" aria-hidden="true">*</span>
                  {!visitDate ? (
                    <span className="ml-2 text-xs text-gray-600 font-normal">Pick a date first</span>
                  ) : availChecking && (
                    <span className="ml-2 text-xs text-gray-600 font-normal">
                      <i className="fas fa-spinner fa-spin mr-1" aria-hidden="true"></i>Checking…
                    </span>
                  )}
                </label>
                {!visitDate ? (
                  <div className="rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-600">
                    <i className="fas fa-calendar-alt mr-1.5" aria-hidden="true"></i>
                    Pick a date above to see available rooms.
                  </div>
                ) : (() => {
                  // Tent rooms are walk-in only (backend rejects tent
                  // bookings from this endpoint), so filter them out of
                  // the public picker. Unavailable rooms are NOT filtered
                  // out; they render in a collapsed group at the bottom.
                  const nonTent = rooms.filter(r => r.category !== 'tent');
                  const isAvailable = r =>
                    availability === null || availability?.[String(r.id)] === true;
                  const available   = nonTent.filter(isAvailable);
                  const unavailable = nonTent.filter(r => !isAvailable(r));

                  const getCategory = r => {
                    if (r.category) return r.category;
                    const n = (r.name || "").toLowerCase();
                    if (n.includes("cottage"))  return "cottage";
                    if (n.includes("pavilion")) return "pavilion";
                    return "room";
                  };
                  const rateFor = (r) => {
                    if (bookingType === '24hr' || bookingType === '24hr-pm') return r.rate_24hr;
                    if (bookingType === 'night') return r.overnight_rate;
                    return r.day_rate;
                  };
                  const fmtRate = (v) => `₱${Number(v ?? 0).toLocaleString('en-PH')}`;
                  // Per-category visual cues. Selected card overrides
                  // with blue (matches the rest of the modal accent).
                  const CATEGORY_META = {
                    room:     { icon: "fa-bed",            label: "Rooms",     accent: "sky"     },
                    cottage:  { icon: "fa-umbrella-beach", label: "Cottages",  accent: "emerald" },
                    pavilion: { icon: "fa-archway",        label: "Pavilions", accent: "indigo"  },
                  };
                  const ACCENT_BG    = { sky: "bg-sky-100 text-sky-700", emerald: "bg-emerald-100 text-emerald-700", indigo: "bg-indigo-100 text-indigo-700" };
                  const ACCENT_PRICE = { sky: "text-sky-700", emerald: "text-emerald-700", indigo: "text-indigo-700" };

                  const groupOrder = ["room", "cottage", "pavilion"];
                  // Filter pipeline derives the visible subset from the
                  // active picker chip. 'all' = no filter; otherwise we
                  // narrow to a single category. availableFlat (used by
                  // the keyboard nav handler) MUST track the filtered
                  // list — otherwise arrow keys would move focus to a
                  // card that's currently hidden.
                  const passesFilter = (r) => pickerFilter === 'all' || getCategory(r) === pickerFilter;
                  const filteredAvailable   = available.filter(passesFilter);
                  const filteredUnavailable = unavailable.filter(passesFilter);
                  const visibleGroups = pickerFilter === 'all' ? groupOrder : [pickerFilter];
                  const availableFlat = visibleGroups.flatMap(k => filteredAvailable.filter(r => getCategory(r) === k));

                  // Compute popover position from a card's bounding
                  // rect. Defaults to the right of the card with a 12px
                  // gap; flips to the left when there isn't 320px of
                  // viewport room on the right. Vertically centers on
                  // the card but clamps so the popover stays inside
                  // the viewport (popover height ~280px, so half =
                  // 140px + 16px breathing room).
                  // Anchor the popover next to the THUMBNAIL, not the
                  // entire card. Card is full-width inside the modal, so
                  // anchoring to its right edge put the popover ~320px
                  // away from the image — visually disconnected. Now we
                  // compute the thumbnail's position from the card rect
                  // (it sits at left:p-3=12px, vertically centered, and
                  // is 64px wide on md+ where the popover is rendered)
                  // and anchor the popover just past the thumbnail's
                  // right edge so it reads as "this image, expanded".
                  // Auto-flips to the left of the thumbnail if there's
                  // not enough room on the right (rare given the modal
                  // sits centered, but covers narrow viewports).
                  const positionPreview = (e, r, disabled) => {
                    if (!r.image || disabled) return;
                    const card = e.currentTarget.getBoundingClientRect();
                    const POPOVER_W = 320;
                    const HALF_H = 140;
                    const PAD = 16;
                    const GAP = 8;
                    const CARD_PAD = 12;   // p-3 padding on the card
                    const THUMB_W = 64;    // sm:w-16 (64px) — md+ size

                    const thumbLeft  = card.left + CARD_PAD;
                    const thumbRight = thumbLeft + THUMB_W;
                    const thumbCenterY = card.top + card.height / 2;

                    const wantRight = thumbRight + GAP + POPOVER_W + PAD < window.innerWidth;
                    const left = wantRight ? thumbRight + GAP : thumbLeft - GAP - POPOVER_W;
                    const top = Math.max(HALF_H + PAD, Math.min(window.innerHeight - HALF_H - PAD, thumbCenterY));
                    setPreviewRoom(r);
                    setPreviewPos({ top, left });
                  };

                  const onSelect = (r) => {
                    if (!isAvailable(r)) return;
                    // Single-room mode: just pick. Multi-room mode:
                    // toggle. Clicking an unselected card adds it as
                    // an additional room (primary stays). Clicking a
                    // sibling card removes it. Clicking the primary
                    // moves it to a different room instead of
                    // deselecting — a reservation always needs a
                    // primary.
                    if (!multiRoomMode) {
                      setRoomId(String(r.id));
                      setPromoResult(null);
                      setPromoInput("");
                      return;
                    }
                    const id = String(r.id);
                    if (!roomId) {
                      setRoomId(id);
                      setPromoResult(null);
                      setPromoInput("");
                      return;
                    }
                    if (id === String(roomId)) {
                      // Clicking the primary card is a no-op — can't
                      // drop the primary without replacing it.
                      return;
                    }
                    const already = additionalRooms.find(ar => String(ar.roomId) === id);
                    if (already) {
                      setAdditionalRooms(list => list.filter(ar => String(ar.roomId) !== id));
                    } else {
                      setAdditionalRooms(list => [
                        ...list,
                        {
                          tempId: `room-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                          roomId: id,
                          // No per-row type/nights — all siblings inherit
                          // from the primary (resort rule: one group,
                          // one visit slot).
                        },
                      ]);
                    }
                    setPromoResult(null);
                    setPromoInput("");
                  };

                  const onKeyDown = (e) => {
                    if (!availableFlat.length) return;
                    if (!['ArrowUp','ArrowDown','Home','End'].includes(e.key)) return;
                    e.preventDefault();
                    const i = availableFlat.findIndex(r => String(r.id) === String(roomId));
                    let next = i;
                    if (e.key === 'ArrowDown')      next = i < 0 ? 0 : Math.min(availableFlat.length - 1, i + 1);
                    else if (e.key === 'ArrowUp')   next = i < 0 ? 0 : Math.max(0, i - 1);
                    else if (e.key === 'Home')      next = 0;
                    else if (e.key === 'End')       next = availableFlat.length - 1;
                    const target = availableFlat[next];
                    if (target) {
                      setRoomId(String(target.id));
                      setPromoResult(null);
                      setPromoInput("");
                      requestAnimationFrame(() => {
                        document.getElementById(`room-card-${target.id}`)?.focus();
                      });
                    }
                  };

                  const renderCard = (r, { disabled = false } = {}) => {
                    const cat = getCategory(r);
                    const meta = CATEGORY_META[cat] ?? CATEGORY_META.room;
                    const isPrimary = String(roomId) === String(r.id);
                    const isSibling = multiRoomMode
                      && additionalRooms.some(ar => String(ar.roomId) === String(r.id));
                    const selected = isPrimary || isSibling;
                    const price = rateFor(r);
                    const typeWord = bookingType === 'night' ? 'overnight' : (bookingType === '24hr' || bookingType === '24hr-pm') ? '24 hours' : 'day visit';
                    const perWord  = bookingType === 'night' ? 'night' : (bookingType === '24hr' || bookingType === '24hr-pm') ? '24 hrs' : 'day';
                    return (
                      // Wrapping div so the eye-icon "see photo" button
                      // can sit as a sibling of the card button (HTML
                      // forbids nesting buttons). The eye is mobile-only
                      // (md:hidden) — desktop already gets the hover
                      // popover. Bottom-right corner so it doesn't
                      // overlap the price.
                      <div key={r.id} className="relative">
                      <button
                        id={`room-card-${r.id}`}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-disabled={disabled || undefined}
                        aria-label={`${r.name}, ${r.capacity_label || `up to ${r.capacity} guests`}, ${disabled ? 'booked for this slot' : `${fmtRate(price)} for ${typeWord}`}`}
                        tabIndex={disabled ? -1 : (selected || (!roomId && availableFlat[0]?.id === r.id) ? 0 : -1)}
                        onClick={() => onSelect(r)}
                        onMouseEnter={(e) => positionPreview(e, r, disabled)}
                        onMouseLeave={() => { setPreviewRoom(null); setPreviewPos(null); }}
                        onFocus={(e) => positionPreview(e, r, disabled)}
                        onBlur={() => { setPreviewRoom(null); setPreviewPos(null); }}
                        disabled={disabled}
                        className={`w-full text-left flex items-center gap-3 rounded-xl border-2 p-3 transition-all ${
                          // Extra right padding on mobile reserves a
                          // 44px column for the absolutely-positioned
                          // eye icon button below — keeps the eye from
                          // sitting on top of the price text. md+ wipes
                          // the extra padding since the eye is hidden
                          // on those breakpoints.
                          !disabled && r.image ? "max-md:pr-14" : ""
                        } ${
                          disabled
                            ? "bg-gray-50 border-gray-200 opacity-60 cursor-not-allowed"
                            : selected
                              ? "bg-blue-50 border-blue-500 ring-2 ring-blue-200 shadow-sm"
                              : "bg-white border-gray-200 hover:border-gray-300 hover:shadow-sm cursor-pointer"
                        }`}
                      >
                        {/* Thumbnail. Hover/focus opens the larger
                            preview popover at the modal root via the
                            previewRoom state — see onMouseEnter
                            handler above. */}
                        <div className={`shrink-0 w-14 h-14 sm:w-16 sm:h-16 rounded-lg overflow-hidden flex items-center justify-center ${
                          r.image ? "" : ACCENT_BG[meta.accent]
                        } ${disabled ? "grayscale" : ""}`}>
                          {r.image ? (
                            <img
                              src={r.image}
                              alt=""
                              loading="lazy"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <i className={`fas ${meta.icon} text-xl`} aria-hidden="true"></i>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`font-semibold text-sm sm:text-base truncate ${disabled ? "text-gray-500" : "text-gray-900"}`}>
                            {r.name}
                            {multiRoomMode && isPrimary && (
                              <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-blue-600 text-white text-[10px] font-semibold align-middle">
                                Primary
                              </span>
                            )}
                            {multiRoomMode && isSibling && (
                              <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-semibold align-middle">
                                <i className="fas fa-check text-[9px]"></i>Added
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                            <i className="fas fa-users text-[10px]" aria-hidden="true"></i>
                            {r.capacity_label || `Up to ${r.capacity} guests`}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          {disabled ? (
                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold bg-rose-100 text-rose-700">
                              <i className="fas fa-ban text-[9px]"></i>
                              Booked
                            </span>
                          ) : (
                            <>
                              <p className={`text-base sm:text-lg font-extrabold tabular-nums leading-tight ${selected ? "text-blue-700" : ACCENT_PRICE[meta.accent]}`}>
                                {fmtRate(price)}
                              </p>
                              <p className="text-[10px] uppercase tracking-wide text-gray-600 mt-0.5">
                                /{perWord}
                              </p>
                            </>
                          )}
                        </div>
                        {selected && (
                          <i className="fas fa-check-circle text-blue-500 text-lg ml-1 shrink-0" aria-hidden="true"></i>
                        )}
                      </button>
                      {/* Mobile-only "see photo" eye button — opens a
                          fullscreen lightbox of the room image. Sits
                          outside the card <button> as a sibling because
                          HTML doesn't allow nesting buttons. Skipped
                          for cards without an image and for booked
                          (disabled) cards. */}
                      {!disabled && r.image && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setLightboxRoom(r); }}
                          aria-label={`View ${r.name} photo`}
                          className="md:hidden absolute right-1.5 bottom-1.5 z-10 w-11 h-11 inline-flex items-center justify-center rounded-full bg-white/95 ring-1 ring-slate-300 shadow-sm text-slate-700 hover:text-slate-900 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                        >
                          <i className="fas fa-eye text-sm" aria-hidden="true"></i>
                        </button>
                      )}
                      </div>
                    );
                  };
                  // Chip-count source: FULL non-tent set so the user
                  // sees the inventory size even when some are booked;
                  // the booked ones still show under the collapsed group.
                  const chipCounts = {
                    all: nonTent.length,
                    room:     nonTent.filter(r => getCategory(r) === 'room').length,
                    cottage:  nonTent.filter(r => getCategory(r) === 'cottage').length,
                    pavilion: nonTent.filter(r => getCategory(r) === 'pavilion').length,
                  };
                  const chipDefs = [
                    { key: 'all',      icon: 'fa-th-large',          label: 'All'       },
                    { key: 'room',     icon: 'fa-bed',               label: 'Rooms'     },
                    { key: 'cottage',  icon: 'fa-umbrella-beach',    label: 'Cottages'  },
                    { key: 'pavilion', icon: 'fa-archway',           label: 'Pavilions' },
                  ];
                  // Hide chips for empty categories, but always keep
                  // 'all' since it's the default reset.
                  const visibleChips = chipDefs.filter(c => c.key === 'all' || chipCounts[c.key] > 0);

                  return (
                    <>
                      {/* Filter chips. Only render when there's more than
                          one viable category — a resort with only rooms
                          doesn't need a filter. */}
                      {visibleChips.length > 2 && (
                        // role="group" + aria-pressed — these are
                        // toggle filter chips, not WAI-ARIA tabs (no
                        // tabpanel relationship, no arrow-key
                        // navigation between them, just buttons that
                        // change a filter state). The earlier
                        // tablist/tab markup misled screen readers
                        // about the interaction model.
                        <div className="flex flex-wrap gap-2 mb-3" role="group" aria-label="Filter rooms by category">
                          {visibleChips.map(c => {
                            const active = pickerFilter === c.key;
                            return (
                              <button
                                key={c.key}
                                type="button"
                                aria-pressed={active}
                                onClick={() => setPickerFilter(c.key)}
                                className={`inline-flex items-center gap-1.5 px-3.5 py-2 min-h-11 rounded-full text-xs font-semibold border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${
                                  active
                                    ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                                    : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                                }`}
                              >
                                <i className={`fas ${c.icon} text-[10px]`} aria-hidden="true"></i>
                                {c.label}
                                <span className={`text-[10px] tabular-nums ${active ? 'text-white/85' : 'text-gray-600'}`}>
                                  ({chipCounts[c.key]})
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <div
                        role="radiogroup"
                        aria-labelledby="booking-room-picker-label"
                        aria-required="true"
                        onKeyDown={onKeyDown}
                        className="space-y-4 max-h-[420px] overflow-y-auto pr-1"
                      >
                        {visibleGroups.map(catKey => {
                          const items = filteredAvailable.filter(r => getCategory(r) === catKey);
                          if (!items.length) return null;
                          const meta = CATEGORY_META[catKey];
                          return (
                            <section key={catKey}>
                              <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-700 mb-2">
                                <i className={`fas ${meta.icon} text-[11px] ${ACCENT_PRICE[meta.accent]}`} aria-hidden="true"></i>
                                {meta.label}
                                <span className="text-gray-600 font-normal normal-case tracking-normal">
                                  ({items.length})
                                </span>
                              </h4>
                              <div className="space-y-2">
                                {items.map(r => renderCard(r))}
                              </div>
                            </section>
                          );
                        })}

                        {filteredAvailable.length === 0 && (
                          <div className="rounded-xl border-2 border-dashed border-amber-200 bg-amber-50 px-4 py-6 text-center text-sm text-amber-700">
                            <i className="fas fa-exclamation-triangle mr-1.5"></i>
                            {pickerFilter === 'all'
                              ? 'All rooms are booked for this slot. Try a different date or time.'
                              : `No ${(CATEGORY_META[pickerFilter]?.label ?? 'options').toLowerCase()} available for this slot.`}
                          </div>
                        )}

                        {filteredUnavailable.length > 0 && (
                          <section>
                            <button
                              type="button"
                              onClick={() => setShowUnavailable(s => !s)}
                              aria-expanded={showUnavailable}
                              className="w-full inline-flex items-center justify-between gap-2 px-3 py-2.5 min-h-11 rounded-lg border border-gray-200 bg-gray-50 hover:bg-gray-100 transition-colors text-xs font-semibold uppercase tracking-wider text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                            >
                              <span className="flex items-center gap-2">
                                <i className="fas fa-ban text-rose-400 text-[11px]" aria-hidden="true"></i>
                                {showUnavailable ? "Hide" : "Show"} {filteredUnavailable.length} booked
                              </span>
                              <i className={`fas fa-chevron-${showUnavailable ? 'up' : 'down'} text-[10px]`} aria-hidden="true"></i>
                            </button>
                            {showUnavailable && (
                              <div className="space-y-2 mt-2">
                                {filteredUnavailable.map(r => renderCard(r, { disabled: true }))}
                              </div>
                            )}
                          </section>
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* Additional-room cards. The checkbox gate lives
                  above the room picker now; this block renders the
                  staged sibling cards below the picker once there's
                  a primary. */}
              {visitDate && roomId && multiRoomMode && (
                <div className="md:col-span-2">
                  {additionalRooms.map((ar, idx) => {
                    const row = additionalRoomRows[idx];
                    const effType = row.type;
                    const effN    = row.nights;
                    const rate    = row.rate;
                    const addedIds = new Set([
                      String(roomId),
                      ...additionalRooms.map(x => String(x.roomId)).filter((_, i) => i !== idx),
                    ]);
                    const isAvailable = r =>
                      availability === null || availability?.[String(r.id)] === true;
                    const pickable = rooms.filter(r =>
                      r.category !== 'tent'
                      && !addedIds.has(String(r.id))
                      && isAvailable(r)
                      && (!r.allowed_booking_types || r.allowed_booking_types.includes(effType))
                    );
                    const patchRoom = (patch) =>
                      setAdditionalRooms(list =>
                        list.map(x => x.tempId === ar.tempId ? { ...x, ...patch } : x)
                      );
                    const roomName = row.room?.name ?? `Additional Room #${idx + 1}`;
                    return (
                      <div key={ar.tempId} className="mt-3 rounded-xl border-2 border-blue-200 bg-blue-50/40 p-3">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-blue-900">
                            <i className="fas fa-plus-circle text-blue-600"></i>
                            {roomName}
                          </div>
                          <button type="button"
                            onClick={() =>
                              setAdditionalRooms(list => list.filter(x => x.tempId !== ar.tempId))
                            }
                            className="text-xs text-rose-600 hover:text-rose-700 font-medium px-2 py-1 rounded hover:bg-rose-50"
                            aria-label={`Remove ${roomName}`}
                          >
                            <i className="fas fa-times mr-1"></i>Remove
                          </button>
                        </div>
                        {rate > 0 && (
                          <p className="mt-1 text-xs text-blue-700">
                            Subtotal: ₱{(rate * effN).toLocaleString()}
                            {effN > 1 && (
                              <span className="text-blue-600 ml-1">
                                (₱{rate.toLocaleString()} × {effN} nights)
                              </span>
                            )}
                          </p>
                        )}
                      </div>
                    );
                  })}
                  {additionalRooms.length === 0 && (
                    <p className="mt-3 text-xs text-blue-700 text-center px-4 py-3 rounded-lg bg-blue-50 border border-dashed border-blue-200">
                      <i className="fas fa-hand-pointer mr-1" aria-hidden="true"></i>
                      Tap another room above to add it to this reservation.
                    </p>
                  )}
                </div>
              )}

              {/* Optional add-ons for this room — only renders when the
                  selected room actually has any. Backend verifies the
                  chosen names belong to this room + looks up per-room
                  price from room_addons on save. */}
              {optionalAddons.length > 0 && (
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    <i className="fas fa-sparkles mr-1.5 text-amber-500" aria-hidden="true"></i>
                    Add-ons for this room <span className="text-gray-600 font-normal text-xs">(optional)</span>
                  </label>
                  <div className="space-y-2">
                    {optionalAddons.map(a => {
                      const qty    = Number(optionalQtys[a.name] || 0);
                      const active = qty > 0;
                      const cap    = Math.max(1, Number(a.qty) || 1);
                      // per_booking addons toggle 0⇄1 like the walk-in
                      // picker does; others get a qty stepper.
                      if (a.per_booking) {
                        return (
                          <button
                            key={a.name}
                            type="button"
                            onClick={() => setOptionalQtys(q => ({ ...q, [a.name]: active ? 0 : 1 }))}
                            className={`w-full flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                              active
                                ? 'border-indigo-400 bg-indigo-50'
                                : 'border-slate-200 hover:border-slate-300 bg-white'
                            }`}
                          >
                            <i className={`fas ${a.icon || 'fa-tag'} ${active ? 'text-indigo-600' : 'text-slate-400'}`} aria-hidden="true" />
                            <span className={`text-sm font-medium ${active ? 'text-indigo-700' : 'text-slate-700'}`}>{a.name}</span>
                            <span className="ml-auto text-sm font-semibold text-slate-700">₱{Number(a.price).toLocaleString()}</span>
                            {active && <i className="fas fa-check-circle text-indigo-600" aria-hidden="true" />}
                          </button>
                        );
                      }
                      return (
                        <div key={a.name} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
                          <i className={`fas ${a.icon || 'fa-tag'} text-slate-500 w-5 text-center`} aria-hidden="true" />
                          <span className="text-sm font-medium text-slate-700 flex-1 min-w-0 truncate">{a.name}</span>
                          <span className="text-xs text-slate-500">₱{Number(a.price).toLocaleString()}/ea</span>
                          <div className="flex items-center gap-1">
                            <button type="button"
                              disabled={qty === 0}
                              aria-label={`Decrease ${a.name} quantity`}
                              onClick={() => setOptionalQtys(q => ({ ...q, [a.name]: Math.max(0, qty - 1) }))}
                              className="w-11 h-11 inline-flex items-center justify-center rounded border border-slate-200 text-slate-700 hover:bg-slate-100 text-base font-bold disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">−</button>
                            <span className="w-8 text-center text-sm font-medium tabular-nums" aria-live="polite">{qty}</span>
                            <button type="button"
                              disabled={qty >= cap}
                              aria-label={`Increase ${a.name} quantity`}
                              onClick={() => setOptionalQtys(q => ({ ...q, [a.name]: Math.min(cap, qty + 1) }))}
                              className="w-11 h-11 inline-flex items-center justify-center rounded border border-slate-200 text-slate-700 hover:bg-slate-100 text-base font-bold disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">+</button>
                          </div>
                          {qty > 0 && (
                            <span className="text-xs font-semibold text-sky-700 tabular-nums">
                              ₱{(qty * Number(a.price)).toLocaleString()}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Special requests — collapsed.
                   500-char cap matches the bookings.special_requests
                   column comfortably; counter tells the user how
                   much room they have left as they type. */}
              <div className="md:col-span-2">
                {showRequests ? (
                  <div>
                    <label htmlFor="bm-special-requests" className="block text-sm font-medium text-gray-700 mb-1">
                      Special Requests <span className="text-gray-600 font-normal text-xs">(optional)</span>
                    </label>
                    <textarea
                      id="bm-special-requests"
                      rows={2}
                      maxLength={500}
                      value={specialRequests}
                      onChange={(e) => setSpecialRequests(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Any special requests?"
                      aria-describedby="bm-special-requests-counter"
                    />
                    <p id="bm-special-requests-counter" className="mt-1 text-[11px] text-gray-600 tabular-nums text-right">
                      {specialRequests.length} / 500
                    </p>
                  </div>
                ) : (
                  <button type="button" onClick={() => setShowRequests(true)} className="inline-flex items-center gap-1.5 px-3 py-2 min-h-11 text-xs text-blue-700 hover:text-blue-800 hover:bg-blue-50 rounded-md font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                    <i className="fas fa-plus" aria-hidden="true"></i>Add special requests
                  </button>
                )}
              </div>

              {/* Next button */}
              <div className="md:col-span-2">
                <button
                  type="button"
                  onClick={() => {
                    setError("");
                    if (guestMode) {
                      if (!guestName.trim())  { setError("Please enter your full name."); return; }
                      if (!guestEmail.trim()) { setError("Please enter your email address."); return; }
                      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                      if (!emailRegex.test(guestEmail.trim())) { setError("Please enter a valid email address."); return; }
                    }
                    if (!visitDate) { setError("Please select a visit date."); return; }
                    if (!roomId)    { setError("Please select a room/cottage."); return; }
                    if (availability !== null && availability[String(roomId)] !== true) {
                      setError("Selected room is not available for the chosen date. Please select another."); return;
                    }
                    setStep(2);
                  }}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 min-h-11 px-4 rounded-md inline-flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                >
                  Next <i className="fas fa-arrow-right" aria-hidden="true"></i>
                </button>
              </div>
            </div>
          )}

          {/* ═══ Step 2 — Payment ═══ */}
          {!isResume && step === 2 && (
            <div className="space-y-4">
              {/* Promo code input */}
              <div>
                <label htmlFor="bm-promo-code" className="block text-sm font-medium text-gray-700 mb-1">
                  <i className="fas fa-tag mr-1 text-blue-500" aria-hidden="true"></i>Promo Code <span className="text-gray-600 font-normal">(optional)</span>
                </label>
                {promoResult ? (
                  <div className="flex items-center gap-2 px-3 py-2 bg-green-50 border border-green-300 rounded-md">
                    <i className="fas fa-check-circle text-green-700" aria-hidden="true"></i>
                    <span className="text-sm text-green-800 font-medium flex-1">{promoResult.message}</span>
                    <button type="button" onClick={removePromo} className="inline-flex items-center px-2.5 py-1.5 min-h-9 text-xs text-gray-700 hover:text-red-700 hover:bg-red-50 rounded font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500">Remove</button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      id="bm-promo-code"
                      type="text"
                      value={promoInput}
                      onChange={e => { setPromoInput(e.target.value.toUpperCase()); setPromoError(""); }}
                      onKeyDown={e => e.key === "Enter" && (e.preventDefault(), applyPromo())}
                      placeholder="Enter promo code"
                      className="flex-1 px-3 py-2 min-h-11 border border-gray-300 rounded-md text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                    <button
                      type="button"
                      onClick={applyPromo}
                      disabled={!promoInput.trim() || promoLoading}
                      className="px-4 py-2 min-h-11 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                    >
                      {promoLoading ? <i className="fas fa-spinner fa-spin" aria-hidden="true"></i> : "Apply"}
                    </button>
                  </div>
                )}
                {promoError && <p role="alert" className="mt-1 text-xs text-red-700"><i className="fas fa-times-circle mr-1" aria-hidden="true"></i>{promoError}</p>}
                {!promoResult && !promoError && (
                  <p className="mt-1.5 text-[11px] text-gray-500">
                    <i className="fas fa-info-circle mr-1" aria-hidden="true"></i>
                    Promos apply to the room rate only. Discounted bookings require payment in full at checkout.
                  </p>
                )}
              </div>

              {/* Payment option selector — exposed as a radiogroup
                  with two role="radio" buttons. They're a binary
                  mutually-exclusive choice, so radio semantics let
                  screen readers describe state as "selected" + give
                  arrow-key nav between options.
                  Pay-in-Full subtitle corrected: previously claimed
                  "₱0 balance · fully paid", which conflicted with
                  the entrance-fee-at-gate rule documented in the
                  later summary. New copy makes the split explicit. */}
              {/* Payment option chooser — hidden when full payment is
                  required (either the slot is set to 100% or a promo was
                  applied). Banner explains why there's no choice. */}
              {requiresFullPay ? (
                <div className="border-2 border-emerald-500 bg-emerald-50 rounded-xl p-4 flex items-start gap-3">
                  <i className="fas fa-check-circle text-emerald-600 text-xl mt-0.5" aria-hidden="true"></i>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-emerald-800 uppercase tracking-wide">
                      {hasPromo
                        ? 'Promo code applied — full payment required'
                        : `${bookingType === 'day' ? 'Day' : bookingType === 'night' ? 'Night' : '24-Hour'} bookings require full payment`}
                    </p>
                    <p className="text-sm text-emerald-700 mt-1">
                      {formatPHP(discountedTotal)} will be charged via GCash now. No room balance due at check-in — only the gate entrance fee remains.
                    </p>
                    {hasPromo && (
                      <p className="text-xs text-emerald-700/80 mt-1 italic">
                        Promos discount the room rate; discounted bookings are paid in full at checkout.
                      </p>
                    )}
                  </div>
                </div>
              ) : (
              <div>
                <p id="bm-payment-option-label" className="block text-sm font-medium text-gray-700 mb-2">
                  <i className="fas fa-wallet mr-1 text-blue-500" aria-hidden="true"></i>Payment Option
                </p>
                <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-labelledby="bm-payment-option-label">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={paymentOption === "reservation"}
                    onClick={() => setPaymentOption("reservation")}
                    className={`flex flex-col items-start p-3 min-h-11 border-2 rounded-xl transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
                      paymentOption === "reservation"
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <span className={`text-xs font-semibold uppercase tracking-wide mb-1 ${paymentOption === "reservation" ? "text-blue-700" : "text-gray-700"}`}>
                      <i className="fas fa-bookmark mr-1" aria-hidden="true"></i>Reserve Only
                    </span>
                    <span className={`text-xl font-extrabold tabular-nums leading-none ${paymentOption === "reservation" ? "text-blue-700" : "text-gray-800"}`}>
                      {formatPHP(reservationFee)}
                      <span className="text-xs font-medium opacity-70 ml-1">now</span>
                    </span>
                    <span className="text-xs text-gray-700 mt-1">
                      Pay {formatPHP(Math.max(discountedTotal - reservationFee, 0))} at check-in
                    </span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={paymentOption === "full"}
                    onClick={() => setPaymentOption("full")}
                    className={`flex flex-col items-start p-3 min-h-11 border-2 rounded-xl transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${
                      paymentOption === "full"
                        ? "border-emerald-500 bg-emerald-50"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <span className={`text-xs font-semibold uppercase tracking-wide mb-1 ${paymentOption === "full" ? "text-emerald-700" : "text-gray-700"}`}>
                      <i className="fas fa-check-circle mr-1" aria-hidden="true"></i>Pay in Full
                    </span>
                    <span className={`text-xl font-extrabold tabular-nums leading-none ${paymentOption === "full" ? "text-emerald-700" : "text-gray-800"}`}>
                      {formatPHP(discountedTotal)}
                      <span className="text-xs font-medium opacity-70 ml-1">now</span>
                    </span>
                    <span className="text-xs text-gray-700 mt-1">
                      Room paid online · entrance fee at gate
                    </span>
                  </button>
                </div>
              </div>
              )}

              {/* Payment summary */}
              <div className="bg-blue-50 p-4 rounded-md">
                <h4 className="font-medium text-gray-900 mb-2">Payment Summary</h4>
                <div className="flex justify-between mb-1 text-sm">
                  <span className="text-gray-600">
                    {additionalRooms.length > 0 ? 'Primary room' : `Room rate (${bookingType === "night" ? "Night" : is24hr ? "24 Hours" : "Day"})`}
                    {is24hr && effectiveNights > 1 && (
                      <span className="text-xs text-gray-500 ml-1">
                        · {formatPHP(baseRate)} × {effectiveNights} nights
                      </span>
                    )}:
                  </span>
                  <span className={`font-medium tabular-nums ${discount > 0 ? "line-through text-gray-500" : ""}`}>{formatPHP(primaryRoomSubtotal)}</span>
                </div>
                {additionalRoomRows.filter(r => r.room).map(r => {
                  const typeLbl = r.type === 'night' ? 'Night' : r.type === '24hr' ? '24hr' : 'Day';
                  return (
                    <div key={r.room.id} className="flex justify-between mb-1 text-sm">
                      <span className="text-gray-600">
                        + {r.room.name}
                        <span className="text-xs text-gray-500 ml-1">
                          · {typeLbl}
                          {r.type === '24hr' && r.nights > 1
                            ? ` · ${formatPHP(r.rate)} × ${r.nights} nights`
                            : ''}
                        </span>:
                      </span>
                      <span className={`font-medium tabular-nums ${discount > 0 ? "line-through text-gray-500" : ""}`}>{formatPHP(r.rate * r.nights)}</span>
                    </div>
                  );
                })}
                {discount > 0 && (
                  <>
                    <div className="flex justify-between mb-1 text-sm text-green-700 font-medium">
                      <span><i className="fas fa-tag mr-1"></i>Promo ({promoInput}):</span>
                      <span>− {formatPHP(discount)}</span>
                    </div>
                    <div className="flex justify-between mb-1 text-sm font-semibold">
                      <span className="text-gray-800">Discounted Rate:</span>
                      <span className="text-gray-900">{formatPHP(discountedRoom)}</span>
                    </div>
                  </>
                )}
                {/* Package add-ons bundled into the room — e.g. videoke
                    included with Blue Pavilion. Auto-attached on booking
                    creation server-side at these per-room prices. */}
                {packageTotal > 0 && (
                  <div className="flex justify-between mb-1 text-sm text-emerald-800 border-t border-blue-200 pt-2 mt-2">
                    <span className="flex items-center gap-1.5">
                      <i className="fas fa-box text-[11px] text-emerald-500"></i>
                      Includes: {packageNames.join(', ')}
                    </span>
                    <span className="font-medium">+ {formatPHP(packageTotal)}</span>
                  </div>
                )}
                {/* Guest-picked optional add-ons (videoke on Patrice
                    etc.). Line itemizes them with qty so the guest sees
                    exactly what they're adding. */}
                {optionalTotal > 0 && (
                  <div className="flex justify-between mb-1 text-sm text-indigo-800 border-t border-blue-200 pt-2 mt-2">
                    <span className="flex items-center gap-1.5">
                      <i className="fas fa-sparkles text-[11px] text-indigo-500"></i>
                      Add-ons: {optionalSummary.map(x => `${x.name} × ${x.qty}`).join(', ')}
                    </span>
                    <span className="font-medium">+ {formatPHP(optionalTotal)}</span>
                  </div>
                )}
                {/* Entrance fee — first-class line, not fine print.
                    Displayed before the payment-schedule math so the
                    grand total estimate accurately reflects EVERYTHING
                    the guest will pay across the three collection
                    points (online / counter / gate). */}
                <div className="flex justify-between mb-1 text-sm text-amber-800 border-t border-blue-200 pt-2 mt-2">
                  <span className="flex items-center gap-1.5">
                    <i className="fas fa-ticket-alt text-[11px]"></i>
                    Entrance fee (₱{entranceRate}/pax · paid at gate):
                  </span>
                  <span>{formatPHP(estimatedEntrance)}<span className="text-[10px] text-amber-600 ml-1">est.</span></span>
                </div>
                <div className="flex justify-between items-baseline mt-2 pt-2 border-t-2 border-blue-300">
                  <span className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Estimated Grand Total</span>
                  <span className="text-2xl font-extrabold tabular-nums text-blue-800">{formatPHP(grandEstimate)}</span>
                </div>
                <p className="mt-1 text-[11px] text-gray-600">
                  Entrance fee scales with the actual number of guests at check-in.
                </p>

                {/* Payment schedule — breaks the cost across the three
                    collection points so guests know exactly what gets
                    charged where. Previously the entrance fee only
                    appeared as a single-line fine-print note. */}
                <div className="border-t border-blue-200 pt-2 mt-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1.5">Payment Schedule</p>
                  <div className="flex justify-between items-baseline">
                    <span className="text-sm text-gray-700 font-medium">
                      {isSlotFullPay
                        ? "Pay Online Now (full amount)"
                        : paymentOption === "full"
                          ? "Pay Online Now (full room)"
                          : `Pay Online Now (${slotPct}% reservation)`}
                    </span>
                    <span className="text-lg font-extrabold tabular-nums text-blue-700">{formatPHP(amountDue)}</span>
                  </div>
                  {balanceDue > 0 && (
                    <div className="flex justify-between text-sm mt-1">
                      <span className="text-gray-600">Room balance at resort counter</span>
                      <span className="font-medium text-gray-800">{formatPHP(balanceDue)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm mt-1">
                    <span className="text-amber-700">Entrance fee at gate</span>
                    <span className="font-medium text-amber-700">{formatPHP(estimatedEntrance)}</span>
                  </div>
                  <div className="flex justify-between text-sm mt-2 pt-2 border-t border-blue-100 font-semibold">
                    <span className="text-gray-800">Total to pay at resort</span>
                    <span className="text-gray-900">{formatPHP(resortBalance)}</span>
                  </div>
                </div>
              </div>

              {/* Cancellation policy (smaller) — wording swaps to reflect
                  whether this slot requires full payment at booking. For
                  100% slots, there's no "reservation fee" to isolate —
                  the full amount is forfeited on cancel/no-show. */}
              <div className="bg-yellow-50 border-l-4 border-yellow-400 px-3 py-2">
                <p className="text-xs text-yellow-800">
                  <span className="font-medium">Cancellation Policy:</span>{" "}
                  {isSlotFullPay
                    ? <>Cancellations or no-shows will result in the forfeiture of the full payment ({formatPHP(reservationFee)}).</>
                    : <>Cancellations or no-shows will result in the forfeiture of the {slotPct}% reservation fee ({formatPHP(reservationFee)}).</>}
                </p>
              </div>

              {/* PayMongo note */}
              <div className="flex items-start gap-2 text-sm text-gray-600 bg-gray-50 rounded-md px-3 py-2">
                <i className="fas fa-lock text-blue-500 mt-0.5 shrink-0"></i>
                <span>
                  A secure <span className="font-medium">PayMongo</span> checkout window will open for you to pay{" "}
                  <span className="font-medium">{formatPHP(amountDue)}</span> via{" "}
                  <span className="font-medium">GCash</span>.
                  This page will stay open in the background.
                </span>
              </div>

              {/* Unverified-email gate — shown in place of the Review
                  button when the authenticated user hasn't verified.
                  Clicking "Verify Now" opens the OTP modal inline so
                  they can finish without leaving this flow. */}
              {!paymentPopup && needsVerification && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <i className="fas fa-exclamation-triangle text-amber-600 mt-0.5"></i>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-amber-900">Verify your email before booking</p>
                      <p className="text-xs text-amber-800 mt-1">
                        We need to confirm you own <strong className="break-all">{user?.email}</strong> before accepting a reservation. Takes 30 seconds.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="flex-1 border border-amber-300 bg-white text-amber-900 hover:bg-amber-100 font-medium py-2.5 min-h-11 px-4 rounded-md text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    >
                      <i className="fas fa-arrow-left mr-2" aria-hidden="true"></i>Back
                    </button>
                    <button
                      type="button"
                      onClick={() => setVerifyOpen(true)}
                      className="flex-[2] bg-amber-600 hover:bg-amber-700 text-white font-medium py-2.5 min-h-11 px-4 rounded-md text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
                    >
                      <i className="fas fa-envelope-open-text mr-2" aria-hidden="true"></i>Verify Now
                    </button>
                  </div>
                </div>
              )}

              {/* Back + Review Booking buttons */}
              {!paymentPopup && !needsVerification && (
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="flex-1 border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium py-3 min-h-11 px-4 rounded-md inline-flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <i className="fas fa-arrow-left" aria-hidden="true"></i> Back
                  </button>
                  <button
                    type="button"
                    onClick={submit}
                    disabled={submitting}
                    className="flex-[2] bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-medium py-3 min-h-11 px-4 rounded-md inline-flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                  >
                    {submitting
                      ? <><i className="fas fa-spinner fa-spin" aria-hidden="true"></i> Opening checkout window...</>
                      : <><i className="fas fa-eye" aria-hidden="true"></i> Review Booking</>}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Resume-mode UI — streamlined review for an already-created
              Pending booking. Shown when the modal was opened from a
              "Continue Payment" action. Hidden once paymentPopup is set
              (the existing payment-in-progress UI below takes over). */}
          {isResume && !paymentPopup && (
            <div className="space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
                <span className="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
                  <i className="fas fa-hourglass-half text-amber-700 text-sm" aria-hidden="true" />
                </span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-amber-900">Pending Booking</p>
                  <p className="text-xs text-amber-800 mt-0.5">
                    Complete payment to confirm this booking, or cancel it to start a new one.
                    You can only have one pending booking at a time.
                  </p>
                </div>
              </div>

              <div className="bg-slate-50 rounded-xl p-4 space-y-2.5 text-sm">
                {resumeBooking.resId && (
                  <div className="flex justify-between gap-4">
                    <span className="text-slate-500">Booking ID</span>
                    <span className="font-medium text-slate-800">{resumeBooking.resId}</span>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <span className="text-slate-500">Room</span>
                  <span className="font-medium text-slate-800">{resumeBooking.roomName ?? '—'}</span>
                </div>
                {resumeBooking.bookingTypeLabel && (
                  <div className="flex justify-between gap-4">
                    <span className="text-slate-500">Type</span>
                    <span className="font-medium text-slate-800">{resumeBooking.bookingTypeLabel}</span>
                  </div>
                )}
                {resumeBooking.checkIn && (
                  <div className="flex justify-between gap-4">
                    <span className="text-slate-500">Check-in</span>
                    <span className="font-medium text-slate-800 text-right">{resumeBooking.checkIn}</span>
                  </div>
                )}
                {resumeBooking.checkOut && (
                  <div className="flex justify-between gap-4">
                    <span className="text-slate-500">Check-out</span>
                    <span className="font-medium text-slate-800 text-right">{resumeBooking.checkOut}</span>
                  </div>
                )}
                <div className="flex justify-between gap-4 pt-2 border-t border-slate-200">
                  <span className="text-slate-500">Total</span>
                  <span className="font-bold text-slate-900">
                    ₱{Number(resumeBooking.total ?? 0).toLocaleString('en-PH')}
                  </span>
                </div>
                {resumeBooking.reservationFee > 0 && (
                  <div className="flex justify-between gap-4">
                    <span className="text-slate-500">Reservation fee due now</span>
                    <span className="font-semibold text-sky-700">
                      ₱{Number(resumeBooking.reservationFee ?? 0).toLocaleString('en-PH')}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex flex-col sm:flex-row gap-2 pt-2">
                <button
                  type="button"
                  onClick={handleCancelResume}
                  disabled={submitting}
                  className="sm:flex-1 px-4 py-3 min-h-11 border border-rose-200 text-rose-700 rounded-xl text-sm font-medium hover:bg-rose-50 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                >
                  <i className="fas fa-ban mr-1.5" aria-hidden="true" />
                  Cancel Booking
                </button>
                <button
                  type="button"
                  onClick={handleResume}
                  disabled={submitting}
                  className="sm:flex-[2] px-4 py-3 min-h-11 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                >
                  {submitting
                    ? <><i className="fas fa-spinner fa-spin mr-1.5" aria-hidden="true" />Opening payment…</>
                    : <><i className="fas fa-arrow-right-to-bracket mr-1.5" aria-hidden="true" />Continue Payment</>}
                </button>
              </div>
            </div>
          )}

          {/* Payment popup states — show regardless of step */}
          {paymentPopup && (
            paymentPopup.popup ? (
              /* Popup is open — show waiting state with countdown.
                 aria-live so screen-reader users hear "Waiting for
                 payment…" instead of just having content silently
                 swap in beneath their cursor. */
              <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 py-4 bg-blue-50 border border-blue-200 rounded-md mt-4">
                <i className="fas fa-spinner fa-spin text-blue-600 text-2xl" aria-hidden="true"></i>
                <p className="text-sm font-medium text-blue-800">Waiting for payment in the checkout window…</p>
                {timeLeft !== null && timeLeft <= PAYMENT_WARNING_SECONDS ? (
                  <div className="w-full max-w-sm mx-4 bg-red-50 border border-red-300 rounded-md px-3 py-2 flex items-center gap-3">
                    <i className="fas fa-exclamation-triangle text-red-600"></i>
                    <div className="flex-1 text-xs text-red-800">
                      <p className="font-semibold">Cancelling in {timeLeft}s</p>
                      <p>Still paying? Keep this booking open.</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTimeLeft(PAYMENT_WINDOW_SECONDS)}
                      className="px-4 py-2.5 min-h-11 bg-red-600 text-white rounded-md text-xs font-semibold hover:bg-red-700 shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2"
                    >
                      Keep
                    </button>
                  </div>
                ) : timeLeft !== null && (
                  <p className="text-xs font-semibold text-blue-700 tabular-nums" aria-live="polite">
                    <i className="fas fa-clock mr-1" aria-hidden="true"></i>
                    Expires in {String(Math.floor(timeLeft / 60)).padStart(2, "0")}:{String(timeLeft % 60).padStart(2, "0")}
                  </p>
                )}
                <div className="flex gap-2 flex-wrap justify-center">
                  <button
                    type="button"
                    onClick={() => { try { paymentPopup.popup?.focus(); } catch { /* ignore */ } }}
                    className="px-4 py-2.5 min-h-11 border border-blue-400 text-blue-700 rounded-md text-sm font-medium hover:bg-blue-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <i className="fas fa-external-link-alt mr-1" aria-hidden="true"></i>Bring to front
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const bId = paymentPopup.bookingId;
                      try { paymentPopup.popup?.close(); } catch { /* ignore */ }
                      setPaymentPopup(null);
                      setTimeLeft(null);
                      clearPendingPayment();
                      if (bId) {
                        (guestMode ? cancelGuestBooking(bId) : cancelBooking(bId)).catch(() => {});
                      }
                      setError("Booking cancelled.");
                    }}
                    className="px-4 py-2.5 min-h-11 border border-red-300 text-red-700 rounded-md text-sm font-medium hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : paymentPopup.verifying ? (
              /* Cancel URL received — verifying with PayMongo before giving up */
              <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 py-4 bg-yellow-50 border border-yellow-200 rounded-md mt-4">
                <i className="fas fa-spinner fa-spin text-yellow-600 text-2xl" aria-hidden="true"></i>
                <p className="text-sm font-medium text-yellow-800">Verifying payment with PayMongo…</p>
                <p className="text-xs text-gray-700">Please wait — do not close this window.</p>
              </div>
            ) : (
              /* Popup was closed — still verifying / offer to reopen */
              <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 py-4 bg-amber-50 border border-amber-200 rounded-md mt-4">
                <i className="fas fa-spinner fa-spin text-amber-600 text-2xl" aria-hidden="true"></i>
                <p className="text-sm font-medium text-amber-800">Verifying payment…</p>
                <p className="text-xs text-amber-800">If you completed payment, please wait. Otherwise, reopen the window.</p>
                {timeLeft !== null && timeLeft <= PAYMENT_WARNING_SECONDS ? (
                  <div className="w-full max-w-sm mx-4 bg-red-50 border border-red-300 rounded-md px-3 py-2 flex items-center gap-3">
                    <i className="fas fa-exclamation-triangle text-red-600" aria-hidden="true"></i>
                    <div className="flex-1 text-xs text-red-800">
                      <p className="font-semibold">Cancelling in {timeLeft}s</p>
                      <p>Still paying? Keep this booking open.</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTimeLeft(PAYMENT_WINDOW_SECONDS)}
                      className="px-4 py-2.5 min-h-11 bg-red-600 text-white rounded-md text-xs font-semibold hover:bg-red-700 shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2"
                    >
                      Keep
                    </button>
                  </div>
                ) : timeLeft !== null && (
                  <p className="text-xs font-semibold text-amber-700 tabular-nums" aria-live="polite">
                    <i className="fas fa-clock mr-1" aria-hidden="true"></i>
                    Time remaining: {String(Math.floor(timeLeft / 60)).padStart(2, "0")}:{String(timeLeft % 60).padStart(2, "0")}
                  </p>
                )}
                <div className="flex gap-2 flex-wrap justify-center">
                  <button
                    type="button"
                    onClick={() => {
                      const { checkoutUrl, bookingId } = paymentPopup;
                      const pw = 600, ph = 700;
                      const pl = Math.round(window.screen.width  / 2 - pw / 2);
                      const pt = Math.round(window.screen.height / 2 - ph / 2);
                      const newPopup = window.open(
                        checkoutUrl, "paymongo_checkout",
                        `width=${pw},height=${ph},left=${pl},top=${pt},resizable=yes,scrollbars=yes`
                      );
                      if (!newPopup || newPopup.closed) {
                        const tab = window.open(checkoutUrl, '_blank');
                        setPaymentPopup({ bookingId, checkoutUrl, popup: tab });
                        return;
                      }
                      setPaymentPopup({ bookingId, checkoutUrl, popup: newPopup });
                    }}
                    className="px-4 py-2.5 min-h-11 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                  >
                    <i className="fas fa-redo mr-1" aria-hidden="true"></i>Reopen Payment Window
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const bId = paymentPopup.bookingId;
                      setPaymentPopup(null);
                      setTimeLeft(null);
                      clearPendingPayment();
                      if (bId) {
                        (guestMode ? cancelGuestBooking(bId) : cancelBooking(bId)).catch(() => {});
                      }
                      setError("Booking cancelled.");
                    }}
                    className="px-4 py-2.5 min-h-11 border border-red-300 text-red-700 rounded-md text-sm font-medium hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                  >
                    Cancel Booking
                  </button>
                </div>
              </div>
            )
          )}
        </div>

        {/* ── Booking Confirmation ──
             z-[60] sits BELOW the parent Modal's z-[9999], but works
             because this overlay is a descendant in the DOM — its
             stacking context is established inside the parent. The
             intentional pairing keeps the confirm sheet visually
             nested in the booking flow rather than detached at
             document.body. The fullscreen lightbox (z-[10001]) and
             desktop preview (z-[10000]) are the only siblings that
             must outrank the parent itself. */}
        {confirmOpen && (() => {
          // Literal-class lookup tables for the booking-type badge —
          // Tailwind v4 purges classes built from template literals,
          // so `bg-${color}-100` won't survive the build for any
          // non-default `color`. Listing the full classnames keeps
          // every color reachable from the JIT pass.
          const TYPE_BADGE_CLASS = {
            blue:   "bg-blue-100 text-blue-800",
            indigo: "bg-indigo-100 text-indigo-800",
            purple: "bg-purple-100 text-purple-800",
          };
          const typeInfo = {
            day:    { label: "Day Visit",  icon: "fa-sun",   color: "blue",   checkIn: "7:00 AM", checkOut: "5:00 PM (same day)" },
            night:  { label: "Night Stay",  icon: "fa-moon",  color: "indigo", checkIn: "6:00 PM", checkOut: "6:00 AM (next day)" },
            "24hr": { label: "24 Hours",   icon: "fa-clock", color: "purple", checkIn: "Any time (from 7 AM)", checkOut: "6:00 AM (next day)" },
          }[bookingType] ?? { label: "Day Visit", icon: "fa-sun", color: "blue", checkIn: "7:00 AM", checkOut: "5:00 PM (same day)" };
          const rateLabel = bookingType === "night" ? "Overnight rate" : is24hr ? "24-hour rate" : "Day visit rate";
          return (
          <div className="fixed inset-0 z-[60] overflow-y-auto flex items-center justify-center px-4 py-10"
            onKeyDown={(e) => { if (e.key === 'Escape') setConfirmOpen(false); }}>
            <div className="absolute inset-0 bg-black/60" onClick={() => setConfirmOpen(false)} />
            <div
              ref={confirmDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="booking-confirm-title"
              className="relative bg-white w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden my-4"
            >

              {/* Header */}
              <div className="bg-blue-600 px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3 text-white">
                  <i className="fas fa-clipboard-check text-xl" aria-hidden="true"></i>
                  <div>
                    <h3 id="booking-confirm-title" className="font-bold text-lg">Booking Summary</h3>
                    <p className="text-blue-100 text-xs">Please review before proceeding to payment</p>
                  </div>
                </div>
                <button onClick={() => setConfirmOpen(false)} type="button" className="w-11 h-11 inline-flex items-center justify-center -mr-2 text-white/80 hover:text-white rounded-md hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70" aria-label="Close">
                  <i className="fas fa-times" aria-hidden="true"></i>
                </button>
              </div>

              <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">

                {/* Booking Type Badge — uses the TYPE_BADGE_CLASS
                    lookup defined above so JIT keeps purple-* available. */}
                <div className="flex items-center gap-3">
                  <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-semibold ${TYPE_BADGE_CLASS[typeInfo.color] ?? TYPE_BADGE_CLASS.blue}`}>
                    <i className={`fas ${typeInfo.icon}`} aria-hidden="true"></i>
                    {typeInfo.label}
                  </span>
                </div>

                {/* Details Grid */}
                <div className="bg-gray-50 rounded-xl overflow-hidden border border-gray-200">
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-gray-100">
                      <tr>
                        <td className="px-4 py-2.5 text-gray-500 font-medium w-36">Room</td>
                        <td className="px-4 py-2.5 font-semibold text-gray-900">{roomName}</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-2.5 text-gray-500 font-medium">Date</td>
                        <td className="px-4 py-2.5 text-gray-900">
                          {visitDate ? new Date(visitDate + "T00:00:00").toLocaleDateString("en-PH", {
                            weekday: "long", year: "numeric", month: "long", day: "numeric"
                          }) : "—"}
                        </td>
                      </tr>
                      <tr>
                        <td className="px-4 py-2.5 text-gray-500 font-medium">Check-in</td>
                        <td className="px-4 py-2.5 text-gray-900">{typeInfo.checkIn}</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-2.5 text-gray-500 font-medium">Check-out</td>
                        <td className="px-4 py-2.5 text-gray-900">{typeInfo.checkOut}</td>
                      </tr>
                      {specialRequests && (
                        <tr>
                          <td className="px-4 py-2.5 text-gray-500 font-medium align-top">Requests</td>
                          <td className="px-4 py-2.5 text-gray-700 italic">"{specialRequests}"</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pricing Breakdown */}
                <div className="bg-blue-50 rounded-xl border border-blue-200 p-4 space-y-2 text-sm">
                  <p className="font-semibold text-blue-900 mb-1">Payment Breakdown</p>
                  <div className="flex justify-between text-gray-700">
                    <span>
                      {additionalRooms.length > 0 ? `Primary room (${rateLabel})` : rateLabel}
                      {is24hr && effectiveNights > 1 && (
                        <span className="text-xs text-gray-500 ml-1">
                          · {formatPHP(baseRate)} × {effectiveNights} nights
                        </span>
                      )}
                    </span>
                    <span className={`tabular-nums ${discount > 0 ? "line-through text-gray-500" : ""}`}>{formatPHP(primaryRoomSubtotal)}</span>
                  </div>
                  {additionalRoomRows.filter(r => r.room).map(r => {
                    const typeLbl = r.type === 'night' ? 'Night' : r.type === '24hr' ? '24hr' : 'Day';
                    return (
                      <div key={r.room.id} className="flex justify-between text-gray-700">
                        <span>
                          + {r.room.name}
                          <span className="text-xs text-gray-500 ml-1">
                            · {typeLbl}
                            {r.type === '24hr' && r.nights > 1
                              ? ` · ${formatPHP(r.rate)} × ${r.nights} nights`
                              : ''}
                          </span>
                        </span>
                        <span className={`tabular-nums ${discount > 0 ? "line-through text-gray-500" : ""}`}>{formatPHP(r.rate * r.nights)}</span>
                      </div>
                    );
                  })}
                  {discount > 0 && (
                    <>
                      <div className="flex justify-between text-green-700 font-medium">
                        <span><i className="fas fa-tag mr-1 text-xs"></i>Promo ({promoInput.toUpperCase()})</span>
                        <span>− {formatPHP(discount)}</span>
                      </div>
                      <div className="flex justify-between font-semibold text-gray-900 border-t border-blue-200 pt-2">
                        <span>Discounted Rate</span>
                        <span>{formatPHP(discountedRoom)}</span>
                      </div>
                    </>
                  )}
                  {packageTotal > 0 && (
                    <div className="flex justify-between text-emerald-800 border-t border-blue-200 pt-2">
                      <span className="flex items-center gap-1.5">
                        <i className="fas fa-box text-[11px] text-emerald-500"></i>
                        Includes: {packageNames.join(', ')}
                      </span>
                      <span className="font-medium">+ {formatPHP(packageTotal)}</span>
                    </div>
                  )}
                  {optionalTotal > 0 && (
                    <div className="flex justify-between text-indigo-800 border-t border-blue-200 pt-2">
                      <span className="flex items-center gap-1.5">
                        <i className="fas fa-sparkles text-[11px] text-indigo-500"></i>
                        Add-ons: {optionalSummary.map(x => `${x.name} × ${x.qty}`).join(', ')}
                      </span>
                      <span className="font-medium">+ {formatPHP(optionalTotal)}</span>
                    </div>
                  )}
                  {/* Entrance fee line in the final confirmation.
                      Previously this just said "₱0.00 — Fully Paid" for
                      full-payment bookings, which was misleading — the
                      entrance fee is ALWAYS owed at the gate regardless
                      of how the room was paid. */}
                  <div className="flex justify-between text-amber-800">
                    <span className="flex items-center gap-1.5">
                      <i className="fas fa-ticket-alt text-[11px]"></i>
                      Entrance fee (₱{entranceRate}/pax · gate)
                    </span>
                    <span>{formatPHP(estimatedEntrance)}<span className="text-[10px] text-amber-600 ml-1">est.</span></span>
                  </div>
                  <div className="flex justify-between font-semibold text-gray-800 pt-1 border-t border-blue-100">
                    <span>Estimated Grand Total</span>
                    <span className="text-gray-900">{formatPHP(grandEstimate)}</span>
                  </div>
                  <div className="border-t border-blue-300 pt-2 flex justify-between font-bold text-blue-800 text-base">
                    <span>{paymentOption === "full" ? "Online Now (Room Only)" : "Reservation Fee (Pay Now)"}</span>
                    <span>{formatPHP(amountDue)}</span>
                  </div>
                  <div className="flex justify-between text-gray-700">
                    <span>Still to pay at resort</span>
                    <span className="font-medium text-gray-900 tabular-nums">{formatPHP(resortBalance)}</span>
                  </div>
                  <p className="text-[11px] text-gray-700">
                    {balanceDue > 0
                      ? <>Includes {formatPHP(balanceDue)} room balance + {formatPHP(estimatedEntrance)} gate entrance.</>
                      : <>Room is fully settled online; only the entrance fee remains at the gate.</>}
                  </p>
                </div>

                {/* Payment option badge — the full-payment pill used to
                    claim "₱0 balance at check-in". That was wrong:
                    entrance is always owed at the gate. */}
                <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ${
                  paymentOption === "full"
                    ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                    : "bg-blue-50 text-blue-800 border border-blue-200"
                }`}>
                  <i className={`fas ${paymentOption === "full" ? "fa-check-circle text-emerald-600" : "fa-bookmark text-blue-500"}`}></i>
                  {paymentOption === "full"
                    ? `Paying full room online — only the ₱${entranceRate}/pax entrance fee will be collected at the gate`
                    : `Reserve only — ${formatPHP(resortBalance)} balance (room + entrance) due at resort`}
                </div>

                {/* Payment note */}
                <div className="flex items-start gap-2 text-xs text-gray-700 bg-gray-50 rounded-lg px-3 py-2">
                  <i className="fas fa-lock text-blue-500 mt-0.5 shrink-0" aria-hidden="true"></i>
                  <span>A <span className="font-medium">PayMongo</span> checkout window will open. You can pay via <span className="font-medium">GCash</span>.</span>
                </div>
              </div>

              {/* Actions */}
              <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
                <button onClick={() => setConfirmOpen(false)}
                  type="button"
                  className="flex-1 px-4 py-2.5 min-h-11 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                  <i className="fas fa-arrow-left mr-2" aria-hidden="true"></i>Back
                </button>
                <button onClick={handleConfirm}
                  type="button"
                  className="flex-1 px-4 py-2.5 min-h-11 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-bold inline-flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2">
                  <i className="fas fa-lock" aria-hidden="true"></i>
                  Confirm &amp; Pay {formatPHP(amountDue)}
                </button>
              </div>
            </div>
          </div>
          );
        })()}
      </div>

      {/* Verify-email modal — opens on top of the BookingModal when the
          authenticated guest hits the "Verify Now" CTA. Closes after
          success; the refreshed user state propagates and the
          needsVerification gate clears on the next render. */}
      <VerifyEmailModal open={verifyOpen} onClose={() => setVerifyOpen(false)} />
    </Modal>
  );
}
