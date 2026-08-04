# Running ClearPath AI locally

## Start it

Double-click **`start.bat`** in this folder. It builds the client and server,
then starts the app, printing your PC's LAN IP addresses and something like:

```
Starting ClearPath AI...
  - On this PC:            http://127.0.0.1:4000
  - On phone/tablet (same Wi-Fi): http://THE-IP-ABOVE:4000
```

Open the `127.0.0.1` URL on this PC, or the LAN IP URL from another device on
the same Wi-Fi. Log in with your passphrase. If this is the first run,
Windows Firewall may prompt to allow `node.exe` through — choose **Private
networks** only, then Allow.

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

`start.bat` binds the server to `0.0.0.0`, so it's reachable from any device
on your Wi-Fi (phone, tablet, another PC) at `http://<your-PC's-LAN-IP>:4000`
— the addresses `start.bat` prints at startup. Only devices on your local
network can reach it; it's not exposed to the internet unless your router is
specifically configured to forward the port (routers don't do this by
default).

**There is no HTTPS in front of this.** Your login passphrase and session
cookie cross your Wi-Fi in plaintext on every request. On a trusted home
network this is a manageable risk, but anyone else who can see your Wi-Fi
traffic (another device on the same network, a compromised router, a public
or shared network) can too. If you want that closed, put a reverse proxy
(e.g. Caddy or Tailscale) providing TLS in front of the app — ask if you
want that set up.

If you'd rather go back to loopback-only (no LAN access, no plaintext
exposure), edit `start.bat` and delete the `set HOST=0.0.0.0` line — the
server defaults to `127.0.0.1` on its own.

## After I push code updates

```
git pull
```

then run `start.bat` again — it rebuilds from the latest source every time,
so you don't need to do anything else. Note: since sessions are stored in
memory (not the database), restarting the server always logs you out — log
back in with your passphrase after every restart.
