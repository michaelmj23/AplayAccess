// src/lib/frontdeskApi.js
import { api } from "./api";
import { RESORT_ID } from "./config";

// GET /api/admin/bookings — all bookings (staff + admin only).
// Optional params:
//   from   (YYYY-MM-DD)     — earliest check-in date to return; any
//                             still-Checked-In booking is always included
//                             so in-progress stays don't disappear.
//   to     (YYYY-MM-DD)     — latest check-in date to return.
//   search (string)         — filter by guest name / email / phone /
//                             room name / booking id.
// Pass nothing for the classic "all bookings" behavior.
export async function getFdBookings(params = {}) {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
  );
  const res = await api.get("/api/admin/bookings", { params: clean });
  return res.data.data;
}

// PATCH /api/admin/bookings/{id}/status
export async function updateBookingStatus(bookingId, status, extra = {}) {
  const res = await api.patch(`/api/admin/bookings/${bookingId}/status`, { status, ...extra });
  return res.data;
}

// POST /api/admin/reservations/{id}/checkin
// Group / reservation-level bulk check-in. Flips every sibling whose
// status is Confirmed and whose check_in date is today or earlier to
// Checked In. Returns a summary {checked_in, skipped_future,
// blocked_unpaid, already_checked_in, blocked_terminal} plus a
// human-friendly `message` ready to render as a toast.
export async function checkInReservation(reservationId) {
  const res = await api.post(`/api/admin/reservations/${reservationId}/checkin`);
  return res.data;
}

// POST /api/admin/reservations/{id}/checkout
// Group / reservation-level bulk check-out. Flips every sibling that
// is Checked In and fully paid to Completed in one call. Returns a
// summary {checked_out, blocked_unpaid, blocked_not_in,
// already_completed, blocked_terminal} plus a human-friendly
// `message`.
export async function checkOutReservation(reservationId) {
  const res = await api.post(`/api/admin/reservations/${reservationId}/checkout`);
  return res.data;
}

// POST /api/admin/reservations/{id}/cancel
// Group / reservation-level bulk cancel. Flips every Pending or
// Confirmed sibling to Cancelled. Checked-In and Completed siblings
// are blocked and surfaced in the summary — they need per-row
// handling (check-out, refund decisions). Returns {cancelled,
// blocked_checked_in, blocked_completed, already_cancelled,
// already_no_show} plus `message`.
export async function cancelReservation(reservationId) {
  const res = await api.post(`/api/admin/reservations/${reservationId}/cancel`);
  return res.data;
}

// POST /api/admin/reservations/{id}/revert-no-show
// Group / reservation-level no-show reversal. Flips every No-Show
// sibling back to Confirmed, clears no_show_at, and re-increments
// any promo uses_count that was released on markNoShow. Use when
// staff marked no-show prematurely and the guest is expected to
// arrive later. Returns {reverted, not_no_show} plus `message`.
export async function revertNoShowReservation(reservationId) {
  const res = await api.post(`/api/admin/reservations/${reservationId}/revert-no-show`);
  return res.data;
}

// GET /api/admin/bookings/{id}/extension-options
// Phase 5. Returns the valid-continuations list + pricing preview for
// extending a Checked-In booking. Shape: {current: {type, endsAt},
// options: [{type, nights, start, end, rate, total}]}.
export async function getExtensionOptions(bookingId) {
  const res = await api.get(`/api/admin/bookings/${bookingId}/extension-options`);
  return res.data;
}

// POST /api/admin/bookings/{id}/extensions
// body: {type, nights?, notes?}. Returns {extension}. The parent
// booking's check_out, fully_paid, outstanding, and extensions[]
// payload refresh on the next getFdBookings call.
export async function createExtension(bookingId, payload) {
  const res = await api.post(`/api/admin/bookings/${bookingId}/extensions`, payload);
  return res.data;
}

// POST /api/admin/reservations/{id}/extensions
// Reservation-level bulk extend. Applies the chosen slot to every
// Checked-In sibling; backend skips type-mismatches, room overlaps,
// and add-on shortages with per-category reasons in the summary.
// Each extended sibling writes its own BookingExtension row so
// revenue analytics pick it up the same way as per-room extends.
export async function extendReservation(reservationId, payload) {
  const res = await api.post(`/api/admin/reservations/${reservationId}/extensions`, payload);
  return res.data;
}

