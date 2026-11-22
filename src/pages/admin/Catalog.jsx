import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import {
  getAdminRooms,
  getAdminAddons,
  toggleAddonActive,
  updateRoomAvailability,
} from "../../lib/adminApi.js";
import { addonAvailabilityForSlot } from "../../lib/frontdeskApi.js";
import { isLowStock as isLowStockFn, findLowStock } from "../../lib/addonStock.js";
import Modal from "../../components/modals/Modal.jsx";
import ConfirmDialog from "../../components/ui/ConfirmDialog.jsx";
import Toast, { useToast } from "../../components/ui/Toast.jsx";
import useDebounce from "../../hooks/useDebounce.js";
import { TabBar } from "../owner/Users.jsx";

// Catalog page — admin's curation surface. Two tabs (Rooms / Add-ons),
// each visually consistent with the equivalent owner page (owner/Rooms,
// owner/Addons) but stripped to a single capability:
//   - Rooms: change availability_status (5 enum values). No rate /
//     capacity / name edits, no create / delete.
//   - Add-ons: toggle is_active. No create / rename / reprice / delete.
// Owner uses /owner/rooms (with the addons sub-tab) for full CRUD.

const PAGE_SIZE = 10;

const AVAIL = {
  available:   { label: "Available",          color: "bg-success-bg text-success-fg",   dot: "bg-success-ring",  icon: "fa-check-circle" },
  renovation:  { label: "Under Renovation",   color: "bg-danger-bg text-danger-fg",     dot: "bg-danger-ring",   icon: "fa-hard-hat"     },
  maintenance: { label: "Under Maintenance",  color: "bg-warning-bg text-warning-fg",   dot: "bg-warning-ring",  icon: "fa-wrench"       },
  reserved:    { label: "Reserved / Blocked", color: "bg-info-bg text-info-fg",         dot: "bg-info-ring",     icon: "fa-lock"         },
  closed:      { label: "Temporarily Closed", color: "bg-slate-100 text-slate-600",     dot: "bg-slate-400",     icon: "fa-ban"          },
};

const CATEGORY_TABS = [
  { key: "",         label: "All",       icon: "fa-th-large"       },
  { key: "room",     label: "Rooms",     icon: "fa-bed"            },
  { key: "cottage",  label: "Cottages",  icon: "fa-umbrella-beach" },
  { key: "pavilion", label: "Pavilions", icon: "fa-archway"        },
  { key: "tent",     label: "Tents",     icon: "fa-campground"     },
];

function getRoomCategory(r) {
  if (r.category) return r.category;
  const n = (r.name || "").toLowerCase();
  if (n.includes("tent"))     return "tent";
  if (n.includes("cottage"))  return "cottage";
  if (n.includes("pavilion")) return "pavilion";
  return "room";
}

function AvailBadge({ status }) {
  const cfg = AVAIL[status] || AVAIL.available;
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${cfg.color}`}>
      <span className={`h-2 w-2 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function getPageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set([1, total]);
  for (let i = current - 1; i <= current + 1; i++) {
    if (i >= 1 && i <= total) pages.add(i);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const result = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) result.push("...");
    result.push(p);
    prev = p;
  }
  return result;
}

const TABS = [
  { key: "rooms",  icon: "fa-bed",            label: "Rooms"   },
  { key: "addons", icon: "fa-concierge-bell", label: "Add-ons" },
];

export default function AdminCatalog() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") === "addons" ? "addons" : "rooms";
  const setActiveTab = (key) => {
    if (key === "rooms") setSearchParams({});
    else setSearchParams({ tab: key });
  };

  return (
    <>
      <Helmet><title>Catalog — Aplaya Beach Resort</title></Helmet>
      <TabBar tabs={TABS} active={activeTab} onChange={setActiveTab} />
      {activeTab === "rooms" ? <RoomsTab /> : <AddonsTab />}
    </>
  );
}

/* ───────────────────────── ROOMS TAB ───────────────────────── */

