import { useState } from "react";
import ConfirmDialog from "../components/ui/ConfirmDialog.jsx";

// Shared guard for enable/disable style actions.
//
// Usage:
//   const { request: requestToggle, dialog: toggleDialog } = useToggleConfirm();
//   ...
//   <button onClick={() => requestToggle({
//     shouldConfirm: code.is_active,                // only confirm the "off" direction
//     perform: () => toggleActive(code),            // runs after confirm (or immediately)
//     title: `Deactivate "${code.code}"?`,
//     message: <>Guests won't see this promo at checkout. You can reactivate anytime.</>,
//     confirmLabel: "Deactivate",
//     variant: "warning",
//   })} />
//   ...
//   {toggleDialog}
//
// Enabling / restoring something is near-always safe (it brings back what was
// already configured), so the pattern here is: pages pass shouldConfirm=true
// only when flipping from a visible/active state to hidden/inactive. The hook
// stays policy-free beyond that so every surface can write copy that fits.
export default function useToggleConfirm() {
  const [pending, setPending] = useState(null);

  function request(opts) {
    if (!opts || typeof opts.perform !== "function") return;
    if (!opts.shouldConfirm) {
      opts.perform();
      return;
    }
    setPending(opts);
  }

  const dialog = (
    <ConfirmDialog
      open={!!pending}
      variant={pending?.variant ?? "warning"}
      title={pending?.title ?? "Confirm"}
      message={pending?.message ?? null}
      confirmLabel={pending?.confirmLabel ?? "Confirm"}
      cancelLabel={pending?.cancelLabel ?? "Cancel"}
      onConfirm={() => {
        const p = pending;
        setPending(null);
        p?.perform();
      }}
      onCancel={() => setPending(null)}
    />
  );

  return { request, dialog };
}
