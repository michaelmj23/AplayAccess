import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";

import { useAuth } from "../context/AuthContext.jsx";
import useLockBodyScroll from "../hooks/useLockBodyScroll.js";
import useFocusTrap from "../hooks/useFocusTrap.js";
import { useContent, DEFAULT_NAVBAR } from "../context/ContentContext.jsx";

import LoginModal from "./modals/LoginModal.jsx";
import SignupModal from "./modals/SignupModal.jsx";
import VerifyEmailModal from "./modals/VerifyEmailModal.jsx";
import Toast, { useToast } from "./ui/Toast.jsx";
import ConfirmDialog from "./ui/ConfirmDialog.jsx";

// Keep in sync with RequireAuth.jsx + StaffLogin.jsx. If a new staff role
// appears anywhere, add it here or they'll be left stranded on the public
// page after signing in via the Navbar's Login modal.
const STAFF_ROLE_REDIRECTS = { front_desk: "/frontdesk", admin: "/admin", owner: "/owner" };

export default function Navbar() {
  const { user, login, logout } = useAuth();
  const navigate = useNavigate();
  const [toast, showToast, clearToast, toastType] = useToast();

  const [loginOpen,  setLoginOpen]  = useState(false);
  const [signupOpen, setSignupOpen] = useState(false);
  const [menuOpen,   setMenuOpen]   = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  // Opened immediately after a fresh (unverified) signup. Google
  // signups skip this — backend marks them verified since Google
  // confirmed the email.
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [pendingWelcomeName, setPendingWelcomeName] = useState("");

  const siteContent = useContent();
  const brand = siteContent?.page_navbar
    ? { ...DEFAULT_NAVBAR, ...siteContent.page_navbar }
    : DEFAULT_NAVBAR;

  useLockBodyScroll(loginOpen || signupOpen || menuOpen);

  // Focus trap + Escape-to-close for the mobile slide-out menu.
  // Without these, keyboard users could Tab out of the open menu
  // back into the page underneath, and there was no Escape exit.
  const mobileMenuRef = useFocusTrap(menuOpen);
  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e) { if (e.key === "Escape") setMenuOpen(false); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  function handleLoginSuccess(u) {
    login(u);
    setLoginOpen(false);
    showToast(`Welcome back, ${u?.name || ""}!`, "success");
    // Staff/owner/admin shouldn't be left stranded on the public page —
    // send them to their portal. Guests stay where they are.
    const dest = STAFF_ROLE_REDIRECTS[u?.role];
    if (dest) navigate(dest);
  }

  function requestLogout() {
    setMenuOpen(false);        // close mobile menu if open
    setConfirmLogout(true);
  }

  async function confirmLogoutNow() {
    const name = user?.name;
    setConfirmLogout(false);
    await logout();
    showToast(name ? `See you next time, ${name}!` : "You've been signed out.", "success");
  }

  function handleSignupSuccess(u) {
    login(u);
    setSignupOpen(false);
    // Verified signups (Google) go straight to a welcome toast.
    // Unverified signups (email+password) see the OTP modal right
    // away — the welcome toast fires when they close it.
    if (u?.email_verified_at) {
      showToast(`Welcome, ${u?.name || ""}!`, "success");
      // Google sign-up that resolved to an existing staff/owner account:
      // send them to their portal instead of leaving them on the public page.
      const dest = STAFF_ROLE_REDIRECTS[u?.role];
      if (dest) navigate(dest);
    } else {
      setPendingWelcomeName(u?.name || "");
      setVerifyOpen(true);
    }
  }

  return (
    <nav className="fixed w-full z-40 bg-white shadow-sm">
      <div className="max-w-7xl mx-auto px-4 h-16 flex justify-between items-center gap-2">
        {/* Logo — routes to / (Home). Convention is that the brand
            lockup always takes users back to the site root; previously
            this pointed at /resort, which made clicking the logo a
            no-op when the user was already on the resort page and
            hid the Home route entirely.
            min-w-0 + flex-1 lets the brand text shrink/truncate on
            narrow viewports instead of pushing Book Now + hamburger
            off-screen. The brand text drops from text-xl to text-base
            below md to free more space, and the logo image gets a
            shrink-0 so the icon never collapses to 0px. */}
        <Link to="/" className="flex items-center gap-2 min-w-0 flex-1 md:flex-none rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" aria-label={`${brand.siteName} home`}>
          {brand.logoImage
            ? <img src={brand.logoImage} alt="" className="h-8 w-auto object-contain shrink-0" loading="eager" decoding="async" />
            : <span className="text-2xl shrink-0" aria-hidden="true">🏖️</span>
          }
          {/* Brand text hides below 380px (iPhone SE class) so the Book Now
              button + hamburger don't force a truncated "Aplaya Beach Re…".
              The logo image still identifies the site at those widths. */}
          <span className="hidden min-[380px]:inline text-base md:text-xl font-bold text-sky-600 truncate">{brand.siteName}</span>
        </Link>

        {/* Desktop Navigation */}
        <div className="hidden md:flex items-center gap-4">
          {/* py-2 -my-2 keeps the visual rhythm tight while
              providing a 32-pt+ vertical hit slot per link with
              a focus-visible ring for keyboard users.
              Active-page gets a sky-600 color + underline so
              users always know which section they're in.
              aria-current="page" is set automatically by NavLink
              on the active link for assistive tech. */}
          {[
            { to: "/",        label: "Home" },
            { to: "/resort",  label: "Resort" },
            { to: "/rooms",   label: "Rooms" },
            { to: "/gallery", label: "Gallery" },
          ].map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `text-sm font-medium py-2 -my-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 border-b-2 ${
                  isActive
                    ? "text-sky-600 border-sky-600"
                    : "text-gray-700 hover:text-sky-600 border-transparent"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}

          {user ? (
            <>
              <NavLink
                to="/dashboard"
                className={({ isActive }) =>
                  `text-sm font-medium py-2 -my-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 border-b-2 ${
                    isActive
                      ? "text-sky-600 border-sky-600"
                      : "text-gray-700 hover:text-sky-600 border-transparent"
                  }`
                }
              >
                My Account
              </NavLink>
              <button onClick={requestLogout} className="text-sm font-medium text-red-700 hover:text-red-800 py-2 -my-2 px-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500" type="button">Logout</button>
            </>
          ) : (
            <button onClick={() => setLoginOpen(true)} className="text-gray-700 hover:text-sky-600 text-sm font-medium py-2 -my-2 px-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" type="button">Login</button>
          )}

          <Link
            to={user ? "/dashboard?book=1" : "/resort?book=1"}
            className="bg-sky-600 hover:bg-sky-700 text-white px-4 py-2 rounded-md text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
          >
            Book Now
          </Link>
        </div>

        {/* Mobile hamburger */}
        <div className="flex items-center gap-3 md:hidden">
          <Link
            to={user ? "/dashboard?book=1" : "/resort?book=1"}
            className="bg-sky-600 hover:bg-sky-700 text-white px-4 h-11 inline-flex items-center rounded-md text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
          >
            Book Now
          </Link>
          <button
            onClick={() => setMenuOpen((s) => !s)}
            className="h-11 w-11 flex items-center justify-center text-gray-700 hover:text-sky-600 hover:bg-gray-100 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="navbar-mobile-menu"
            type="button"
          >
            <i className={`fas ${menuOpen ? "fa-times" : "fa-bars"} text-xl`} aria-hidden="true"></i>
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div
          ref={mobileMenuRef}
          id="navbar-mobile-menu"
          role="dialog"
          aria-modal="true"
          aria-label="Site navigation"
          tabIndex={-1}
          className="md:hidden bg-white border-t shadow-lg focus:outline-none"
        >
          <div className="px-4 py-3 space-y-1" onClick={() => setMenuOpen(false)}>
            {[
              { to: "/",        label: "Home",    icon: "fa-home" },
              { to: "/resort",  label: "Resort",  icon: "fa-umbrella-beach" },
              { to: "/rooms",   label: "Rooms",   icon: "fa-bed" },
              { to: "/gallery", label: "Gallery", icon: "fa-images" },
            ].map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  `block px-3 py-3 rounded-lg text-sm font-medium ${
                    isActive
                      ? "bg-sky-50 text-sky-700"
                      : "text-gray-700 hover:bg-gray-100"
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <i className={`fas ${item.icon} w-5 text-center mr-2 ${isActive ? "text-sky-600" : "text-gray-400"}`} aria-hidden="true"></i>
                    {item.label}
                  </>
                )}
              </NavLink>
            ))}

            <div className="border-t border-gray-100 my-2"></div>

            {user ? (
              <>
                <NavLink
                  to="/dashboard"
                  className={({ isActive }) =>
                    `block px-3 py-3 rounded-lg text-sm font-medium ${
                      isActive
                        ? "bg-sky-50 text-sky-700"
                        : "text-gray-700 hover:bg-gray-100"
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <i className={`fas fa-user w-5 text-center mr-2 ${isActive ? "text-sky-600" : "text-gray-400"}`} aria-hidden="true"></i>
                      My Account
                    </>
                  )}
                </NavLink>
                <button
                  onClick={requestLogout}
                  className="w-full text-left px-3 py-3 rounded-lg text-red-600 hover:bg-red-50 text-sm font-medium"
                  type="button"
                >
                  <i className="fas fa-sign-out-alt w-5 text-center mr-2" aria-hidden="true"></i>Logout
                </button>
              </>
            ) : (
              <button
                onClick={() => { setMenuOpen(false); setLoginOpen(true); }}
                className="w-full text-left px-3 py-3 rounded-lg text-gray-700 hover:bg-gray-100 text-sm font-medium"
                type="button"
              >
                <i className="fas fa-sign-in-alt w-5 text-center mr-2 text-gray-400" aria-hidden="true"></i>Login
              </button>
            )}
          </div>
        </div>
      )}


      {/* Modals */}
      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        onLoginSuccess={handleLoginSuccess}
        onOpenSignup={() => { setLoginOpen(false); setSignupOpen(true); }}
      />

      <SignupModal
        open={signupOpen}
        onClose={() => setSignupOpen(false)}
        onSignedUp={handleSignupSuccess}
        onOpenLogin={() => { setSignupOpen(false); setLoginOpen(true); }}
      />

      <VerifyEmailModal
        open={verifyOpen}
        onClose={() => {
          setVerifyOpen(false);
          if (pendingWelcomeName) {
            showToast(`Welcome, ${pendingWelcomeName}!`, "success");
            setPendingWelcomeName("");
          }
        }}
      />

      <Toast message={toast} type={toastType} onClose={clearToast} />

      <ConfirmDialog
        open={confirmLogout}
        title="Log out?"
        message={user?.name ? `${user.name}, this will end your session.` : "This will end your session."}
        confirmLabel="Log out"
        cancelLabel="Stay signed in"
        variant="warning"
        onConfirm={confirmLogoutNow}
        onCancel={() => setConfirmLogout(false)}
      />
    </nav>
  );
}