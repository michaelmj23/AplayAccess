// Shared low-stock logic for the add-on pool. Pool is tracked globally
// (same physical pillow serves every booking), so any valid /availability
// probe returns live state for every active add-on.
//
// Threshold is HYBRID: an add-on is low when `remaining <= max(2, 25% of
// max_qty)`. The floor stops low-volume items (max_qty=5) from flipping to
// low the moment one goes out; the percentage keeps high-volume items
// (max_qty=20) honest without having to retune for every new item.
//
// Clamped below max_qty so the threshold can never equal or exceed the
// item's total capacity (otherwise a max_qty=2 item flags even when
// remaining=max — nonsense). Single-unit items (max_qty <= 1) have no
// meaningful "low" state (either it's in use or it isn't), so they skip
// this logic entirely via isLowStock / findLowStock returning false.
export function lowStockFloor(maxQty) {
  const m = Number(maxQty || 0);
  if (m <= 1) return 0;
  return Math.min(m - 1, Math.max(2, Math.ceil(m * 0.25)));
}

// Room-attached add-ons (videoke bundled with Blue Pavilion etc.) are
// physical fixtures, not pooled consumables: their "remaining = 0" just
// means every room carrying one is currently booked, not that the resort
// is out of stock and should restock. The `is_room_attached` flag comes
// from the backend availability payload (addons with any room_addons
// pivot entries).
export function isStockTracked(stockRow) {
  if (!stockRow) return false;
  return !stockRow.is_room_attached;
}

export function isLowStock(stockRow, maxQty) {
  if (!stockRow) return false;
  if (!isStockTracked(stockRow)) return false;
  // Single-unit inventories have no "low" state — skip to keep the banner
  // / filter chip free of non-actionable noise.
  if (Number(maxQty || 0) <= 1) return false;
  const remaining = Number(stockRow.remaining);
  if (!Number.isFinite(remaining)) return false;
  return remaining <= lowStockFloor(maxQty);
}

export function isOutOfStock(stockRow) {
  if (!stockRow) return false;
  if (!isStockTracked(stockRow)) return false;
  return Number(stockRow.remaining) <= 0;
}

// Given the full addons list plus the stockMap keyed by id, return the
// addons that are low or out, each annotated with its live remaining.
// Inactive addons AND room-attached fixtures are skipped — neither has
// an actionable restock answer.
export function findLowStock(addons, stockMap) {
  if (!Array.isArray(addons)) return [];
  const out = [];
  for (const a of addons) {
    if (!a.is_active) continue;
    const s = stockMap?.[a.id];
    if (!s || s.is_room_attached) continue;
    if (isLowStock(s, a.max_qty)) {
      out.push({ ...a, remaining: Number(s.remaining), allocated: Number(s.allocated) });
    }
  }
  // Out-of-stock first, then by remaining asc, then alphabetical — most
  // urgent to least.
  out.sort((a, b) => {
    if ((a.remaining === 0) !== (b.remaining === 0)) return a.remaining === 0 ? -1 : 1;
    if (a.remaining !== b.remaining) return a.remaining - b.remaining;
    return (a.name || "").localeCompare(b.name || "");
  });
  return out;
}
