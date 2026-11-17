import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { GoogleOAuthProvider } from "@react-oauth/google";
import App from "./App.jsx";
import "./index.css";
import { AuthProvider } from "./context/AuthContext.jsx";
import { ContentProvider } from "./context/ContentContext.jsx";
import ScrollToTop from "./components/ScrollToTop.jsx";

// GoogleOAuthProvider throws "Missing required parameter client_id" if we
// pass an empty string. LoginModal + SignupModal call the google-oauth hooks
// unconditionally, so skipping the provider isn't an option either. Fall
// back to a harmless placeholder so local dev (no Google env var configured)
// still boots; prod sets VITE_GOOGLE_CLIENT_ID in Vercel, so the real id is
// used there. An actual Google button click without a real id fails quietly
// at Google's end, which is the correct local-dev behavior.
const GOOGLE_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  "local-dev-no-google.apps.googleusercontent.com";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <HelmetProvider>
        <BrowserRouter>
          <ScrollToTop />
          <AuthProvider>
            <ContentProvider>
              <App />
            </ContentProvider>
          </AuthProvider>
        </BrowserRouter>
      </HelmetProvider>
    </GoogleOAuthProvider>
  </React.StrictMode>
);