// DELETE /api/admin/bookings/{id}/extensions/{extensionId}
// Cancel the tail extension. Backend guards: only tail, must not
// have started yet, booking status Checked In. Returns
// {removed_total, refund_applied, overpayment, booking}.
//
// Pass opts.refundCash=true when staff confirms they physically
// handed back the overpayment to the guest — backend then records
// it as a refund (refund_amount += overpayment, refunded_at = now).
// Omit or false to leave the booking overpaid without recording a
// refund (staff keeps as credit or will reconcile at checkout).
export async function cancelExtension(bookingId, extensionId, opts = {}) {
  const body = {};
  if (opts.refundCash) body.refund_cash = true;
  const res = await api.delete(
    `/api/admin/bookings/${bookingId}/extensions/${extensionId}`,
    { data: body },
  );
  return res.data;
}

// POST /api/admin/reservations/{id}/collect-payment
// Group / reservation-level collect-payment. Walks each sibling with
// outstanding > 0 and brings paid_amount up to that sibling's own
// grand total. Lead row hydrates entrance_fee from the reservation
// snapshot if still 0. Returns a summary + total_delta collected.
export async function collectReservationPayment(reservationId, paymentMethod, entranceFee, opts = {}) {
  const body = { payment_method: paymentMethod };
  if (entranceFee != null) body.entrance_fee = Number(entranceFee);
  if (opts.amount != null) body.amount = Number(opts.amount);
  if (opts.gcashRef) body.gcash_ref = String(opts.gcashRef).trim();
  const res = await api.post(`/api/admin/reservations/${reservationId}/collect-payment`, body);
  return res.data;
}

// POST /api/admin/reservations/{id}/mark-no-show
// Group / reservation-level mark-as-no-show. Flips every Confirmed
// Day/Night sibling whose slot has started to No-Show. 24hr siblings
// are excluded (auto-checkin covers them in the normal case).
// Returns {marked, blocked_not_confirmed[], blocked_future_slot[],
// blocked_wrong_type[], already_no_show} plus `message`.
export async function markNoShowReservation(reservationId) {
  const res = await api.post(`/api/admin/reservations/${reservationId}/mark-no-show`);
  return res.data;
}

// POST /api/admin/bookings/{id}/checkin
export async function checkInBooking(bookingId, entranceFee) {
  const payload = entranceFee != null ? { entrance_fee: entranceFee } : {};
  const res = await api.post(`/api/admin/bookings/${bookingId}/checkin`, payload);
  return res.data;
}

// PATCH /api/admin/bookings/{id}/no-show
// Front desk marks a Confirmed Day/Night booking as No-Show when the
// guest never arrives. Backend enforces: status=Confirmed, booking_type
// in ('day','night'), check_in in the past. Reversible via checkInBooking().
export async function markBookingNoShow(bookingId) {
  const res = await api.patch(`/api/admin/bookings/${bookingId}/no-show`);
  return res.data;
}

// POST /api/admin/bookings/{id}/collect-payment
export async function collectPayment(bookingId, paymentMethod, entranceFee, opts = {}) {
  const body = { payment_method: paymentMethod };
  if (entranceFee != null) body.entrance_fee = entranceFee;
  if (opts.amount != null) body.amount = Number(opts.amount);
  if (opts.gcashRef) body.gcash_ref = String(opts.gcashRef).trim();
  const res = await api.post(`/api/admin/bookings/${bookingId}/collect-payment`, body);
  return res.data;
}

// POST /api/admin/bookings/{id}/counter-xendit-invoice
// Creates a short-lived (15 min) Xendit GCash invoice for the exact
// amount (<= outstanding). Returns { invoice_id, invoice_url, amount,
// expires_at } — the modal renders the invoice_url as an inline QR
// code and polls counterXenditStatus until paid.
export async function createCounterXenditInvoice(bookingId, amount) {
  const res = await api.post(`/api/admin/bookings/${bookingId}/counter-xendit-invoice`, {
    amount: Number(amount),
  });
  return res.data;
}

