import { useState, useEffect, useCallback } from "react";
import { Helmet } from "react-helmet-async";
import Toast, { useToast } from "../../components/ui/Toast";
import ConfirmDialog from "../../components/ui/ConfirmDialog.jsx";
import { getAdminSettings, updateAdminSettings } from "../../lib/adminApi";

const PRICING_FIELDS = [
  {
    key:         "entrance_fee_day",
    label:       "Entrance Fee — Day (7AM–5PM)",
    description: "Per guest for daytime visits.",
    icon:        "fa-sun",
    prefix:      "₱",
    suffix:      "/ head",
    step:        1,
  },
  {
    key:         "entrance_fee_night",
    label:       "Entrance Fee — Night (6PM–6AM)",
    description: "Per guest for nighttime visits.",
    icon:        "fa-moon",
    prefix:      "₱",
    suffix:      "/ head",
    step:        1,
  },
  {
    key:         "entrance_fee_24hr",
    label:       "Entrance Fee — 24 Hours",
    description: "Per guest for full-day (24-hour) visits. Shared by both AM (7AM–next 6AM) and PM (6PM–next 6PM) variants.",
    icon:        "fa-clock",
    prefix:      "₱",
    suffix:      "/ head",
    step:        1,
  },
  // Per-slot reservation fee percentages. Owner can set any slot to 100
  // to require payment in full at booking (no balance due at check-in).
  // Entrance fees are NEVER included in the upfront amount — they stay
  // per-pax at the gate regardless of these percentages.
  {
    key:         "reservation_fee_pct_day",
    label:       "Online Reservation Fee — Day",
    description: "Percentage charged online when the guest books a Day slot. Set to 100 to require full payment at booking.",
    icon:        "fa-sun",
    prefix:      "",
    suffix:      "%",
    step:        1,
  },
  {
    key:         "reservation_fee_pct_night",
    label:       "Online Reservation Fee — Night",
    description: "Percentage charged online when the guest books a Night slot. Set to 100 to require full payment at booking.",
    icon:        "fa-moon",
    prefix:      "",
    suffix:      "%",
    step:        1,
  },
  {
    key:         "reservation_fee_pct_24hr",
    label:       "Online Reservation Fee — 24 Hours",
    description: "Percentage charged online when the guest books a 24-hour slot (both AM and PM variants). Set to 100 to require full payment at booking.",
    icon:        "fa-clock",
    prefix:      "",
    suffix:      "%",
    step:        1,
  },
];

