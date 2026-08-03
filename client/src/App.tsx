import { useEffect, useState } from "react";
import { api, ApiError, setUnauthorizedHandler, type Settings } from "./api";
import { SettingsContext } from "./SettingsContext";
import { SetupPage } from "./pages/SetupPage";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { AccountsPage } from "./pages/AccountsPage";
import { TransactionsPage } from "./pages/TransactionsPage";
import { GoalsPage } from "./pages/GoalsPage";
import { RecurringPage } from "./pages/RecurringPage";
import { AiAssistPage } from "./pages/AiAssistPage";
import { SettingsPage } from "./pages/SettingsPage";
import clearPathIcon from "./assets/clearpath-icon.png";

type Phase = "loading" | "setup" | "login" | "app";
type Page = "dashboard" | "accounts" | "transactions" | "goals" | "recurring" | "ai-assist" | "settings";

function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [page, setPage] = useState<Page>("dashboard");

  async function resolveAuthState() {
    const { configured } = await api.settingsStatus();
    if (!configured) {
      setPhase("setup");
      return;
    }
    try {
      const me = await api.me();
      setSettings(me);
      setPhase("app");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setPhase("login");
      } else {
        throw err;
      }
    }
  }

  useEffect(() => {
    resolveAuthState();
    // Any page's API call can 401 (session expired / server restarted) —
    // bounce back to Login instead of letting the page silently show an
    // empty list with no explanation.
    setUnauthorizedHandler(() => {
      setSettings(null);
      setPhase("login");
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  async function handleAuthenticated() {
    const me = await api.me();
    setSettings(me);
    setPhase("app");
  }

  async function handleLogout() {
    await api.logout();
    setSettings(null);
    setPhase("login");
  }

  if (phase === "loading") return null;
  if (phase === "setup") return <SetupPage onComplete={handleAuthenticated} />;
  if (phase === "login") return <LoginPage onComplete={handleAuthenticated} />;

  return (
    <SettingsContext.Provider value={settings}>
      <nav className="app-nav">
        <img src={clearPathIcon} alt="ClearPath AI" className="app-brand-logo" />
        <div className="app-nav-links">
          <button className={page === "dashboard" ? "nav-active" : "nav-link"} onClick={() => setPage("dashboard")}>
            Dashboard
          </button>
          <button className={page === "accounts" ? "nav-active" : "nav-link"} onClick={() => setPage("accounts")}>
            Accounts
          </button>
          <button className={page === "transactions" ? "nav-active" : "nav-link"} onClick={() => setPage("transactions")}>
            Transactions
          </button>
          <button className={page === "goals" ? "nav-active" : "nav-link"} onClick={() => setPage("goals")}>
            Goals
          </button>
          <button className={page === "recurring" ? "nav-active" : "nav-link"} onClick={() => setPage("recurring")}>
            Recurring
          </button>
          <button className={page === "ai-assist" ? "nav-active" : "nav-link"} onClick={() => setPage("ai-assist")}>
            AI Assist
          </button>
        </div>
        <button className={page === "settings" ? "nav-active" : "nav-link"} onClick={() => setPage("settings")}>
          Settings
        </button>
        <button className="nav-link" onClick={handleLogout}>
          Log out
        </button>
      </nav>
      {page === "dashboard" && <DashboardPage />}
      {page === "accounts" && <AccountsPage />}
      {page === "transactions" && <TransactionsPage />}
      {page === "goals" && <GoalsPage />}
      {page === "recurring" && <RecurringPage />}
      {page === "ai-assist" && <AiAssistPage />}
      {page === "settings" && <SettingsPage />}
    </SettingsContext.Provider>
  );
}

export default App;