function RoomsTab() {
  const [rooms,        setRooms]        = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [error,        setError]        = useState(null);
  const [busyId,       setBusyId]       = useState(null);
  const [viewRoom,     setViewRoom]     = useState(null);
  const [searchTerm,   setSearchTerm]   = useState("");
  const [filterAvail,  setFilterAvail]  = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [page,         setPage]         = useState(1);
  const debouncedSearch = useDebounce(searchTerm, 300);
  const [toast, showToast, clearToast, toastType] = useToast();
  const searchRef = useRef(null);

  const load = useCallback((silent = false) => {
    silent ? setRefreshing(true) : setLoading(true);
    setError(null);
    getAdminRooms()
      .then((r) => setRooms(r.data?.data ?? []))
      .catch(() => setError("Failed to load rooms."))
      .finally(() => { silent ? setRefreshing(false) : setLoading(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => { setPage(1); }, [debouncedSearch, filterAvail, filterCategory]);

  const filtered = useMemo(() => rooms.filter((r) => {
    if (filterCategory && getRoomCategory(r) !== filterCategory) return false;
    if (filterAvail && (r.availability_status || "available") !== filterAvail) return false;
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      return (r.name || "").toLowerCase().includes(q);
    }
    return true;
  }), [rooms, filterCategory, filterAvail, debouncedSearch]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const paginated  = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const showFrom   = filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const showTo     = Math.min(safePage * PAGE_SIZE, filtered.length);

  const countRoom     = useMemo(() => rooms.filter((r) => getRoomCategory(r) === "room").length,     [rooms]);
  const countCottage  = useMemo(() => rooms.filter((r) => getRoomCategory(r) === "cottage").length,  [rooms]);
  const countPavilion = useMemo(() => rooms.filter((r) => getRoomCategory(r) === "pavilion").length, [rooms]);

  async function changeStatus(room, nextStatus) {
    if ((room.availability_status || "available") === nextStatus) return;
    setBusyId(room.id);
    try {
      const res = await updateRoomAvailability(room.id, nextStatus);
      const updated = res.data?.data ?? { ...room, availability_status: nextStatus };
      setRooms((prev) => prev.map((r) => (r.id === room.id ? { ...r, ...updated } : r)));
      if (viewRoom?.id === room.id) setViewRoom((v) => ({ ...v, ...updated }));
      showToast(`"${room.name}" → ${(AVAIL[nextStatus] || AVAIL.available).label}`, "success");
    } catch (err) {
      showToast(err?.response?.data?.message || "Failed to update room status.", "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <Toast message={toast} type={toastType} onClose={clearToast} />

      {/* Header card */}
      <div className="bg-white rounded-xl shadow-sm p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-info-bg flex items-center justify-center shrink-0">
            <i className="fas fa-bed text-info-fg text-lg" aria-hidden="true"></i>
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">Rooms Catalog</h2>
            <p className="text-sm text-slate-500">Toggle which rooms are currently bookable. Owner controls rates and inventory.</p>
            {rooms.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-1.5">
                {[
                  { count: countRoom,     label: "Rooms",     icon: "fa-bed",            bg: "bg-sky-50 text-sky-700 border-sky-200" },
                  { count: countCottage,  label: "Cottages",  icon: "fa-umbrella-beach", bg: "bg-amber-50 text-amber-700 border-amber-200" },
                  { count: countPavilion, label: "Pavilions", icon: "fa-archway",        bg: "bg-emerald-50 text-emerald-700 border-emerald-200" },
                ].map(({ count, label, icon, bg }) => (
                  <span key={label} className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${bg}`}>
                    <i className={`fas ${icon} text-[10px]`} aria-hidden="true"></i>{count} {label}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <button onClick={() => load(true)} disabled={refreshing} type="button"
          aria-label="Refresh rooms list"
          className="inline-flex items-center gap-2 min-h-11 px-4 text-slate-700 hover:text-slate-900 hover:bg-slate-50 rounded-xl text-sm font-medium transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
          <i className={`fas fa-sync-alt ${refreshing ? "fa-spin" : ""}`} aria-hidden="true"></i>
          <span>Refresh</span>
        </button>
      </div>

      {/* Error with retry */}
      {error && (
        <div className="bg-danger-bg border border-danger-bg text-danger-fg rounded-xl p-6 text-center" role="alert">
          <i className="fas fa-exclamation-triangle text-3xl mb-3 block" aria-hidden="true"></i>
          <p className="font-medium mb-3">{error}</p>
          <button onClick={() => load()} type="button"
            className="inline-flex items-center justify-center min-h-11 px-5 py-2 bg-danger-fg text-white rounded-lg text-sm font-medium hover:opacity-90 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2">
            <i className="fas fa-redo mr-2" aria-hidden="true"></i>Retry
          </button>
        </div>
      )}

      {/* Category filters — these toggle a single table view, not
          separate panels, so role="group" + aria-pressed is the
          correct pattern (was: role="tablist" which promises tabpanels).
          Each chip's count reflects what you'd see if you clicked it —
          the other filters (search, availability) are applied first and
          only category stays open. Matches the Bookings page pattern. */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter rooms by category">
        {CATEGORY_TABS.map((tab) => {
          const q = debouncedSearch?.toLowerCase() ?? "";
          const pool = rooms.filter((r) => {
            if (filterAvail && (r.availability_status || "available") !== filterAvail) return false;
            if (q && !(r.name || "").toLowerCase().includes(q)) return false;
            return true;
          });
          const count = tab.key === ""
            ? pool.length
            : pool.filter((r) => getRoomCategory(r) === tab.key).length;
          const active = filterCategory === tab.key;
          return (
            <button key={tab.key} type="button" onClick={() => setFilterCategory(tab.key)}
              aria-pressed={active}
              className={`inline-flex items-center gap-2 min-h-11 px-4 rounded-xl text-sm font-semibold border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                active
                  ? "bg-brand text-white border-brand shadow focus-visible:ring-brand"
                  : "bg-white text-slate-700 border-slate-300 hover:border-brand hover:text-brand focus-visible:ring-slate-400"
              }`}>
              <i className={`fas ${tab.icon} text-xs`} aria-hidden="true"></i>
              {tab.label}
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"
              }`}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Table card */}
      <div className="rounded-2xl bg-white border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 px-6 py-5 bg-slate-50 border-b border-slate-200">
          <div>
            <p className="text-sm text-slate-600">{filterCategory ? `${filterCategory.charAt(0).toUpperCase() + filterCategory.slice(1)}s` : "Total Rooms"}</p>
            <p className="text-2xl font-semibold text-slate-900">{filtered.length}</p>
          </div>
          <div className="flex flex-col md:flex-row md:items-center gap-3 w-full md:w-auto">
            <div className="relative w-full md:w-64">
              <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true"></i>
              <input ref={searchRef} type="text" aria-label="Search rooms" placeholder="Search rooms..."
                value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-3 py-2 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-brand text-sm" />
            </div>
            <select value={filterAvail} onChange={(e) => setFilterAvail(e.target.value)} aria-label="Filter by availability"
              className="min-w-44 px-3 py-2 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-brand text-sm bg-white">
              <option value="">All Availability</option>
              {Object.entries(AVAIL).map(([val, { label }]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          {loading ? (
            <RoomsSkeleton />
          ) : filtered.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-slate-100 mb-4">
                <i className="fas fa-bed text-slate-300 text-2xl" aria-hidden="true"></i>
              </div>
              <p className="text-slate-500 font-medium">
                {debouncedSearch || filterAvail || filterCategory
                  ? "No rooms match your filters."
                  : "No rooms in the catalog yet."}
              </p>
              {(debouncedSearch || filterAvail || filterCategory) && (
                <button onClick={() => { setSearchTerm(""); setFilterAvail(""); setFilterCategory(""); }} type="button"
                  className="mt-4 text-sm text-brand hover:text-brand-dark font-medium">
                  <i className="fas fa-times mr-1.5" aria-hidden="true"></i>Clear filters
                </button>
              )}
            </div>
          ) : (
            <table className="min-w-full text-sm text-slate-700">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3 text-left w-12"></th>
                  <th className="px-4 py-3 text-left">Name</th>
                  <th className="px-4 py-3 text-left">Qty</th>
                  <th className="px-4 py-3 text-left">Capacity</th>
                  <th className="px-4 py-3 text-left">Day Rate</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {/* Restructured rows: dropped role="button" + nested <select>.
                    The status change now lives only in the View modal —
                    keeps the row free of nested interactive controls
                    (a11y), and the modal is where admin makes other
                    detailed decisions about a room anyway. */}
                {paginated.map((room, idx) => {
                  const avail = room.availability_status || "available";
                  const isUnavailable = avail !== "available";
                  return (
                    <tr key={room.id}
                      className={`transition-all ${idx % 2 === 1 ? "bg-slate-50/50" : ""} ${isUnavailable ? "opacity-60" : ""}`}>
                      <td className="px-4 py-4">
                        {room.image
                          ? <img src={room.image} alt="" className="h-10 w-10 rounded-full object-cover" loading="lazy" decoding="async" />
                          : <div className="h-10 w-10 rounded-full bg-slate-200 flex items-center justify-center text-slate-400" aria-hidden="true"><i className="fas fa-bed"></i></div>}
                      </td>
                      <td className="px-4 py-4 font-medium text-slate-900">
                        {room.name}
                        {room.capacity_label && <span className="block text-xs text-slate-400">{room.capacity_label}</span>}
                      </td>
                      <td className="px-4 py-4 text-slate-600">{room.quantity ?? 1}</td>
                      <td className="px-4 py-4 text-slate-600">{room.capacity ?? "—"} pax</td>
                      <td className="px-4 py-4 text-slate-600">{"₱"}{Number(room.day_rate || 0).toLocaleString()}</td>
                      <td className="px-4 py-4"><AvailBadge status={avail} /></td>
                      <td className="px-4 py-4">
                        <div className="flex justify-end">
                          <button type="button" onClick={() => setViewRoom(room)}
                            aria-label={`View ${room.name}`}
                            className="inline-flex items-center justify-center h-11 min-w-[44px] px-3 rounded-lg text-sm font-medium text-brand hover:bg-info-bg transition">
                            <i className="fas fa-eye mr-1.5 text-xs" aria-hidden="true"></i>View
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {!loading && filtered.length > 0 && totalPages > 1 && (
          <nav aria-label="Rooms pagination" className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-6 py-4 bg-slate-50 border-t border-slate-200">
            <p className="text-xs text-slate-500">
              Showing <span className="font-semibold text-slate-700">{showFrom}</span>{"–"}<span className="font-semibold text-slate-700">{showTo}</span> of{" "}
              <span className="font-semibold text-slate-700">{filtered.length}</span> rooms
            </p>
            {/* WCAG 2.5.5 — 44×44 touch targets */}
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1} type="button"
                aria-label="Previous page"
                className="h-11 w-11 rounded-lg border border-slate-300 flex items-center justify-center text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
                <i className="fas fa-chevron-left text-sm" aria-hidden="true"></i>
              </button>
              {getPageNumbers(safePage, totalPages).map((n, i) =>
                n === "..." ? (
                  <span key={`d-${i}`} className="h-11 min-w-[2.75rem] flex items-center justify-center text-sm text-slate-500" aria-hidden="true">…</span>
                ) : (
                  <button key={n} onClick={() => setPage(n)} type="button"
                    aria-label={`Page ${n}`}
                    aria-current={n === safePage ? "page" : undefined}
                    className={`h-11 min-w-[2.75rem] rounded-lg text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                      n === safePage ? "bg-brand text-white shadow-sm focus-visible:ring-brand" : "border border-slate-300 text-slate-700 hover:bg-slate-50 focus-visible:ring-slate-400"
                    }`}>
                    {n}
                  </button>
                )
              )}
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages} type="button"
                aria-label="Next page"
                className="h-11 w-11 rounded-lg border border-slate-300 flex items-center justify-center text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
                <i className="fas fa-chevron-right text-sm" aria-hidden="true"></i>
              </button>
            </div>
          </nav>
        )}
      </div>

      {/* View Room Modal */}
      <Modal open={!!viewRoom} onClose={() => setViewRoom(null)} maxWidth="max-w-lg" label={viewRoom ? `Room details — ${viewRoom.name}` : 'Room details'}>
        {viewRoom && (() => {
          const avail = viewRoom.availability_status || "available";
          return (
            <>
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-xl bg-info-bg text-info-fg flex items-center justify-center">
                    <i className="fas fa-bed" aria-hidden="true"></i>
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900">{viewRoom.name}</h3>
                    <p className="text-xs text-slate-400 capitalize">{getRoomCategory(viewRoom)} details</p>
                  </div>
                </div>
                <button onClick={() => setViewRoom(null)} aria-label="Close room details" type="button"
                  className="h-11 w-11 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-600 hover:text-slate-800 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
                  <i className="fas fa-times" aria-hidden="true"></i>
                </button>
              </div>

              <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto">
                {viewRoom.image && (
                  <img src={viewRoom.image} alt={viewRoom.name} loading="lazy" className="w-full h-44 object-cover rounded-xl" />
                )}

                {avail !== "available" && (
                  <div className={`flex items-center gap-2 p-3 rounded-xl text-sm font-medium ${AVAIL[avail].color}`} role="status">
                    <i className={`fas ${AVAIL[avail].icon}`} aria-hidden="true"></i>{AVAIL[avail].label}
                  </div>
                )}

                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: "Day Rate",   value: `₱${Number(viewRoom.day_rate || 0).toLocaleString()}`,       icon: "fa-sun",   bg: "bg-amber-50",   text: "text-amber-700",   iconBg: "bg-amber-100 text-amber-500" },
                    { label: "Overnight",  value: `₱${Number(viewRoom.overnight_rate || 0).toLocaleString()}`, icon: "fa-moon",  bg: "bg-indigo-50",  text: "text-indigo-700",  iconBg: "bg-indigo-100 text-indigo-500" },
                    { label: "24 Hours",   value: `₱${Number(viewRoom.rate_24hr || 0).toLocaleString()}`,      icon: "fa-clock", bg: "bg-emerald-50", text: "text-emerald-700", iconBg: "bg-emerald-100 text-emerald-500" },
                  ].map(({ label, value, icon, bg, text, iconBg }) => (
                    <div key={label} className={`rounded-xl ${bg} border border-slate-100 p-3 text-center`}>
                      <div className={`h-8 w-8 rounded-lg ${iconBg} flex items-center justify-center mx-auto mb-1.5`}>
                        <i className={`fas ${icon} text-xs`} aria-hidden="true"></i>
                      </div>
                      <p className={`text-sm font-bold ${text}`}>{value}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">{label}</p>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wide">Capacity</p>
                    <p className="font-semibold text-slate-900 mt-0.5">{viewRoom.capacity ?? "—"} pax</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wide">Quantity</p>
                    <p className="font-semibold text-slate-900 mt-0.5">{viewRoom.quantity ?? 1}</p>
                  </div>
                  {viewRoom.beds && (
                    <div className="col-span-2">
                      <p className="text-xs text-slate-500 uppercase tracking-wide">Beds</p>
                      <p className="font-semibold text-slate-900 mt-0.5">{viewRoom.beds}</p>
                    </div>
                  )}
                  {viewRoom.description && (
                    <div className="col-span-2">
                      <p className="text-xs text-slate-500 uppercase tracking-wide">Description</p>
                      <p className="text-slate-700 mt-0.5">{viewRoom.description}</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <label htmlFor={`room-status-${viewRoom.id}`} className="text-xs text-slate-500 uppercase tracking-wide">
                    Status
                  </label>
                  <select id={`room-status-${viewRoom.id}`} value={avail}
                    onChange={(e) => changeStatus(viewRoom, e.target.value)}
                    disabled={busyId === viewRoom.id}
                    className="border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-50">
                    {Object.entries(AVAIL).map(([val, { label }]) => (
                      <option key={val} value={val}>{label}</option>
                    ))}
                  </select>
                </div>
                <button onClick={() => setViewRoom(null)} type="button"
                  className="inline-flex items-center justify-center min-h-11 px-4 py-2 border border-slate-300 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
                  Close
                </button>
              </div>
            </>
          );
        })()}
      </Modal>
    </div>
  );
}

function RoomsSkeleton() {
  return (
    <div className="divide-y divide-slate-100" aria-busy="true" role="status">
      <span className="sr-only">Loading rooms…</span>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="px-6 py-4 flex items-center gap-6 animate-pulse">
          <div className="h-10 w-10 rounded-full bg-slate-200 shrink-0"></div>
          <div className="h-4 bg-slate-200 rounded w-32"></div>
          <div className="h-4 bg-slate-100 rounded w-10"></div>
          <div className="h-4 bg-slate-100 rounded w-16"></div>
          <div className="h-4 bg-slate-200 rounded w-20"></div>
          <div className="h-5 bg-slate-200 rounded-full w-24"></div>
          <div className="h-8 bg-slate-100 rounded-lg w-32 ml-auto"></div>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── ADD-ONS TAB ───────────────────────── */

function AddonsTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [addons,       setAddons]       = useState([]);
  // Live global pool state keyed by addon id → { allocated, remaining, is_room_attached, rooms_count }.
  // Admin can SEE stock but can't change max_qty (owner-only), so this is
  // informational — supports the "flag to owner for restock" signal.
  const [stockMap,     setStockMap]     = useState({});
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [loadError,    setLoadError]    = useState(false);
  const [busyId,       setBusyId]       = useState(null);
  const [viewItem,     setViewItem]     = useState(null);
  // Disable guards: fixtures hit a hard block (disabling a package addon on
  // the catalog does NOT stop auto-attach on its bundled rooms — latent
  // backend behavior we can't fix from here, so admin is routed to owner
  // instead). Shared-pool items with allocated > 0 hit a soft confirm so
  // admin sees the impact. Enabling is always safe — never guarded.
  const [confirmDisable, setConfirmDisable] = useState(null);
  const [fixtureBlocked, setFixtureBlocked] = useState(null);
  const [searchTerm,   setSearchTerm]   = useState("");
  // filterStatus: all | active | inactive | low (low = active + remaining
  // under the hybrid threshold). Initialized from ?filter=low so the
  // dashboard alert's "Review" button lands admins on a pre-filtered page.
  const [filterStatus, setFilterStatus] = useState(
    searchParams.get("filter") === "low" ? "low" : "all"
  );
  const [page,         setPage]         = useState(1);
  const debouncedSearch = useDebounce(searchTerm, 300);
  const [toast, showToast, clearToast, toastType] = useToast();
  const searchRef = useRef(null);

  const load = useCallback((silent = false) => {
    silent ? setRefreshing(true) : setLoading(true);
    setLoadError(false);
    // Fetch catalog + live pool in parallel. Pool is global so any slot
    // probe returns correct numbers (today+day is harmless).
    const today = new Date().toISOString().slice(0, 10);
    Promise.all([
      getAdminAddons(),
      addonAvailabilityForSlot({ date: today, bookingType: "day" }).catch(() => null),
    ])
      .then(([addonsRes, availRes]) => {
        setAddons(addonsRes.data?.data ?? []);
        const map = {};
        for (const row of (availRes?.data ?? [])) map[row.id] = row;
        setStockMap(map);
      })
      .catch(() => { setLoadError(true); showToast("Failed to load add-ons.", "error"); })
      .finally(() => { silent ? setRefreshing(false) : setLoading(false); });
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => { setPage(1); }, [debouncedSearch, filterStatus]);

  // Keep ?filter=low in the URL while preserving tab=addons so deep-link
  // round-trips (reload / back / forward) land on the same filtered view.
  useEffect(() => {
    const current = searchParams.get("filter");
    if (filterStatus === "low" && current !== "low") {
      const next = new URLSearchParams(searchParams);
      next.set("filter", "low");
      setSearchParams(next, { replace: true });
    } else if (filterStatus !== "low" && current === "low") {
      const next = new URLSearchParams(searchParams);
      next.delete("filter");
      setSearchParams(next, { replace: true });
    }
  }, [filterStatus, searchParams, setSearchParams]);

  const filtered = useMemo(() => addons.filter((a) => {
    if (filterStatus === "active" && !a.is_active) return false;
    if (filterStatus === "inactive" && a.is_active) return false;
    if (filterStatus === "low") {
      if (!a.is_active) return false;
      if (!isLowStockFn(stockMap[a.id], a.max_qty)) return false;
    }
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      return a.name.toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q);
    }
    return true;
  }), [addons, stockMap, filterStatus, debouncedSearch]);

  const lowStockItems = useMemo(() => findLowStock(addons, stockMap), [addons, stockMap]);

  // Color buckets for the remaining-stock pill. Mirrors owner's logic:
  // out = red, scarce (≤25%) = amber, otherwise emerald. Room-attached
  // fixtures get a neutral slate pill (remaining=0 there just means every
  // carrying room is booked, not a restock signal).
  function stockPillClass(stockRow, maxQty) {
    if (!stockRow) return "bg-slate-100 text-slate-500";
    if (stockRow.is_room_attached) return "bg-slate-100 text-slate-600";
    const remaining = Number(stockRow.remaining);
    if (remaining <= 0) return "bg-rose-100 text-rose-800";
    if (maxQty > 0 && remaining / maxQty <= 0.25) return "bg-amber-100 text-amber-800";
    return "bg-emerald-100 text-emerald-800";
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const paginated  = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  async function toggle(item) {
    setBusyId(item.id);
    try {
      const res = await toggleAddonActive(item.id);
      const updated = res.data?.data ?? { ...item, is_active: !item.is_active };
      setAddons((prev) => prev.map((a) => (a.id === item.id ? { ...a, ...updated } : a)));
      if (viewItem?.id === item.id) setViewItem((v) => ({ ...v, ...updated }));
      showToast(`"${item.name}" ${updated.is_active ? "enabled" : "disabled"}.`, "success");
    } catch (err) {
      showToast(err?.response?.data?.message || "Failed to toggle add-on.", "error");
    } finally {
      setBusyId(null);
    }
  }

  // Entry point for the row's Disable / Enable click. Routes enabling
  // straight through, and gates disabling behind a guard that matches
  // the addon's type.
  function requestToggle(item) {
    if (!item.is_active) { toggle(item); return; }
    const s = stockMap[item.id];
    if (s?.is_room_attached) {
      setFixtureBlocked({ ...item, rooms_count: s.rooms_count ?? 0 });
      return;
    }
    const allocated = Number(s?.allocated ?? 0);
    setConfirmDisable({ ...item, allocated });
  }

  return (
    <div className="p-6 space-y-6">
      <Toast message={toast} type={toastType} onClose={clearToast} />

      {/* Header card */}
      <div className="bg-white rounded-xl shadow-sm p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2.5">
            <span className="h-9 w-9 rounded-lg bg-success-bg flex items-center justify-center">
              <i className="fas fa-puzzle-piece text-success-fg" aria-hidden="true"></i>
            </span>
            Add-ons Catalog
          </h2>
          <p className="text-sm text-slate-500 mt-1 ml-[46px]">Toggle which add-ons are bookable. Owner controls pricing and inventory.</p>
        </div>
        <button onClick={() => load(true)} disabled={refreshing} type="button"
          aria-label="Refresh add-ons list"
          className="inline-flex items-center gap-2 min-h-11 px-4 text-slate-700 hover:text-slate-900 hover:bg-slate-50 rounded-xl text-sm font-medium transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
          <i className={`fas fa-sync-alt ${refreshing ? "fa-spin" : ""}`} aria-hidden="true"></i>
          <span>Refresh</span>
        </button>
      </div>

      {/* Search + Filter bar */}
      <div className="bg-white rounded-xl shadow-sm p-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1">
          <i className="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm" aria-hidden="true"></i>
          <input ref={searchRef} type="text" aria-label="Search add-ons" placeholder="Search add-ons by name or description..."
            value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-10 py-2.5 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand text-sm placeholder:text-slate-400 transition" />
          {searchTerm && (
            <button onClick={() => { setSearchTerm(""); searchRef.current?.focus(); }} type="button"
              aria-label="Clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center h-11 w-11 rounded-lg text-slate-600 hover:text-slate-800 hover:bg-slate-100 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
              <i className="fas fa-times-circle text-sm" aria-hidden="true"></i>
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Filter add-ons by status">
          {["all", "active", "inactive"].map((f) => (
            <button key={f} onClick={() => setFilterStatus(f)} type="button"
              aria-pressed={filterStatus === f}
              className={`inline-flex items-center justify-center min-h-11 px-4 rounded-lg text-xs font-semibold capitalize transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                filterStatus === f
                  ? "bg-brand text-white focus-visible:ring-brand"
                  : "bg-slate-50 text-slate-700 hover:bg-slate-100 focus-visible:ring-slate-400"
              }`}>
              {f === "all" ? "All" : f === "active" ? "Active" : "Inactive"}
            </button>
          ))}
          <button
            onClick={() => setFilterStatus(filterStatus === "low" ? "all" : "low")}
            disabled={lowStockItems.length === 0 && filterStatus !== "low"}
            type="button"
            aria-pressed={filterStatus === "low"}
            title={lowStockItems.length === 0 ? "Nothing is low on stock right now" : `${lowStockItems.length} add-on${lowStockItems.length === 1 ? "" : "s"} low on stock`}
            className={`inline-flex items-center gap-1.5 justify-center min-h-11 px-4 rounded-lg text-xs font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
              filterStatus === "low"
                ? "bg-amber-100 text-amber-800 ring-1 ring-amber-200 focus-visible:ring-amber-400"
                : "bg-slate-50 text-slate-700 hover:bg-amber-50 hover:text-amber-700 focus-visible:ring-slate-400"
            }`}>
            <i className="fas fa-triangle-exclamation text-[10px]" aria-hidden="true"></i>
            Low Stock
            {lowStockItems.length > 0 && (
              <span className={`ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold tabular-nums ${
                filterStatus === "low" ? "bg-amber-200 text-amber-900" : "bg-amber-500 text-white"
              }`}>
                {lowStockItems.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Inline low-stock banner — same data as the chip count, shown at
          top when something needs attention. Hidden when nothing is low or
          when the filter is already applied. */}
      {lowStockItems.length > 0 && filterStatus !== "low" && (() => {
        const hasOut = lowStockItems.some(a => a.remaining === 0);
        const tone = hasOut
          ? { bar: "bg-rose-50 border-rose-200", icon: "bg-rose-100 text-rose-600", title: "text-rose-900", chip: "bg-rose-100 text-rose-800" }
          : { bar: "bg-amber-50 border-amber-200", icon: "bg-amber-100 text-amber-700", title: "text-amber-900", chip: "bg-amber-100 text-amber-800" };
        return (
          <div className={`rounded-xl border p-4 ${tone.bar} flex items-start gap-3`}>
            <span className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${tone.icon}`}>
              <i className="fas fa-triangle-exclamation" aria-hidden="true"></i>
            </span>
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-semibold ${tone.title}`}>
                {lowStockItems.length} add-on{lowStockItems.length === 1 ? "" : "s"} {hasOut ? "need restocking" : "running low"}
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {lowStockItems.slice(0, 5).map(a => (
                  <span key={a.id} className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium tabular-nums ${tone.chip}`}>
                    <i className={`fas ${a.icon || "fa-tag"} text-[10px]`} aria-hidden="true"></i>
                    {a.name} · {a.remaining} left
                  </span>
                ))}
                {lowStockItems.length > 5 && (
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${tone.chip}`}>
                    +{lowStockItems.length - 5} more
                  </span>
                )}
              </div>
              <p className={`text-[11px] mt-2 ${tone.title} opacity-75`}>
                <i className="fas fa-info-circle text-[10px] mr-1" aria-hidden="true"></i>
                Owner controls inventory — flag these for restock.
              </p>
            </div>
            <button
              onClick={() => setFilterStatus("low")}
              type="button"
              className={`shrink-0 self-start text-xs font-semibold px-3 py-1.5 rounded-lg transition ${tone.chip} hover:brightness-95`}>
              Filter
              <i className="fas fa-filter ml-1.5 text-[10px]" aria-hidden="true"></i>
            </button>
          </div>
        );
      })()}

      {/* Table card */}
      <div className="rounded-2xl bg-white border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <div>
            <p className="text-sm text-slate-600">Total add-ons</p>
            <p className="text-2xl font-semibold text-slate-900">{addons.length}</p>
          </div>
          {(debouncedSearch || filterStatus !== "all") && (
            <span className="text-xs text-slate-500 bg-white px-3 py-1.5 rounded-full border border-slate-200">
              Showing {filtered.length} of {addons.length}
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          {loading ? (
            <AddonsSkeleton />
          ) : loadError && addons.length === 0 ? (
            <div className="px-6 py-16 text-center" role="alert">
              <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-danger-bg mb-4">
                <i className="fas fa-exclamation-triangle text-danger-fg text-2xl" aria-hidden="true"></i>
              </div>
              <p className="text-slate-700 font-semibold">Failed to load add-ons</p>
              <p className="text-sm text-slate-400 mt-1 mb-5">Check your connection and try again.</p>
              <button onClick={() => load()} type="button"
                className="inline-flex items-center justify-center gap-2 min-h-11 px-5 py-2.5 bg-brand hover:bg-brand-hover text-white text-sm font-semibold rounded-xl shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
                <i className="fas fa-redo text-xs" aria-hidden="true"></i>Retry
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-slate-100 mb-4">
                <i className="fas fa-puzzle-piece text-slate-300 text-2xl" aria-hidden="true"></i>
              </div>
              <p className="text-slate-500 font-medium">
                {filterStatus === "low"
                  ? "Nothing is low on stock right now."
                  : debouncedSearch || filterStatus !== "all"
                    ? "No add-ons match your search."
                    : "No add-ons yet."}
              </p>
              {(debouncedSearch || filterStatus !== "all") && (
                <button onClick={() => { setSearchTerm(""); setFilterStatus("all"); }} type="button"
                  className="mt-4 text-sm text-brand hover:text-brand-dark font-medium">
                  <i className="fas fa-times mr-1.5" aria-hidden="true"></i>Clear filters
                </button>
              )}
            </div>
          ) : (
            <table className="min-w-full text-sm text-slate-700">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
                <tr>
                  <th className="px-6 py-3 text-left">Name</th>
                  <th className="px-6 py-3 text-left">Price</th>
                  <th className="px-6 py-3 text-left">Allocated</th>
                  <th className="px-6 py-3 text-left">Max Qty</th>
                  <th className="px-6 py-3 text-left">Remaining</th>
                  <th className="px-6 py-3 text-left">Type</th>
                  <th className="px-6 py-3 text-left">Status</th>
                  <th className="px-6 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {/* Same restructure as RoomsTab — drop role="button" +
                    nested toggle button. Open the modal via a clearly
                    labeled View button; the toggle lives in the modal
                    where admin already takes deliberate action. */}
                {paginated.map((item, idx) => (
                  <tr key={item.id}
                    className={`transition-all ${idx % 2 === 1 ? "bg-slate-50/50" : ""} ${!item.is_active ? "opacity-60" : ""}`}>
                    <td className="px-6 py-4 font-medium text-slate-900">
                      <span className="flex items-center gap-2.5">
                        <span className="h-8 w-8 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                          <i className={`fas ${item.icon || "fa-tag"} text-slate-500 text-sm`} aria-hidden="true"></i>
                        </span>
                        {item.name || <span className="italic text-slate-400">Unnamed</span>}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="font-semibold text-slate-800">{"₱"}{Number(item.price).toLocaleString()}</span>
                    </td>
                    <td className="px-6 py-4 tabular-nums">
                      {stockMap[item.id]
                        ? <span className="text-slate-700">{stockMap[item.id].allocated}</span>
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-6 py-4 tabular-nums">{item.max_qty}</td>
                    <td className="px-6 py-4">
                      {stockMap[item.id] ? (
                        <>
                          <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold tabular-nums ${stockPillClass(stockMap[item.id], item.max_qty)}`}>
                            {stockMap[item.id].remaining}
                          </span>
                          {stockMap[item.id].is_room_attached && (
                            <span className="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-700" title="Room-attached fixture — not tracked against the shared pool">
                              <i className="fas fa-link text-[9px]" aria-hidden="true"></i>Fixture
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span className="inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">
                        {item.per_booking ? "Per Booking" : "Per Item"}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${
                        item.is_active ? "bg-success-bg text-success-fg" : "bg-danger-bg text-danger-fg"
                      }`}>
                        <span className={`h-2 w-2 rounded-full ${item.is_active ? "bg-success-ring" : "bg-danger-ring"}`} aria-hidden="true" />
                        {item.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => requestToggle(item)}
                          disabled={busyId === item.id}
                          aria-label={`${item.is_active ? "Disable" : "Enable"} ${item.name}`}
                          title={item.is_active ? "Disable this add-on" : "Enable this add-on"}
                          className={`inline-flex items-center justify-center h-11 min-w-[44px] px-3 rounded-lg text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                            item.is_active
                              ? "text-warning-fg bg-warning-bg hover:opacity-90 focus-visible:ring-amber-500"
                              : "text-success-fg bg-success-bg hover:opacity-90 focus-visible:ring-emerald-500"
                          }`}>
                          <i className={`fas ${busyId === item.id ? "fa-spinner fa-spin" : item.is_active ? "fa-toggle-off" : "fa-toggle-on"} mr-1.5 text-xs`} aria-hidden="true"></i>
                          {item.is_active ? "Disable" : "Enable"}
                        </button>
                        <button type="button" onClick={() => setViewItem(item)}
                          aria-label={`View ${item.name}`}
                          className="inline-flex items-center justify-center h-11 min-w-[44px] px-3 rounded-lg text-sm font-medium text-brand hover:bg-info-bg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
                          <i className="fas fa-eye mr-1.5 text-xs" aria-hidden="true"></i>View
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination — 44×44 touch targets per WCAG 2.5.5 */}
        {!loading && filtered.length > 0 && totalPages > 1 && (
          <nav aria-label="Add-ons pagination" className="px-6 py-4 border-t border-slate-200 flex items-center justify-between">
            <p className="text-sm text-slate-500">
              Showing {(safePage - 1) * PAGE_SIZE + 1}{"–"}{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
            </p>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1} type="button"
                aria-label="Previous page"
                className="h-11 w-11 rounded-lg border border-slate-300 flex items-center justify-center text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
                <i className="fas fa-chevron-left text-sm" aria-hidden="true"></i>
              </button>
              {getPageNumbers(safePage, totalPages).map((n, i) =>
                n === "..." ? (
                  <span key={`d-${i}`} className="h-11 min-w-[2.75rem] flex items-center justify-center text-sm text-slate-500" aria-hidden="true">…</span>
                ) : (
                  <button key={n} onClick={() => setPage(n)} type="button"
                    aria-label={`Page ${n}`}
                    aria-current={n === safePage ? "page" : undefined}
                    className={`h-11 min-w-[2.75rem] rounded-lg text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                      n === safePage ? "bg-brand text-white shadow-sm focus-visible:ring-brand" : "border border-slate-300 text-slate-700 hover:bg-slate-50 focus-visible:ring-slate-400"
                    }`}>
                    {n}
                  </button>
                )
              )}
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages} type="button"
                aria-label="Next page"
                className="h-11 w-11 rounded-lg border border-slate-300 flex items-center justify-center text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
                <i className="fas fa-chevron-right text-sm" aria-hidden="true"></i>
              </button>
            </div>
          </nav>
        )}
      </div>

      {/* View Add-on Modal */}
      <Modal open={!!viewItem} onClose={() => setViewItem(null)} maxWidth="max-w-sm" label={viewItem ? `Add-on details — ${viewItem.name}` : 'Add-on details'}>
        {viewItem && (
          <>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2.5">
                <span className="h-9 w-9 rounded-xl bg-success-bg flex items-center justify-center">
                  <i className={`fas ${viewItem.icon || "fa-tag"} text-success-fg`} aria-hidden="true"></i>
                </span>
                {viewItem.name || <span className="italic text-slate-400">Unnamed</span>}
              </h3>
              <button onClick={() => setViewItem(null)} aria-label="Close add-on details" type="button"
                className="h-11 w-11 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-600 hover:text-slate-800 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
                <i className="fas fa-times" aria-hidden="true"></i>
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-3.5">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="h-6 w-6 rounded-md bg-emerald-100 flex items-center justify-center">
                      <i className="fas fa-peso-sign text-emerald-600 text-[10px]" aria-hidden="true"></i>
                    </span>
                    <span className="text-[10px] font-semibold text-emerald-600 uppercase tracking-wide">Price</span>
                  </div>
                  <p className="text-lg font-bold text-emerald-800">{"₱"}{Number(viewItem.price).toLocaleString()}</p>
                </div>
                <div className="rounded-xl bg-sky-50 border border-sky-100 p-3.5">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="h-6 w-6 rounded-md bg-sky-100 flex items-center justify-center">
                      <i className="fas fa-boxes-stacked text-sky-600 text-[10px]" aria-hidden="true"></i>
                    </span>
                    <span className="text-[10px] font-semibold text-sky-600 uppercase tracking-wide">Max Qty</span>
                  </div>
                  <p className="text-lg font-bold text-sky-800">{viewItem.max_qty}</p>
                </div>
              </div>

              {/* Live stock snapshot — visibility only; admin asks owner
                  to restock, can't change max_qty themselves. */}
              {stockMap[viewItem.id] && (() => {
                const s = stockMap[viewItem.id];
                const low = !s.is_room_attached && isLowStockFn(s, viewItem.max_qty);
                const out = !s.is_room_attached && Number(s.remaining) <= 0;
                const remTone = out
                  ? { bg: "bg-rose-50 border-rose-100", label: "text-rose-600", value: "text-rose-800" }
                  : low
                    ? { bg: "bg-amber-50 border-amber-100", label: "text-amber-600", value: "text-amber-800" }
                    : s.is_room_attached
                      ? { bg: "bg-slate-50 border-slate-200", label: "text-slate-500", value: "text-slate-700" }
                      : { bg: "bg-emerald-50 border-emerald-100", label: "text-emerald-600", value: "text-emerald-800" };
                return (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-indigo-50 border border-indigo-100 p-3.5">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="h-6 w-6 rounded-md bg-indigo-100 flex items-center justify-center">
                          <i className="fas fa-chart-line text-indigo-600 text-[10px]" aria-hidden="true"></i>
                        </span>
                        <span className="text-[10px] font-semibold text-indigo-600 uppercase tracking-wide">Allocated</span>
                      </div>
                      <p className="text-lg font-bold text-indigo-800 tabular-nums">{s.allocated}</p>
                    </div>
                    <div className={`rounded-xl border p-3.5 ${remTone.bg}`}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="h-6 w-6 rounded-md bg-white/60 flex items-center justify-center">
                          <i className={`fas fa-cube ${remTone.label} text-[10px]`} aria-hidden="true"></i>
                        </span>
                        <span className={`text-[10px] font-semibold ${remTone.label} uppercase tracking-wide`}>Remaining</span>
                      </div>
                      <p className={`text-lg font-bold tabular-nums ${remTone.value}`}>{s.remaining}</p>
                      {s.is_room_attached && (
                        <p className="text-[10px] text-slate-500 mt-1">Fixture — reflects room bookings</p>
                      )}
                      {!s.is_room_attached && (out || low) && (
                        <p className={`text-[10px] mt-1 ${remTone.label}`}>Flag to owner for restock</p>
                      )}
                    </div>
                  </div>
                );
              })()}

              {viewItem.description && (
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wide">Description</p>
                  <p className="text-sm text-slate-700 mt-0.5">{viewItem.description}</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wide">Type</p>
                  <p className="font-semibold text-slate-900 mt-0.5">{viewItem.per_booking ? "Per Booking" : "Per Item"}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wide">Status</p>
                  <p className={`font-semibold mt-0.5 ${viewItem.is_active ? "text-success-fg" : "text-danger-fg"}`}>
                    {viewItem.is_active ? "Active" : "Inactive"}
                  </p>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-between gap-3">
              <button type="button" onClick={() => requestToggle(viewItem)} disabled={busyId === viewItem.id}
                aria-label={viewItem.is_active ? `Disable ${viewItem.name}` : `Enable ${viewItem.name}`}
                className={`inline-flex items-center justify-center gap-2 min-h-11 px-4 rounded-xl text-sm font-semibold transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                  viewItem.is_active
                    ? "bg-warning-bg text-warning-fg hover:opacity-90 focus-visible:ring-amber-500"
                    : "bg-success-bg text-success-fg hover:opacity-90 focus-visible:ring-emerald-500"
                }`}>
                <i className={`fas ${viewItem.is_active ? "fa-toggle-off" : "fa-toggle-on"} text-xs`} aria-hidden="true"></i>
                {viewItem.is_active ? "Disable" : "Enable"}
              </button>
              <button onClick={() => setViewItem(null)} type="button"
                className="inline-flex items-center justify-center min-h-11 px-4 border border-slate-300 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
                Close
              </button>
            </div>
          </>
        )}
      </Modal>

      {/* Soft confirm — shared-pool addon with potential in-flight impact.
          Explains that existing bookings keep their charge and new guests
          won't see it going forward. */}
      <ConfirmDialog
        open={!!confirmDisable}
        variant="warning"
        title={`Disable "${confirmDisable?.name ?? ''}"?`}
        message={
          confirmDisable ? (
            <div className="space-y-2">
              {confirmDisable.allocated > 0 ? (
                <p>
                  <strong className="text-slate-900">{confirmDisable.allocated}</strong>{" "}
                  active booking{confirmDisable.allocated === 1 ? "" : "s"} already {confirmDisable.allocated === 1 ? "has" : "have"} this add-on. Their charges won't change.
                </p>
              ) : (
                <p>No active bookings use this add-on right now.</p>
              )}
              <p className="text-slate-600">
                New guests won't see it in the booking picker until it's enabled again.
              </p>
            </div>
          ) : null
        }
        confirmLabel="Disable"
        cancelLabel="Keep active"
        onConfirm={() => {
          const item = confirmDisable;
          setConfirmDisable(null);
          if (item) toggle(item);
        }}
        onCancel={() => setConfirmDisable(null)}
      />

      {/* Hard block — room-attached fixture. Disabling here has NO effect
          on the per-room package auto-attach (handled by owner's room
          editor + the room_addons pivot), so we route admin there instead
          of pretending the toggle did something. */}
      <ConfirmDialog
        open={!!fixtureBlocked}
        variant="info"
        title="Can't disable from here"
        message={
          fixtureBlocked ? (
            <div className="space-y-2">
              <p>
                <strong className="text-slate-900">{fixtureBlocked.name}</strong> is bundled with{" "}
                <strong className="text-slate-900">{fixtureBlocked.rooms_count}</strong> room{fixtureBlocked.rooms_count === 1 ? "" : "s"} as a fixture.
              </p>
              <p className="text-slate-600">
                Disabling it here won't stop those rooms from auto-attaching it to new bookings. Ask the owner to remove it from each carrying room first.
              </p>
            </div>
          ) : null
        }
        confirmLabel="Got it"
        cancelLabel="Close"
        onConfirm={() => setFixtureBlocked(null)}
        onCancel={() => setFixtureBlocked(null)}
      />
    </div>
  );
}

function AddonsSkeleton() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading add-ons…</span>
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
          <tr>
            <th className="px-6 py-3 text-left">Name</th>
            <th className="px-6 py-3 text-left">Price</th>
            <th className="px-6 py-3 text-left">Allocated</th>
            <th className="px-6 py-3 text-left">Max Qty</th>
            <th className="px-6 py-3 text-left">Remaining</th>
            <th className="px-6 py-3 text-left">Type</th>
            <th className="px-6 py-3 text-left">Status</th>
            <th className="px-6 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {Array.from({ length: 5 }).map((_, i) => (
            <tr key={i} className="animate-pulse">
              <td className="px-6 py-4"><div className="h-4 bg-slate-200 rounded w-3/4"></div></td>
              <td className="px-6 py-4"><div className="h-4 bg-slate-200 rounded w-16"></div></td>
              <td className="px-6 py-4"><div className="h-4 bg-slate-200 rounded w-10"></div></td>
              <td className="px-6 py-4"><div className="h-4 bg-slate-200 rounded w-10"></div></td>
              <td className="px-6 py-4"><div className="h-4 bg-slate-200 rounded w-12"></div></td>
              <td className="px-6 py-4"><div className="h-4 bg-slate-200 rounded w-20"></div></td>
              <td className="px-6 py-4"><div className="h-4 bg-slate-200 rounded w-16"></div></td>
              <td className="px-6 py-4 text-right"><div className="h-8 w-16 bg-slate-200 rounded-lg inline-block"></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
