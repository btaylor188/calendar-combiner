# Calendar Combiner

A Linux desktop app that shows several Outlook / Microsoft 365 calendars in one week view.
Meetings that double-book you across accounts are marked in red. Each account also gets a
tab running the real Outlook on the web, so you can reply to invites and edit events there.

It was built for people with several Microsoft 365 accounts (contractors, consultants, MSPs)
who only had desktop Outlook for seeing them all at once, and whose tenants don't allow
calendar publishing or third-party app consent.

## How it works

- Each account has its own isolated, persistent browser session (`persist:acct-<id>`),
  so several sign-ins coexist. You sign in on Microsoft's own page, MFA included.
- A hidden window per account opens Outlook's week view, moves to the weeks you're looking at
  with Outlook's own previous/next week buttons (Outlook ignores dates in the address), checks
  the week shown in its toolbar, and reads each event's accessibility label
  ("Standup, 9:00 AM to 9:15 AM, Monday, …").
- Nothing calls Microsoft APIs directly, and no app registration or tenant consent is involved.
  The app only reads what Outlook on the web shows you.
- Event data stays on your machine: in memory and in a cache under the app's data folder.
- Weeks refresh when they're more than 15 minutes old, and the next three weeks refresh in the
  background every 15 minutes. **↻** (or **R**) re-reads the weeks on screen right away.

## Limitations

- **Passkeys and security keys don't work inside the app.** Electron has no passkey dialog on
  Linux, so the app reports passkeys as unavailable and Microsoft offers password + MFA instead.
- Outlook must be set to English (US or UK date order, 12- or 24-hour times).
- Times are read as Outlook shows them, in the mailbox's time zone. Keep each account's Outlook
  time zone the same as your computer's.
- When Microsoft changes Outlook on the web, reading may break. The app shows an error banner
  rather than an empty calendar.
- If the tenant only allows managed or compliant devices, sign-in is blocked just as it would be
  in any browser.

## Install

Download the `.flatpak` from the [latest release](https://github.com/btaylor188/calendar-combiner/releases/latest), then:

```sh
flatpak install --user calendar-combiner-*-x86_64.flatpak
flatpak run io.github.btaylor188.CalendarCombiner
```

The runtime and Electron base app come from Flathub. If Flathub isn't set up for your user, run
`flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo` first.

## Build from source

Needs Node 22 and flatpak-builder (`flatpak install flathub org.flatpak.Builder`).

```sh
npm install
npm test        # label parser tests
npm run dist    # Electron bundle -> dist/linux-unpacked
cd flatpak
flatpak run org.flatpak.Builder --user --install-deps-from=flathub --disable-rofiles-fuse \
  --force-clean --repo=repo build-dir io.github.btaylor188.CalendarCombiner.yml
flatpak build-bundle repo ../calendar-combiner.flatpak io.github.btaylor188.CalendarCombiner
flatpak install --user ../calendar-combiner.flatpak
flatpak run io.github.btaylor188.CalendarCombiner
```

Add an account with **+** in the left rail. Its tab opens so you can sign in, and its
meetings start appearing in the combined view within a minute or so.

## Development

Try the UI without signing in (fake accounts, no network):

```sh
npx electron . --demo --no-sandbox
```

`--no-sandbox` is only needed when Ubuntu blocks Chromium's development sandbox helper. The
Flatpak build sandboxes normally.

Test the sync engine against a mock of Outlook's week view:

```sh
mkdir -p /tmp/mock/calendar/view/week && cp test/mock/index.html /tmp/mock/calendar/view/week/
(cd /tmp/mock && python3 -m http.server 8777 --bind 127.0.0.1) &
CC_OUTLOOK_BASE=http://127.0.0.1:8777 npx electron test/mock/run.js --no-sandbox
```

## When something looks wrong

The last read for each account is saved here:

```
~/.var/app/io.github.btaylor188.CalendarCombiner/config/Calendar Combiner/diagnostics/<account-id>.json
```

After a successful read it includes your events' labels, so keep it local. After a failure it
holds only page structure: toolbar text and button names. Use it to adjust
`src/main/parse.js` or `src/main/sync.js`, and add the new label shape to `test/parse.test.js`.

---

Not affiliated with or endorsed by Microsoft. Outlook and Microsoft 365 are trademarks of
Microsoft Corporation.

Released under the [MIT License](LICENSE).