export default function OwnerSettings() {
  const [toast, showToast, clearToast, toastType] = useToast();

  const [settings,    setSettings]    = useState({});
  const [draft,       setDraft]       = useState({});
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [dirty,       setDirty]       = useState(false);
  const [loadError,   setLoadError]   = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  /* ---------- beforeunload guard (#6) ---------- */
  useEffect(() => {
    if (!dirty) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  /* ---------- load ---------- */
  const load = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    getAdminSettings()
      .then(r => {
        const map = {};
        (r.data.data || []).forEach(s => { map[s.key] = s.value; });
        setSettings(map);
        setDraft({ ...map });
        setDirty(false);
        setLoadError(false);
        // If the API returns an updated_at, use it
        const first = (r.data.data || [])[0];
        if (first?.updated_at) {
          setLastUpdated(new Date(first.updated_at));
        }
      })
      .catch(() => {
        setLoadError(true);
        showToast("Failed to load settings.", "error");
      })
      .finally(() => setLoading(false));
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  /* ---------- handlers ---------- */
  // Save flow: form submit → requestSave (validates + opens confirm)
  // → user confirms → handleSave (does the API call). Pricing
  // settings are high-stakes — they affect every future booking's
  // total + entrance fee — so a confirm dialog gates the commit.
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);

  function handleChange(key, val) {
    setDraft(d => ({ ...d, [key]: val }));
    setDirty(true);
  }

  function requestSave(e) {
    e.preventDefault();
    // Validate before opening the confirm so the dialog only appears
    // for a submittable form. Same field-level checks that handleSave
    // used to do up-front; they're surfaced here as toasts and bail.
    for (const f of PRICING_FIELDS) {
      const v = Number(draft[f.key]);
      if (isNaN(v) || v < 0) {
        showToast(`"${f.label}" must be a non-negative number.`, "error");
        return;
      }
      // Per-slot reservation percentages must be 1-100. 0 would mean
      // "book for free" — not supported. Entrance fees skip this check
      // (they're just non-negative numbers).
      if (/^reservation_fee_pct/.test(f.key) && (v < 1 || v > 100)) {
        showToast(`"${f.label}" must be between 1 and 100.`, "error");
        return;
      }
    }
    setSaveConfirmOpen(true);
  }

  async function handleSave() {
    // Validation already ran in requestSave before opening the
    // confirm dialog — no need to re-validate here. Going straight
    // to the API call.
    setSaveConfirmOpen(false);
    setSaving(true);
    try {
      // Only submit the pricing keys the UI actually controls. Posting
      // Object.entries(draft) would include every row GET /settings returned
      // (content, config, etc.) at their stale snapshot values, and the
      // backend accepts any existing settings.key — so saving pricing here
      // could silently roll back unrelated settings edited elsewhere.
      const pricingKeys = PRICING_FIELDS.map(f => f.key);
      const payload = pricingKeys
        .filter(key => draft[key] !== undefined)
        .map(key => ({ key, value: String(draft[key]) }));
      const r = await updateAdminSettings(payload);
      const map = {};
      (r.data.data || []).forEach(s => { map[s.key] = s.value; });
      setSettings(map);
      setDraft({ ...map });
      setDirty(false);
      setLastUpdated(new Date());
      showToast("Pricing settings have been updated.", "success");
    } catch (err) {
      showToast(err?.response?.data?.message || "Failed to save settings.", "error");
    } finally {
      setSaving(false);
    }
  }

  /* ---------- confirm before discard (#11) ---------- */
  function handleDiscard() {
    if (!window.confirm("Discard all unsaved changes?")) return;
    setDraft({ ...settings });
    setDirty(false);
  }

  /* ---------- preview helpers ---------- */
  // Walks the owner through each slot's upfront/balance split using a
  // sample room rate so they can see the impact of changing a % live.
  const SAMPLE_ROOM_RATE = 1500;
  const PREVIEW_PAX = 4;
  const feeDay    = Number(draft.entrance_fee_day   ?? 0);
  const feeNight  = Number(draft.entrance_fee_night ?? 0);
  const fee24hr   = Number(draft.entrance_fee_24hr  ?? 0);
  const pctDay    = Number(draft.reservation_fee_pct_day   ?? 0);
  const pctNight  = Number(draft.reservation_fee_pct_night ?? 0);
  const pct24hr   = Number(draft.reservation_fee_pct_24hr  ?? 0);

  function slotPreview(roomRate, pct, entranceFee) {
    const upfront = Math.round(roomRate * (pct / 100));
    const balance = Math.max(0, roomRate - upfront);
    const entranceAtGate = entranceFee * PREVIEW_PAX;
    return { upfront, balance, entranceAtGate, fullyPaid: pct >= 100 };
  }
  const prevDay   = slotPreview(SAMPLE_ROOM_RATE, pctDay,   feeDay);
  const prevNight = slotPreview(SAMPLE_ROOM_RATE, pctNight, feeNight);
  const prev24hr  = slotPreview(SAMPLE_ROOM_RATE, pct24hr,  fee24hr);

  /* ---------- render ---------- */
  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">

      {/* #2 — Toast at top */}
      <Toast message={toast} type={toastType} onClose={clearToast} />

      {/* #5 — Helmet */}
      <Helmet><title>Pricing — Aplaya Beach Resort</title></Helmet>

      {/* #3 — Page heading with icon-badge */}
      <div>
        <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2.5">
          <span className="h-9 w-9 rounded-lg bg-violet-100 flex items-center justify-center">
            <i className="fas fa-sliders-h text-violet-600" aria-hidden="true"></i>
          </span>
          Pricing
        </h2>
        <p className="text-sm text-slate-500 mt-1">
          Configure resort-wide pricing that applies to all guest bookings made through the website.
        </p>
      </div>

      {/* #4 — loadError retry banner */}
      {loadError && !loading && (
        <div className="rounded-xl bg-rose-50 border border-rose-200 px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3 text-rose-700">
            <i className="fas fa-exclamation-triangle" aria-hidden="true"></i>
            <span className="text-sm font-medium">Failed to load settings.</span>
          </div>
          <button onClick={load} className="text-sm font-semibold text-rose-600 hover:text-rose-700 flex items-center gap-1.5">
            <i className="fas fa-redo text-xs" aria-hidden="true"></i>Retry
          </button>
        </div>
      )}

      {/* #7 — Loading skeleton */}
      {loading ? (
        <div className="rounded-2xl bg-white border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50">
            <div className="h-5 w-48 bg-slate-200 rounded animate-pulse"></div>
          </div>
          <div className="divide-y divide-slate-100">
            {[1,2,3,4,5].map(i => (
              <div key={i} className="px-6 py-5 flex flex-col md:flex-row md:items-center gap-4 animate-pulse">
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-slate-200"></div>
                    <div className="h-4 w-32 bg-slate-200 rounded"></div>
                  </div>
                  <div className="h-3 w-56 bg-slate-100 rounded ml-9"></div>
                </div>
                <div className="md:w-52 h-9 bg-slate-200 rounded-xl"></div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <form onSubmit={requestSave} className="space-y-5">

          {/* Pricing card — #8 violet accent */}
          <div className="rounded-2xl bg-white border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-center gap-2">
              <i className="fas fa-tags text-violet-500" aria-hidden="true"></i>
              <h2 className="font-semibold text-slate-800">Pricing Configuration</h2>
            </div>

            <div className="divide-y divide-slate-100">
              {PRICING_FIELDS.map(field => (
                <div key={field.key} className="px-6 py-5 flex flex-col md:flex-row md:items-center gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="w-7 h-7 rounded-lg bg-violet-50 flex items-center justify-center text-violet-500 text-xs">
                        <i className={`fas ${field.icon}`} aria-hidden="true"></i>
                      </span>
                      <p className="font-medium text-slate-800 text-sm">{field.label}</p>
                    </div>
                    <p className="text-xs text-slate-400 ml-9">{field.description}</p>
                  </div>

                  <div className="flex items-center gap-2 md:w-52">
                    {field.prefix && (
                      <span className="text-slate-500 font-medium text-sm">{field.prefix}</span>
                    )}
                    <input
                      type="number"
                      min={0}
                      max={/^reservation_fee_pct/.test(field.key) ? 100 : undefined}
                      step={field.step}
                      value={draft[field.key] ?? ""}
                      onChange={e => handleChange(field.key, e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 text-right"
                    />
                    {field.suffix && (
                      <span className="text-slate-500 text-sm whitespace-nowrap">{field.suffix}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Info banner */}
          <div className="rounded-2xl bg-amber-50 border border-amber-200 p-5 flex gap-3 text-sm text-amber-800">
            <i className="fas fa-info-circle mt-0.5 text-amber-500 shrink-0" aria-hidden="true"></i>
            <div>
              <p className="font-semibold mb-1">These values are live</p>
              <p>
                Room rates are locked in at booking time — existing bookings keep the rate they were booked at.
                Entrance fees and reservation-fee percentage reflect the current setting, so changes here apply
                to new bookings and to any check-ins that haven't collected the gate fee yet.
              </p>
            </div>
          </div>

          {/* Preview — per-slot upfront/balance split. Updates live as the
              owner types new percentages so they see the impact before
              saving. Sample uses a ₱1,500 room × 4 pax. */}
          <div className="rounded-2xl bg-white border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50">
              <h2 className="font-semibold text-slate-800 text-sm">Per-Slot Payment Preview</h2>
              <p className="text-xs text-slate-400">
                Sample: ₱{SAMPLE_ROOM_RATE.toLocaleString()} room, {PREVIEW_PAX} guests. Entrance always charged per-pax at the gate.
              </p>
            </div>
            <div className="divide-y divide-slate-100 text-sm">
              {[
                { label: 'Day slot',       icon: 'fa-sun',   pct: pctDay,   preview: prevDay   },
                { label: 'Night slot',     icon: 'fa-moon',  pct: pctNight, preview: prevNight },
                { label: '24-hour slot (AM + PM share this rate)', icon: 'fa-clock', pct: pct24hr, preview: prev24hr  },
              ].map(({ label, icon, pct, preview }) => (
                <div key={label} className="px-6 py-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-semibold text-slate-800">
                      <i className={`fas ${icon} text-violet-500`} aria-hidden="true"></i>
                      {label}
                    </div>
                    {preview.fullyPaid && (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                        <i className="fas fa-check-circle text-[10px]" aria-hidden="true"></i>
                        Pay in full at booking
                      </span>
                    )}
                  </div>
                  <div className="ml-6 space-y-1 text-slate-600">
                    <div className="flex justify-between">
                      <span>Upfront ({pct}%)</span>
                      <span className="font-semibold text-slate-900">₱{preview.upfront.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Balance at check-in</span>
                      <span className={preview.balance > 0 ? "text-slate-700" : "text-emerald-600"}>
                        ₱{preview.balance.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs text-slate-400">
                      <span>Entrance at gate ({PREVIEW_PAX} × ₱{Number(preview.entranceAtGate / PREVIEW_PAX).toLocaleString()})</span>
                      <span>₱{preview.entranceAtGate.toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-1">
            {dirty && (
              <button
                type="button"
                onClick={handleDiscard}
                className="px-4 py-2 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50"
              >
                Discard
              </button>
            )}
            <button
              type="submit"
              disabled={saving || !dirty}
              className="inline-flex items-center gap-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white px-5 py-2 rounded-xl text-sm font-medium"
            >
              {saving ? (
                <><i className="fas fa-spinner fa-spin" aria-hidden="true"></i> Saving...</>
              ) : (
                <><i className="fas fa-save" aria-hidden="true"></i> Save Changes</>
              )}
            </button>
          </div>

          {/* #10 — Last updated timestamp */}
          {lastUpdated && (
            <p className="text-xs text-slate-400 text-right mt-2">
              Last saved {lastUpdated.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })}
            </p>
          )}
        </form>
      )}

      {/* Pricing settings affect every future booking — confirm
          before committing so an accidental keystroke doesn't
          re-price tomorrow's check-ins. */}
      <ConfirmDialog
        open={saveConfirmOpen}
        title="Save pricing settings?"
        message="These rates apply to every new booking from now on. Existing bookings keep their saved totals."
        confirmLabel="Save"
        variant="warning"
        onConfirm={handleSave}
        onCancel={() => setSaveConfirmOpen(false)}
      />
    </div>
  );
}

function PreviewRow({ label, value, note, highlight }) {
  return (
    <div className={`flex justify-between ${highlight ? "text-orange-600" : ""}`}>
      <span>{label}{note && <span className="ml-1 text-xs text-slate-400">({note})</span>}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
