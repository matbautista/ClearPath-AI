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

**LAN access needs HTTPS in front of it, or login won't work.** The session
cookie is only ever sent over a secure connection when the server isn't
bound to loopback — so if you access it via the LAN IP over plain HTTP,
the browser will refuse to store the cookie: you'll appear to log in, then
immediately bounce back to the login screen. This is deliberate — it fails
closed instead of quietly sending your passphrase and session cookie across
the Wi-Fi in plaintext, where anyone else who can see that traffic (another
device on the same network, a compromised router, a public or shared
network) could too.

To actually use it from another device, put a reverse proxy (e.g. Caddy or
Tailscale) providing TLS in front of the app — ask if you want that set up.
Access from `127.0.0.1` on the same PC always works over plain HTTP, since
that traffic never leaves the machine.

If you don't need LAN access, edit `start.bat` and delete the
`set HOST=0.0.0.0` line — the server defaults to `127.0.0.1` on its own.

## Moving to another machine

Two ways to do this, depending on how you're transferring the folder:

**Copying the folder as-is** (drag-and-drop, zip, external drive) — this
just works. Copy the whole `ClearPath AI` folder, including `node_modules/`
and `data/`, onto the new machine and run `start.bat`. Nothing in
`node_modules` is tied to the old machine's architecture (the server
deliberately uses Node's built-in SQLite instead of a natively-compiled
one, specifically to stay portable this way), so no reinstall is needed —
you just need Node.js installed on the new machine (this app needs Node 22
or newer).

**Cloning from git instead** — this needs two extra steps first, because
`node_modules/`, `dist/`, and `data/` are all deliberately excluded from
git (see `.gitignore`) and won't come down with `git clone`/`git pull`:

1. Install dependencies once, from inside the project folder:
   ```
   npm --prefix client install
   npm --prefix server install
   ```
   `start.bat` only *builds* (`npm run build`), it never installs — skipping
   this step is why a fresh clone's first `start.bat` run fails immediately
   with a missing `tsc`/`vite` error.
2. Decide what to do about data, since a fresh clone has none: either run
   Setup again for a brand-new empty instance, or manually copy
   `data/clearpath.db` (and `data/master.key`, if you have AI Analysis set
   up) from the old machine's `data/` folder into the new one.

Either way, **your data folder holds your real financial data and the key
protecting your AI Analysis API key** — if you're moving it between
machines, use an encrypted transport (encrypted drive, direct transfer),
not an unencrypted cloud upload.

## After I push code updates

```
git pull
```

then run `start.bat` again — it rebuilds from the latest source every time,
so you don't need to do anything else. Note: since sessions are stored in
memory (not the database), restarting the server always logs you out — log
back in with your passphrase after every restart.