// POST /api/admin/reservations/{id}/counter-xendit-invoice
// Group-level counter QR. Creates one Xendit invoice covering the
// aggregate outstanding across every eligible sibling; the backend
// splits paid_amount proportionally per sibling on payment.
export async function createCounterXenditInvoiceForReservation(reservationId, amount) {
  const res = await api.post(`/api/admin/reservations/${reservationId}/counter-xendit-invoice`, {
    amount: Number(amount),
  });
  return res.data;
}

// GET /api/admin/payments/counter-status/{invoice_id}
// Polled by the Collect modal. Returns { state, amount, paid_at,
// booking_id }. On state='paid' the backend credits the booking's
// paid_amount idempotently via applyCounterPaymentFromInvoice.
export async function getCounterXenditStatus(invoiceId) {
  const res = await api.get(`/api/admin/payments/counter-status/${invoiceId}`);
  return res.data;
}

// PATCH /api/admin/bookings/{id}/guests
export async function updateBookingGuests(bookingId, guests) {
  const res = await api.patch(`/api/admin/bookings/${bookingId}/guests`, { guests });
  return res.data;
}

// POST /api/admin/bookings/{id}/checkout
export async function checkOutBooking(bookingId) {
  const res = await api.post(`/api/admin/bookings/${bookingId}/checkout`);
  return res.data;
}

// POST /api/admin/walkin-booking — create walk-in booking under the guest's own account
export async function createWalkInBooking(payload) {
  const res = await api.post("/api/admin/walkin-booking", payload);
  return res.data;
}

// GET /api/resorts/:id/rooms — room list (backend auto-includes tent for authenticated staff)
export async function getFdRooms() {
  const res = await api.get(`/api/resorts/${RESORT_ID}/rooms`);
  return res.data.data ?? res.data;
}

// POST /api/admin/bookings/{id}/amenities — add amenity to booking
export async function addAmenity(bookingId, name, qty) {
  const res = await api.post(`/api/admin/bookings/${bookingId}/amenities`, { name, qty });
  return res.data;
}

// PATCH /api/admin/bookings/{id}/amenities/{amenityId} — edit amenity qty
export async function updateAmenity(bookingId, amenityId, qty) {
  const res = await api.patch(`/api/admin/bookings/${bookingId}/amenities/${amenityId}`, { qty });
  return res.data;
}

// DELETE /api/admin/bookings/{id}/amenities/{amenityId} — remove amenity
export async function removeAmenity(bookingId, amenityId) {
  const res = await api.delete(`/api/admin/bookings/${bookingId}/amenities/${amenityId}`);
  return res.data;
}

// GET /api/admin/addons/availability
// Add-on pool tracking is GLOBAL, not windowed — the resort's physical
// stock is shared across every active booking (Pending / Confirmed /
// Checked-In) regardless of dates, since the same physical units
// aren't teleporting between concurrent stays in practice and staff
// want a single "N pillows still available across the resort" number.
//
// Two calling modes:
//   - addonAvailabilityForBooking(bookingId): excludes the booking's
//     own allocation so the picker/editor shows how many *more* it can
//     take from the pool.
//   - addonAvailabilityForSlot(...): for a walk-in that doesn't have
//     a booking row yet — just reads the full pool state.
// Response: { data: [{id, name, icon, price, max_qty, allocated,
// remaining, per_booking}], window: {check_in, check_out} }
export async function addonAvailabilityForBooking(bookingId) {
  const res = await api.get(`/api/admin/addons/availability`, { params: { booking_id: bookingId } });
  return res.data;
}
export async function addonAvailabilityForSlot({ date, bookingType, hour }) {
  const params = { date, booking_type: bookingType };
  if (bookingType === '24hr' && hour != null) params.hour = hour;
  const res = await api.get(`/api/admin/addons/availability`, { params });
  return res.data;
}

// PATCH /api/admin/bookings/{id}/transfer-room — move a Checked In booking to another room
export async function transferRoom(bookingId, roomId) {
  const res = await api.patch(`/api/admin/bookings/${bookingId}/transfer-room`, { room_id: roomId });
  return res.data;
}

// GET /api/admin/bookings/{id}/receipt — staff downloads PDF receipt as a blob
export async function downloadStaffReceipt(bookingId) {
  const res = await api.get(`/api/admin/bookings/${bookingId}/receipt`, { responseType: 'blob' });
  return res.data;
}
