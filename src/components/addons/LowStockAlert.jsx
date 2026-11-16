import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getAdminAddons } from "../../lib/adminApi";
import { addonAvailabilityForSlot } from "../../lib/frontdeskApi";
import { findLowStock, isOutOfStock } from "../../lib/addonStock";

// Dashboard banner — only renders when something's actually low or out.
// Fails silent on load errors (stock info is non-critical; a broken banner
// shouldn't crash the dashboard). Routes to the Addons page with the "low"
// filter pre-applied.
export default function LowStockAlert({ portal = "owner" }) {
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const today = new Date().toISOString().slice(0, 10);
    Promise.all([
      getAdminAddons(),
      addonAvailabilityForSlot({ date: today, bookingType: "day" }).catch(() => null),
    ])
      .then(([addonsRes, availRes]) => {
        if (cancelled) return;
        const addons = addonsRes?.data?.data ?? [];
        const map = {};
        for (const row of (availRes?.data ?? [])) map[row.id] = row;
        setItems(findLowStock(addons, map));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  if (!loaded || items.length === 0) return null;

  const hasOut = items.some(a => isOutOfStock({ remaining: a.remaining }));
  const tone = hasOut
    ? { bar: "bg-rose-50 border-rose-200", icon: "bg-rose-100 text-rose-600", title: "text-rose-900", body: "text-rose-800", chip: "bg-rose-100 text-rose-800" }
    : { bar: "bg-amber-50 border-amber-200", icon: "bg-amber-100 text-amber-700", title: "text-amber-900", body: "text-amber-800", chip: "bg-amber-100 text-amber-800" };

  const href = `/${portal === "admin" ? "admin" : "owner"}/addons?filter=low`;

  return (
    <div className={`rounded-xl border p-4 ${tone.bar} flex items-start gap-3`}>
      <span className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${tone.icon}`}>
        <i className={`fas ${hasOut ? "fa-exclamation-triangle" : "fa-triangle-exclamation"}`} aria-hidden="true"></i>
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-semibold ${tone.title}`}>
          {items.length} add-on{items.length === 1 ? "" : "s"} {hasOut ? "need restocking" : "running low"}
        </p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {items.slice(0, 4).map(a => (
            <span key={a.id} className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium tabular-nums ${tone.chip}`}>
              <i className={`fas ${a.icon || "fa-tag"} text-[10px]`} aria-hidden="true"></i>
              {a.name} · {a.remaining} left
            </span>
          ))}
          {items.length > 4 && (
            <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${tone.chip}`}>
              +{items.length - 4} more
            </span>
          )}
        </div>
      </div>
      <Link
        to={href}
        className={`shrink-0 self-start text-xs font-semibold px-3 py-1.5 rounded-lg transition ${tone.chip} hover:brightness-95`}
      >
        Review
        <i className="fas fa-arrow-right ml-1.5 text-[10px]" aria-hidden="true"></i>
      </Link>
    </div>
  );
}
