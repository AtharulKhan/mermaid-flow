import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./firebase/AuthContext";
import App from "./App";
import AuthPage from "./components/AuthPage";
import Dashboard from "./components/Dashboard";
import UserSettings from "./components/UserSettings";
import { applyTheme, getStoredTheme } from "./themeUtils";
import "./styles.css";

// Apply theme before first render to prevent flash
applyTheme(getStoredTheme());

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="dash-loading">
        <div className="brand-mark">MF</div>
        <p>Loading...</p>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AuthRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Navigate to="/dashboard" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <AuthRoute>
            <AuthPage />
          </AuthRoute>
        }
      />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <UserSettings />
          </ProtectedRoute>
        }
      />
      <Route
        path="/editor/template/:templateId"
        element={
          <ProtectedRoute>
            <App />
          </ProtectedRoute>
        }
      />
      <Route
        path="/editor/:flowId"
        element={
          <ProtectedRoute>
            <App />
          </ProtectedRoute>
        }
      />
      {/* Public share route: read/comment/edit access controlled by Firestore rules */}
      <Route path="/flow/:flowId" element={<App />} />
      {/* Legacy route: editor without flow ID (local mode) */}
      <Route path="/editor" element={<App />} />
      {/* Embed route: no auth required */}
      <Route path="/embed" element={<App />} />
      {/* Default: redirect to dashboard if logged in, else login */}
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  </React.StrictMode>
);
