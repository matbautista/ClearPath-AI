# Running ClearPath AI locally

## Start it

Double-click **`start.bat`** in this folder. It builds the client and server,
then starts the app. Once the console shows:

```
[server] ClearPath AI listening on http://127.0.0.1:4000
```

open that URL in your browser. Log in with your passphrase.

## Stop it

Close the console window `start.bat` opened (or press Ctrl+C in it). The app
only runs while that window is open — nothing is left running in the
background.

## Where your data lives

Everything is in the `data/` folder:

- `data/clearpath.db` — your accounts, transactions, goals, everything. This
  is the file that matters.
- `data/master.key` — only present if you've enabled AI Analysis; encrypts
  your stored API key. Losing it just means re-entering your API key in
  Settings, not losing financial data.

**Back up `data/clearpath.db` periodically** (copy it somewhere else — an
external drive, cloud storage, wherever you'd trust a backup) — there's no
automatic backup built in.

## Access

The server only binds to `127.0.0.1` (this machine) — it's not reachable
from your phone or any other device on your network, even if your firewall
allows it. This is deliberate: there's no HTTPS in front of it, so keeping
it loopback-only means your passphrase and session cookie never leave the
machine.

If you later want LAN access, that needs more than flipping a setting — you'd
want a reverse proxy (e.g. Caddy or Tailscale) providing TLS in front of it
first, since otherwise your login passphrase would cross your Wi-Fi in
plaintext. Ask if you want that set up.

## After I push code updates

```
git pull
```

then run `start.bat` again — it rebuilds from the latest source every time,
so you don't need to do anything else. Note: since sessions are stored in
memory (not the database), restarting the server always logs you out — log
back in with your passphrase after every restart.
