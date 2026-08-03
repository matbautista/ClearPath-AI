import { useEffect, useState } from "react";
import { api, ApiError, type Settings } from "./api";
import { SettingsContext } from "./SettingsContext";
import { SetupPage } from "./pages/SetupPage";
import { LoginPage } from "./pages/LoginPage";
import { AccountsPage } from "./pages/AccountsPage";
import { TransactionsPage } from "./pages/TransactionsPage";

type Phase = "loading" | "setup" | "login" | "app";
type Page = "accounts" | "transactions";

function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [page, setPage] = useState<Page>("accounts");

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
        <span className="app-brand">ClearPath AI</span>
        <div className="app-nav-links">
          <button className={page === "accounts" ? "nav-active" : "nav-link"} onClick={() => setPage("accounts")}>
            Accounts
          </button>
          <button className={page === "transactions" ? "nav-active" : "nav-link"} onClick={() => setPage("transactions")}>
            Transactions
          </button>
        </div>
        <button className="nav-link" onClick={handleLogout}>
          Log out
        </button>
      </nav>
      {page === "accounts" ? <AccountsPage /> : <TransactionsPage />}
    </SettingsContext.Provider>
  );
}

export default App;
