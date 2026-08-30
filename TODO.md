# Revelations OS — TODO / Test Matrix

> Revelations OS v1.0.0 | Electron 29 + React 18 | RAXX Beats Studios LLC
> Last updated: 2026-06-04

---

## COMPLETED

### Core Infrastructure
- [x] Electron 29 main process with fullscreen, frameless window
- [x] contextIsolation + nodeIntegration disabled
- [x] webviewTag enabled for Ephesians browser + RAXX live apps
- [x] IPC rate limiter (100 calls/sec per channel)
- [x] CSP headers injected via `onHeadersReceived`
- [x] Navigation guard: blocks external URLs from main window
- [x] `setWindowOpenHandler` blocks popup windows
- [x] Permission request handler (only clipboard-read, notifications, fullscreen allowed)
- [x] `remote-debugging-port 0` (disables DevTools attachment in prod)
- [x] `app.isPackaged` check disables DevTools in packaged build

### Preload / IPC Bridge
- [x] `window.nexus` API exposed via contextBridge
- [x] `nexus.getSystemInfo()` — real CPU, RAM, hostname via Node `os`
- [x] `nexus.scanDirectory(path)` — reads filesystem, restricted to home/Applications/tmp
- [x] `nexus.readFile(path)` — reads files up to 10 MB within home dir only
- [x] `nexus.runProverbs(cmd)` — spawns Proverbs CLI from ~/proverbs with 9s timeout, strips shell metacharacters
- [x] `nexus.checkForUpdate()` / `nexus.applyUpdate()` — stub returning version info
- [x] `nexus.exitOS()` — sends `app:exit` IPC to quit
- [x] `nexus.onNotification(cb)` — IPC listener for main-process push notifications
- [x] `nexus.platform` property

### Zustand Global Store
- [x] `user` state: name, loggedIn, avatar
- [x] `login(name)` / `logout()` — logout resets windows + IDs
- [x] Window lifecycle: `openWindow`, `closeWindow`, `focusWindow`, `minimizeWindow`, `restoreWindow`, `moveWindow`, `resizeWindow`
- [x] Duplicate-window guard: re-focuses if already open; restores if minimized
- [x] Z-index management: each focus increments global nextZ
- [x] Window position cascade: offset by (nextId % 5) * 12, clamped to viewport
- [x] Minimum window size: 320 × 200 px
- [x] Notification store: `addNotification`, `markRead`, `markAllRead`, `clearAll`, `toggleNotificationPanel`
- [x] Orb launcher: `orbLauncherOpen`, `toggleOrbLauncher`
- [x] Exit modal: `openExitModal`, `closeExitModal`
- [x] Subscription modal: `openSubscription(app)`, `closeSubscription()`
- [x] Audit log (500-entry ring buffer): `logAudit(action, detail)`
- [x] `pendingUpdate` / `setPendingUpdate`
- [x] Ephesians browser tabs: `addTab`, `closeTab`, `setActiveTab`, `updateTab`
- [x] Real-time clock tick (1-second interval from Desktop mount)

### Login Screen
- [x] Starfield canvas animation (160 stars, upward drift, random speed/opacity)
- [x] Animated nebula orb blobs (3 blobs, CSS `nebula` keyframe)
- [x] Login card with glass morphism (glass-strong class, scale-in animation)
- [x] Pulsing eye-orb logo with `orbPulse` animation
- [x] Username field (required) + password field (any value accepted in v1)
- [x] Password show/hide toggle (Eye / EyeOff icon)
- [x] Enter key submits from both fields
- [x] Empty username shows error + `animate-shake` on input
- [x] 800ms simulated auth delay with spinner
- [x] Bottom-right clock (h:mm AM/PM + full date)
- [x] Bottom-left version/copyright text
- [x] "AES-256-GCM session encryption" security note

### Desktop
- [x] Dark nebula wallpaper (radial-gradient + 4 animated nebula orb divs)
- [x] Dot-grid overlay (40px spacing, 4% white)
- [x] Desktop right-click context menu: Change Wallpaper, New Folder, Open App Launcher, System Settings
- [x] Click anywhere dismisses context menu
- [x] White orb visible only when zero non-minimized windows
- [x] Desktop widgets (clock, system health, quick notes) visible only when no windows
- [x] Auto-lock after 300 seconds inactivity (mousemove + keydown listeners reset timer)
- [x] Monday update checker (fires on login if `new Date().getDay() === 1`)
- [x] Welcome notification 1.5s after desktop mount

### Top Bar
- [x] Fixed position, 40px height, glass morphism
- [x] `WebkitAppRegion: drag` (native window drag) with `no-drag` exceptions
- [x] App search: button opens dropdown, input filters all 44 apps by name + desc
- [x] Search shows max 8 results
- [x] Search: free apps open directly; paid apps open SubscriptionModal
- [x] Search "no results" message when query matches nothing
- [x] Search "RECENT" quick list shows first 4 free apps when query is empty
- [x] Clear (X) button resets search query
- [x] Escape key closes search dropdown
- [x] Open app indicators: shows up to 8 minimized/open windows as pill buttons
- [x] Focused window pill highlighted with accent purple border + dot
- [x] Click pill: focuses or restores window
- [x] Right-click pill: closes window
- [x] Status icons: Bluetooth, Wifi, Volume2 (cosmetic)
- [x] Battery icon with green color + "78%" hardcoded label
- [x] Notification bell with unread badge (red, "9+" cap)
- [x] Bell click toggles NotificationCenter slide-in panel
- [x] Clock: weekday, short month, day + h:mm AM/PM (mono font)
- [x] User avatar (initials, gradient circle)
- [x] User menu: My Account, System Preferences, Privacy & Security, Sign Out, Exit Revelations OS
- [x] User menu click-outside closes (via React state)

### Window Manager / AppWindow
- [x] AppWindow renders inside absolute-positioned layer starting at y=40
- [x] Title bar: 36px, focused = subtle purple gradient
- [x] Traffic lights: red (close), yellow (minimize), green (maximize)
- [x] Title centered, ellipsis overflow
- [x] Draggable from title bar (not from traffic-light zone)
- [x] Drag clamped: x in [0, vw - width], y in [40, vh - 60]
- [x] Maximize: moves to (0, 40), fills (100vw × (100vh - 40px)), border-radius 0
- [x] Restore from maximize: returns to pre-max position + size
- [x] Maximize disabled during drag (guard on handleTitleMouseDown)
- [x] Resize handle: 16×16 bottom-right corner (se-resize cursor)
- [x] Resize clamped to minimum 320 × 200
- [x] Window right-click context menu: Bring to Front, Maximize/Restore, Minimize, Close
- [x] Click on window body focuses it (raises z-index)
- [x] Focused window: accent border + glow shadow
- [x] Unfocused window: dimmer border + plain shadow
- [x] `animate-scale-in` CSS on window open
- [x] RAXX live apps rendered via `RAXXAppViewer` (webview) when `appId` starts with `raxx_`
- [x] Built-in apps dispatch to `APP_COMPONENTS` map; unknown IDs show placeholder

### Orb Launcher
- [x] White orb button (`orb-btn` class) top-left, only visible on clean desktop
- [x] Click opens full-screen overlay (rgba(4,4,10,0.94) + blur(40px))
- [x] `animate-fade-in` on overlay open
- [x] Close button (X) top-right
- [x] Escape key closes launcher (onKeyDown on search input)
- [x] Header: "Revelations OS" gradient text + subtitle
- [x] Search input autofocused on open
- [x] Category filter row (25 categories + "All"): scrollable, active = accent pill
- [x] App grid: auto-fill columns, 108px min, 16px gap
- [x] Each app card: icon gradient, name (truncated), price badge for paid apps
- [x] Hover: scale(1.06), accent border, purple background
- [x] Free app click: opens window + closes launcher
- [x] Paid app click: opens SubscriptionModal + closes launcher
- [x] Query + category filters combine (AND logic)
- [x] State resets (query + category) on close

### Notification Center
- [x] Slide-in from right, 360px wide, calc(100vh - 40px) tall
- [x] CSS transform transition 0.35s cubic-bezier
- [x] Header: bell icon, "Notifications" label, unread count badge
- [x] "All read" button: marks all as read
- [x] "Clear" button: removes all notifications
- [x] Notifications listed newest-first
- [x] Unread items: purple-left border + subtle background
- [x] Read items: transparent background, no border
- [x] Click notification item marks it read
- [x] Per-item X button marks single notification read
- [x] Relative timestamp (Just now / Xm ago / Xh ago / date)
- [x] Icon + color per type: success (green), warning (amber), error (red), security (purple), info (blue)
- [x] Empty state: faded bell icon + "All clear" text
- [x] Notification types used: welcome (success), screen-lock (security), wallpaper-info (info), new-folder (success), update (info)

### Exit OS Modal
- [x] Fixed overlay z-9999, blur(12px) backdrop
- [x] Glass card: 440px wide, scale-in animation
- [x] Red logout icon in circle
- [x] "Exit Revelations OS" heading + body text
- [x] Cancel button (btn-ghost)
- [x] "Exit OS" button (red gradient) calls `nexus.exitOS()`
- [x] Click outside backdrop closes modal
- [x] Escape key closes modal

### Subscription Modal
- [x] Fixed overlay z-9999, blur(16px) backdrop
- [x] Glass card: 560px wide, max-height 90vh, overflow scroll
- [x] Dynamic hero header: app color gradient, app icon, name, category badge, 5-star rating, description
- [x] "What's included" feature list (5 items per category from `FEATURES_BY_CATEGORY`)
- [x] Pricing block: large price display, trial text (green), Stripe note
- [x] "Launch [App]" button opens RAXX app as live webview window (`raxx_<id>`)
- [x] "Later" button closes modal
- [x] Click outside backdrop closes modal
- [x] Escape key closes modal

### Ephesians Browser
- [x] Multi-tab browser (Electron webview tags)
- [x] Tab bar: active tab highlighted with accent bottom border
- [x] "+" button opens new tab at google.com
- [x] Tab close button; closing last tab opens a fresh tab (no empty state)
- [x] Closing active tab switches to adjacent tab
- [x] Back / Forward / Reload buttons; disabled state when not available
- [x] URL bar: auto-adds https:// for bare domains, falls back to Google search for non-URL strings
- [x] Enter key navigates
- [x] Bookmark toggle (star icon): add/remove current page
- [x] Bookmark drawer (BookmarkCheck opens list)
- [x] Browsing history saved to localStorage (500 entries)
- [x] `did-navigate` + `did-navigate-in-page` update tab URL + title
- [x] `did-fail-load` shows error state inside tab
- [x] Lock icon (green) for HTTPS, Globe icon for HTTP
- [x] Loading spinner in URL bar when loading
- [x] Custom user-agent string (Chrome 122 + Ephesians/1.0)
- [x] `partition="persist:ephesians"` for session isolation
- [x] `webpreferences="allowRunningInsecureContent=no"`

### File Manager
- [x] Quick Access sidebar: Home, Desktop, Documents, Downloads, Music, Pictures, Movies, Applications
- [x] Back / Forward navigation with history array + histIdx pointer
- [x] Refresh button reloads current path
- [x] Breadcrumb path display
- [x] Grid / List view toggle
- [x] Sort by: name-asc, name-desc, size-asc, size-desc, date-asc, date-desc
- [x] Search filters visible entries by name
- [x] File categorization via LocalAI.categorizeFile (emoji icon + category label)
- [x] Dev-mode placeholder entries when `nexus.scanDirectory` unavailable
- [x] Entry right-click context menu (open, copy path, etc.)
- [x] File size formatting (B / KB / MB / GB)
- [x] Modified date formatting

### Settings (17 panels)
- [x] Sidebar with grouped navigation (General, Connectivity, Input, Accessibility, Security, System)
- [x] Active panel: accent left border + purple highlight
- [x] Settings persisted to `localStorage('revos_settings')`
- [x] Appearance: Color Theme (dark/darker/midnight), Accent Color (6 swatches), Wallpaper (nebula/cosmos/aurora/void)
- [x] Display: Brightness slider, Night Mode toggle, Resolution dropdown
- [x] Sound: Output Volume, Input Volume, Sound Effects toggle, Output Device, Input Device dropdowns
- [x] Notifications: Enable Notifications, Notification Sounds, Do Not Disturb toggles
- [x] Bluetooth: toggle, device list with Connect buttons
- [x] Wi-Fi: toggle, network list with Join buttons + connected indicator
- [x] Keyboard: Key Repeat Rate, Delay Until Repeat sliders, Shortcut Hints toggle
- [x] Mouse & Trackpad: Tracking Speed slider, Natural Scrolling, Tap to Click toggles
- [x] Accessibility: Reduce Motion, High Contrast, Large Text, Screen Reader toggles; Color Blind Mode dropdown
- [x] Battery & Power: Sleep After slider, Display Sleep slider, Low Power Mode toggle
- [x] Date & Time: Timezone dropdown (7 zones), 24-Hour Format toggle, Date Format dropdown
- [x] Language & Region: Language (6), Region (7), Currency (6) dropdowns
- [x] Privacy & Security: Firewall toggle, Auto-Lock slider, Show Password Hints toggle; security status panel (5 checks)
- [x] Users: current user card (avatar initial, name, "Administrator" role)
- [x] Storage: bar chart (5 categories), used/free display, per-category breakdown
- [x] Software Update: version display, "Check for Updates" button (1.5s sim delay, "up to date" result)
- [x] About: OS info panel with Electron/Node/Security/Developer/Company/UEI/CAGE metadata

### Terminal
- [x] ASCII banner (REVELATIONS) on open
- [x] Commands: help, clear, neofetch, whoami, date, pwd, ls, echo, history, version, proverbs
- [x] `neofetch` displays CPU/RAM/platform from `window.nexus.platform`
- [x] Command history (up to 100 entries)
- [x] Arrow Up/Down navigates history (histIdx tracking)
- [x] Arrow Down at idx -1 clears input
- [x] Tab autocomplete: fills single suggestion + clears list
- [x] AI autocomplete suggestions via `suggestCommand` (up to 5 shown as clickable pills)
- [x] `proverbs` command: proxies to `nexus.runProverbs`, shows output in `proverbs` color (#38bdf8)
- [x] Running Proverbs: input disabled + amber spinner dot
- [x] Prompt format: `username@revelations-os:~$`
- [x] Color-coded output: banner (purple), input (green), output (light), error (red), system (amber), proverbs (sky)
- [x] Auto-scroll to bottom on new output
- [x] Click anywhere in terminal refocuses input

### Notepad
- [x] Multi-tab editor with tab strip
- [x] "+" button (New Tab) + Ctrl+T keyboard shortcut
- [x] Close tab button; closing last tab resets to blank "Untitled"
- [x] Tab rename: contentEditable span, blur triggers rename
- [x] Unsaved indicator: amber dot on tab
- [x] Autosave to localStorage 800ms after last change
- [x] Tabs loaded from localStorage on mount
- [x] Save (download) via Ctrl+S: creates Blob, triggers anchor download as `.txt`
- [x] Word wrap toggle checkbox
- [x] Font size selector (8 sizes: 11–24px)
- [x] Find bar: Ctrl+F toggle, Escape to close, match count display
- [x] Tab key inserts 2 spaces (prevents focus loss)
- [x] Status bar: current line, word count, character count, line count, "Unsaved" indicator

### PCFixScan
- [x] 4-phase UI: idle, scanning, results, cleaning, done
- [x] Idle: 6 scan category cards + "Start Full Scan" button
- [x] Scanning: animated category icon, progress bar (0–100%), active category highlight pills
- [x] Progress calculated by category weight (weighted sum across 6 steps per category)
- [x] Findings: random-between (deterministic: 0.618 golden ratio) count + size per category
- [x] Anomaly detection via `LocalAI.detectAnomalies` (Z-score on sizes), anomaly badge shown
- [x] Severity: high (>12 items), medium (>6), low (rest) — color-coded badges
- [x] Results: summary cards (issues found / total items / space to free), checkbox list
- [x] All findings pre-selected; individual toggle
- [x] "Re-scan" and "Clean Selected (N)" buttons; clean disabled when 0 selected
- [x] Cleaning: sequential delay per item, real-time log with freed-space amounts
- [x] Done: total freed display, per-category list, "Scan Again" resets all state
- [x] formatBytes helper (KB/MB/GB)

### App Store
- [x] Hero header: title, subtitle, search bar
- [x] Fuzzy search via Fuse.js (keys: name, description, category, threshold 0.4)
- [x] Category filter pills (8 categories)
- [x] Featured section (4 highlighted apps) visible only on "All" + no search
- [x] Featured cards: hover lift + border brighten
- [x] App list rows: icon, name, description, category badge, rating stars, price, Open/Get button
- [x] Open button calls `handleOpen`: free = openWindow, paid = openSubscription
- [x] App detail view: full-screen within window, back button, description, "Subscribe & Open" / "Open App" button
- [x] Stats footer: app count, Enterprise Ready, Instant Access, Live Updates
- [x] "No apps found" empty state

### Celestia Office Suite
- [x] Open button + hidden file input (accepts .doc, .docx, .xls, .xlsx, .csv, .pdf, .ppt, .pptx, .txt, .md)
- [x] Drag-and-drop: DragOver shows purple dashed overlay, Drop triggers handleFile
- [x] Word/DOCX: parsed via mammoth (lazy import), rendered as editable contentEditable div
- [x] Excel/XLSX/CSV: parsed via xlsx (lazy import), rendered as editable table with sheet tabs
- [x] PDF: rendered via pdfjs-dist (lazy import), canvas rendering, page navigation
- [x] PowerPoint: placeholder preview message
- [x] Text/MD: raw text rendered in pre block
- [x] Word toolbar: Bold, Italic, Underline, Align Left/Center/Right, font size selector, text color picker (execCommand)
- [x] Zoom: +10/-10 buttons, range 50–200%, affects font size for word/PDF canvas scale
- [x] PDF pagination: prev/next page, page X of Y display, prev disabled at page 1
- [x] Export: downloads as .html for word/text/ppt files
- [x] Print: calls window.print()
- [x] Status bar: file type, file name, page info (PDF), zoom level
- [x] Loading spinner during file parse
- [x] Error state with "Try Again" button

### RAXX App Viewer (Webview)
- [x] Mini nav bar: Back, Forward, Reload buttons
- [x] URL display bar with lock/globe icon (HTTPS detection)
- [x] Loading spinner in URL bar
- [x] "Live" badge pill
- [x] `partition="persist:raxx_<appId>"` per-app session isolation
- [x] `webpreferences="allowRunningInsecureContent=no"`
- [x] `did-fail-load` shows error state: "App is unreachable" + Retry button
- [x] Reload toggle: shows X (stop) while loading, RotateCcw (reload) when done

### Widgets (Desktop Only)
- [x] Visible only when no non-minimized windows
- [x] Clock widget: HH:MM:SS + full date, 1-second tick
- [x] System Health widget: CPU, Memory, Disk bars, animates every 3 seconds (random delta, clamped)
- [x] Quick Notes widget: persists to localStorage, live save on change

### Design System
- [x] CSS custom properties: bg-primary/secondary/tertiary, bg-glass/glass-strong, border, border-accent, accent, accent-2, accent-gold, text-primary/secondary/muted, blur-heavy, shadow-lg, shadow-glow, transition, font-mono
- [x] `.glass` / `.glass-strong` backdrop-filter classes
- [x] `.btn-primary`, `.btn-ghost`, `.btn-danger` button variants
- [x] `.orb-btn` white orb with drop-shadow glow
- [x] `.traffic-light` 12px circle button
- [x] `.context-menu` / `.context-menu-item` / `.context-menu-separator` / `.context-menu-item.danger`
- [x] `.text-gradient` animated gradient text (accent to blue)
- [x] Animations: fade-in, fade-in-down, scale-in, nebula (float), orbPulse, spin, blink, shake, progress

### App Registry
- [x] 8 system apps (Ephesians, Files, Settings, Terminal, Notepad, PCFixScan, App Store, Celestia)
- [x] 36 RAXX paid/free apps across 23 categories
- [x] `SYSTEM_APPS` + `RAXX_APPS` exports
- [x] Each app: id, name, icon (Lucide name), color, category, free flag, desc, price, trial, liveUrl

---

## TEST MATRIX

> Legend: open the built app at `dist/mac/Revelations.app` for each test.
> Mark [ ] as [x] when verified passing.

---

### LOGIN SCREEN

- [ ] **LGN-01 Starfield renders** — Open app. Confirm 160 animated stars drift upward on canvas behind login card.
- [ ] **LGN-02 Nebula blobs animate** — Confirm 3 blurred glowing orbs slowly pulsate in corners/center.
- [ ] **LGN-03 Clock updates** — Bottom-right clock shows correct local time and increments every second.
- [ ] **LGN-04 Date is correct** — Bottom-right date matches today (weekday, month, day, year).
- [ ] **LGN-05 Empty username blocked** — Leave username blank, click "Sign In." Confirm error "Please enter your name" appears and input shakes.
- [ ] **LGN-06 Any password accepted** — Enter any username + any password (or no password) and click Sign In. Confirm login proceeds after 800ms spinner.
- [ ] **LGN-07 Enter key submits** — In username field, press Enter. In password field, press Enter. Both should submit the form.
- [ ] **LGN-08 Password visibility toggle** — Click the Eye icon. Confirm password text becomes visible. Click again, confirm it hides.
- [ ] **LGN-09 Spinner shows during auth** — Click Sign In. Confirm spinner appears for ~800ms before desktop loads.
- [ ] **LGN-10 Fade transition to desktop** — After login, confirm fade-in animation plays on desktop div.
- [ ] **LGN-11 Version text present** — Confirm "Revelations OS v1.0 © RAXX Beats Studios LLC" in bottom-left.
- [ ] **LGN-12 Security note present** — Confirm "AES-256-GCM session encryption" text + Lock icon below sign-in button.
- [ ] **LGN-13 Orb logo pulses** — Confirm the white/purple orb logo plays `orbPulse` animation continuously.

---

### DESKTOP

- [ ] **DSK-01 Wallpaper renders** — After login, confirm dark nebula radial-gradient background covers full screen.
- [ ] **DSK-02 Dot grid visible** — Confirm faint dot-grid pattern overlaid on wallpaper.
- [ ] **DSK-03 Nebula orbs animate** — Confirm 4 blurred color orbs float with the `nebula` keyframe animation.
- [ ] **DSK-04 Welcome notification fires** — ~1.5s after login, confirm "Welcome to Revelations OS" notification appears in NotificationCenter.
- [ ] **DSK-05 Login notification fires** — Confirm "Welcome back! Logged in as [username]" notification added immediately on login.
- [ ] **DSK-06 Widgets visible on clean desktop** — With no windows open, confirm clock + system health + quick notes widgets appear bottom-right.
- [ ] **DSK-07 Widgets hide when window opens** — Open any app. Confirm all 3 widgets fade out.
- [ ] **DSK-08 Widgets reappear when all windows closed** — Close all windows. Confirm widgets fade back in.
- [ ] **DSK-09 Desktop right-click: menu appears** — Right-click directly on the wallpaper (not on a window or widget). Confirm context menu appears at click position.
- [ ] **DSK-10 Desktop right-click: Change Wallpaper** — Click "Change Wallpaper" in context menu. Confirm notification "Wallpaper options coming soon" fires.
- [ ] **DSK-11 Desktop right-click: New Folder** — Click "New Folder." Confirm "Created on Desktop" notification fires.
- [ ] **DSK-12 Desktop right-click: Open App Launcher** — Click "Open App Launcher." Confirm OrbLauncher overlay opens.
- [ ] **DSK-13 Desktop right-click: System Settings** — Click "System Settings." Confirm Settings window opens.
- [ ] **DSK-14 Click closes context menu** — After opening context menu, click elsewhere on desktop. Confirm menu disappears.
- [ ] **DSK-15 Context menu does NOT appear on windows** — Right-click inside an open app window. Confirm desktop context menu does NOT appear (window context menu appears instead).

---

### AUTO-LOCK

- [ ] **LCK-01 Lock fires after 300s** — Wait 5 minutes without touching mouse or keyboard. Confirm screen returns to LoginScreen and "Screen Locked" security notification is added.
- [ ] **LCK-02 Timer resets on mouse move** — Move the mouse before 300s. Confirm lock does not fire.
- [ ] **LCK-03 Timer resets on keypress** — Press any key before 300s. Confirm lock does not fire.
- [ ] **LCK-04 Logout clears windows** — After auto-lock (or manual sign-out), open Settings again and sign in. Confirm no previously open windows are restored.

---

### TOP BAR

- [ ] **TBR-01 Always visible** — Open multiple windows. Confirm TopBar remains at top, never covered.
- [ ] **TBR-02 Clock updates live** — Observe TopBar clock. Confirm it updates every minute.
- [ ] **TBR-03 Search opens on click** — Click "Search apps..." button. Confirm dropdown panel slides down with autofocused input.
- [ ] **TBR-04 Search shows RECENT apps when empty** — Open search, type nothing. Confirm 4 free system apps listed under "RECENT."
- [ ] **TBR-05 Search filters by name** — Type "Tax" in search. Confirm TaxFlow Pro appears in results.
- [ ] **TBR-06 Search filters by description** — Type "scanner" in search. Confirm PCFixScan (desc: "System Cleaner") or Terminal appears.
- [ ] **TBR-07 Search max 8 results** — Type "a" (matches many apps). Confirm no more than 8 results shown.
- [ ] **TBR-08 Search opens free app** — Search for "Files" and click it. Confirm Files window opens and search closes.
- [ ] **TBR-09 Search opens subscription for paid app** — Search for "TaxFlow" and click. Confirm SubscriptionModal opens.
- [ ] **TBR-10 Search: no results state** — Type "zzzzzzz". Confirm "No apps found" message shows.
- [ ] **TBR-11 Search clear (X) button** — Type a query, click the X. Confirm input clears and results reset.
- [ ] **TBR-12 Search Escape closes** — With search open and text typed, press Escape. Confirm dropdown closes.
- [ ] **TBR-13 App indicator appears** — Open any window. Confirm its pill appears in the top bar indicator row.
- [ ] **TBR-14 App indicator focused state** — The currently focused window's pill should have a purple border and lit dot.
- [ ] **TBR-15 Click indicator focuses window** — Click a non-focused window's indicator pill. Confirm that window comes to front.
- [ ] **TBR-16 Click indicator restores minimized** — Minimize a window. Click its pill in the top bar. Confirm window is restored and focused.
- [ ] **TBR-17 Right-click indicator closes window** — Right-click an app indicator pill. Confirm that window closes.
- [ ] **TBR-18 Max 8 indicators** — Open more than 8 windows (open 9+ distinct apps via OrbLauncher). Confirm only 8 pills shown.
- [ ] **TBR-19 Bell opens notification panel** — Click the bell icon. Confirm NotificationCenter slides in from right.
- [ ] **TBR-20 Bell badge count** — Confirm unread badge number matches unread notification count (red circle, "9+" when > 9).
- [ ] **TBR-21 User menu opens** — Click the user avatar. Confirm dropdown menu appears with username and options.
- [ ] **TBR-22 User menu: My Account** — Click "My Account." Confirm Settings window opens.
- [ ] **TBR-23 User menu: System Preferences** — Click "System Preferences." Confirm Settings window opens.
- [ ] **TBR-24 User menu: Privacy & Security** — Click "Privacy & Security." Confirm PCFixScan window opens.
- [ ] **TBR-25 User menu: Sign Out** — Click "Sign Out." Confirm screen returns to LoginScreen.
- [ ] **TBR-26 User menu: Exit Revelations OS** — Click "Exit Revelations OS." Confirm ExitOSModal opens.

---

### WHITE ORB & LAUNCHER

- [ ] **ORB-01 Orb visible on clean desktop** — With no windows open (or all minimized), confirm white orb is visible top-left with glow pulse.
- [ ] **ORB-02 Orb hidden when windows open** — Open any window. Confirm orb fades out (opacity 0, pointer-events none).
- [ ] **ORB-03 Orb click opens launcher** — Click the orb. Confirm full-screen OrbLauncher overlay opens.
- [ ] **ORB-04 Launcher search autofocuses** — Open launcher. Confirm the search input has focus immediately.
- [ ] **ORB-05 Launcher shows all 44 apps** — With "All" selected and no query, confirm all 44 apps from APP_REGISTRY are visible in the grid.
- [ ] **ORB-06 Launcher search filters apps** — Type "school" in launcher search. Confirm School Manager appears, irrelevant apps filtered out.
- [ ] **ORB-07 Launcher category filter: system** — Click "system" category. Confirm only 8 system apps shown.
- [ ] **ORB-08 Launcher category filter: finance** — Click "finance." Confirm TaxFlow Pro and TradeIQ Desk shown.
- [ ] **ORB-09 Launcher combined filter** — Select "marketing" category, type "cloud." Confirm only CloutKiller/CloutFinder shown.
- [ ] **ORB-10 Free app opens from launcher** — Click "Ephesians" in launcher. Confirm Ephesians browser window opens and launcher closes.
- [ ] **ORB-11 Paid app shows subscription from launcher** — Click "TaxFlow Pro." Confirm SubscriptionModal opens and launcher closes.
- [ ] **ORB-12 Launcher price badge shown** — Paid apps should show a gold price badge (e.g., "$29/mo") on their card.
- [ ] **ORB-13 Launcher hover effect** — Hover over any app card. Confirm scale(1.06), purple background, accent border.
- [ ] **ORB-14 Launcher X button closes** — Click the X button top-right of launcher. Confirm overlay closes.
- [ ] **ORB-15 Launcher Escape closes** — With search focused, press Escape. Confirm launcher closes.
- [ ] **ORB-16 Launcher state resets on close** — Open launcher, type a query, close it, reopen it. Confirm query is cleared and "All" category selected.
- [ ] **ORB-17 Duplicate window not opened** — Ephesians is already open. Click Ephesians in launcher. Confirm second window is NOT created; existing window is focused.

---

### WINDOW MANAGER

- [ ] **WIN-01 Window opens centered** — Open any app. Confirm window appears roughly centered on screen.
- [ ] **WIN-02 Multiple windows cascade** — Open 3 different apps. Confirm each window opens offset from the previous (12px x-offset cascade).
- [ ] **WIN-03 Drag window** — Click and drag the window title bar. Confirm window follows cursor.
- [ ] **WIN-04 Drag clamps at left edge** — Drag window to the far left. Confirm x does not go below 0.
- [ ] **WIN-05 Drag clamps at right edge** — Drag window to the far right. Confirm right edge stays within viewport width.
- [ ] **WIN-06 Drag clamps at top (TopBar)** — Drag window upward. Confirm y does not go above 40px (TopBar height).
- [ ] **WIN-07 Drag clamps at bottom** — Drag window down. Confirm window doesn't scroll below viewport bottom (vh - 60).
- [ ] **WIN-08 Resize via corner handle** — Drag the bottom-right resize handle. Confirm window grows/shrinks smoothly.
- [ ] **WIN-09 Minimum resize: width** — Drag resize to make window very narrow. Confirm width does not go below 320px.
- [ ] **WIN-10 Minimum resize: height** — Drag resize to make window very short. Confirm height does not go below 200px.
- [ ] **WIN-11 Maximize (green button)** — Click the green traffic light. Confirm window fills full viewport below TopBar (x=0, y=40, 100vw, 100vh-40px), border-radius becomes 0.
- [ ] **WIN-12 Restore from maximize** — Click green button again. Confirm window returns to pre-maximize position and size.
- [ ] **WIN-13 Drag disabled when maximized** — Maximize a window, then try to drag its title bar. Confirm window does NOT move.
- [ ] **WIN-14 Resize handle hidden when maximized** — Maximize a window. Confirm the bottom-right resize handle is not visible or interactive.
- [ ] **WIN-15 Minimize (yellow button)** — Click the yellow traffic light. Confirm window disappears from desktop. Confirm its indicator pill remains in TopBar.
- [ ] **WIN-16 Restore from minimize via TopBar** — After minimizing, click the app pill in TopBar. Confirm window reappears and is focused.
- [ ] **WIN-17 Close (red button)** — Click the red traffic light. Confirm window is removed entirely. Confirm TopBar indicator disappears.
- [ ] **WIN-18 Focus changes border** — Click one window's title bar. Confirm it gets accent purple border + glow. Confirm other windows get dim border.
- [ ] **WIN-19 Window context menu: Bring to Front** — Right-click inside a window. Confirm context menu appears. Click "Bring to Front." Confirm window is focused (raised z-index).
- [ ] **WIN-20 Window context menu: Maximize/Restore** — Right-click, click "Maximize." Confirm window maximizes. Right-click again, click "Restore." Confirm restores.
- [ ] **WIN-21 Window context menu: Minimize** — Right-click, click "Minimize." Confirm window minimizes.
- [ ] **WIN-22 Window context menu: Close Window** — Right-click, click "Close Window." Confirm window closes.
- [ ] **WIN-23 Window context menu dismiss** — Open window context menu, click outside it. Confirm menu closes.
- [ ] **WIN-24 Minimize/maximize cycle** — Minimize a window, restore it, maximize it, restore it, minimize it again, restore it. Confirm no state corruption throughout.
- [ ] **WIN-25 Z-order stacking** — Open windows A, B, C. Click window A. Confirm A is now on top visually (highest zIndex).
- [ ] **WIN-26 Scale-in animation on open** — Open a new window. Confirm `animate-scale-in` plays on the window div.
- [ ] **WIN-27 Unknown app placeholder** — If an appId with no component mapping is opened (e.g., hypothetical test), confirm placeholder "Coming soon" view renders without crash.

---

### NOTIFICATION CENTER

- [ ] **NTF-01 Slide in from right** — Click bell. Confirm panel slides in from right (transform translateX from 100% to 0) within ~350ms.
- [ ] **NTF-02 Slide out** — Click bell again. Confirm panel slides back out to the right.
- [ ] **NTF-03 Notifications in reverse chronological order** — Add multiple notifications. Confirm newest appears at top.
- [ ] **NTF-04 Unread styling** — New (unread) notification has left colored border + purple-tinted background.
- [ ] **NTF-05 Click marks read** — Click an unread notification. Confirm border and background clear (read state).
- [ ] **NTF-06 Per-item X marks read** — Click the X button on a notification. Confirm it is marked read (not deleted).
- [ ] **NTF-07 Mark All Read button** — Add several unread notifications. Click "All read." Confirm all lose the unread style and badge count drops to 0.
- [ ] **NTF-08 Clear button removes all** — Click "Clear." Confirm notification list is empty and "All clear" state shows.
- [ ] **NTF-09 Empty state shows** — With 0 notifications, confirm faded bell + "All clear" text is centered in the panel.
- [ ] **NTF-10 Badge count accurate** — Confirm TopBar bell badge equals number of unread notifications. Goes to "9+" when > 9 unread.
- [ ] **NTF-11 Notification types display correctly** — Verify icon/color: success = green CheckCircle, warning = amber AlertTriangle, error = red XCircle, security = purple Shield, info = blue Info.
- [ ] **NTF-12 Relative timestamp** — A new notification shows "Just now." After 2 min, shows "2m ago."
- [ ] **NTF-13 Panel does not block window interaction** — Open notification panel while a window is open. Confirm you can still click on the app window (panel is 360px from right, apps are behind it but accessible if not overlapping).

---

### EXIT OS MODAL

- [ ] **EXT-01 Opens from user menu** — User menu → "Exit Revelations OS." Confirm modal opens.
- [ ] **EXT-02 Blur backdrop** — Confirm blur(12px) backdrop darkens the desktop behind the modal.
- [ ] **EXT-03 Red icon + heading** — Confirm red LogOut icon in circle, "Exit Revelations OS" heading visible.
- [ ] **EXT-04 Cancel button closes modal** — Click "Cancel." Confirm modal closes, desktop resumes.
- [ ] **EXT-05 Click outside closes modal** — Click the backdrop outside the card. Confirm modal closes.
- [ ] **EXT-06 Escape closes modal** — With modal open, press Escape. Confirm it closes.
- [ ] **EXT-07 Exit OS button quits** — Click "Exit OS." Confirm `nexus.exitOS()` is called (app quits in packaged build; in dev, no crash).
- [ ] **EXT-08 Scale-in animation** — Confirm `animate-scale-in` plays on the modal card when it opens.

---

### SUBSCRIPTION MODAL

- [ ] **SUB-01 Opens for paid app** — Click any paid app (e.g., TaxFlow Pro) in OrbLauncher. Confirm SubscriptionModal opens.
- [ ] **SUB-02 App header correct** — Confirm app name, icon, category badge, description match the selected app.
- [ ] **SUB-03 5-star rating shown** — Confirm 5 filled gold stars in the header.
- [ ] **SUB-04 Feature list populated** — Confirm 5 feature bullets listed under "What's included" (category-matched or default).
- [ ] **SUB-05 Price displayed** — Confirm app price shown (e.g., "$29/mo").
- [ ] **SUB-06 Trial text shown** — For apps with trial (e.g., "14 days"), confirm green "✓ 14 days free trial — no credit card required" text appears.
- [ ] **SUB-07 Launch button opens webview window** — Click "Launch [App]." Confirm a new window opens with `appId: raxx_<id>` containing a webview pointing to the app's liveUrl.
- [ ] **SUB-08 Later button closes modal** — Click "Later." Confirm modal closes without opening anything.
- [ ] **SUB-09 Click outside closes** — Click backdrop. Confirm modal closes.
- [ ] **SUB-10 Escape closes** — Press Escape. Confirm modal closes.
- [ ] **SUB-11 Dynamic color theming** — Each app's header gradient uses its unique color from APP_REGISTRY. Open TaxFlow (blue) and LegalVault (slate) — confirm different header tints.
- [ ] **SUB-12 Enterprise apps show correct trial** — Open FEMA Platform (trial: "Demo"). Confirm trial text says "Demo" not an error.

---

### EPHESIANS BROWSER

- [ ] **EPH-01 Opens with Google** — Open Ephesians. Confirm google.com loads in the webview.
- [ ] **EPH-02 New tab button** — Click "+". Confirm a new tab opens with google.com.
- [ ] **EPH-03 Tab switching** — With multiple tabs, click each tab. Confirm webview switches and URL bar updates.
- [ ] **EPH-04 Close tab** — Click X on a tab. Confirm it closes and active tab switches to adjacent.
- [ ] **EPH-05 Closing last tab creates fresh tab** — With only one tab open, close it. Confirm a new empty tab is created (no empty state).
- [ ] **EPH-06 URL navigation** — Type "github.com" in URL bar, press Enter. Confirm https://github.com loads.
- [ ] **EPH-07 Non-URL falls back to Google search** — Type "best coffee" in URL bar, Enter. Confirm Google search results load.
- [ ] **EPH-08 Back button** — Navigate to a second page, click Back. Confirm previous page loads. Confirm Back disables when at first page.
- [ ] **EPH-09 Forward button** — After going Back, click Forward. Confirm forward navigation works. Confirm Forward disables at latest page.
- [ ] **EPH-10 Reload button** — Click the reload (RotateCcw) button. Confirm page reloads.
- [ ] **EPH-11 Stop button while loading** — Quickly click reload then click the X (stop) button while loading. Confirm load stops.
- [ ] **EPH-12 HTTPS lock icon** — Visit https://google.com. Confirm green lock icon shown in URL bar.
- [ ] **EPH-13 HTTP globe icon** — Visit an http:// URL (if accessible). Confirm globe icon shown instead of lock.
- [ ] **EPH-14 Loading spinner** — Trigger navigation. Confirm spinner appears in URL bar during load, disappears when done.
- [ ] **EPH-15 Bookmark add** — Navigate to a page, click the star (Bookmark) button. Confirm it turns to BookmarkCheck (filled).
- [ ] **EPH-16 Bookmark remove** — On a bookmarked page, click the filled star. Confirm it reverts to outline star.
- [ ] **EPH-17 Bookmark list** — Click BookmarkCheck icon to open bookmark drawer. Confirm bookmarked URLs listed. Click one, confirm navigation.
- [ ] **EPH-18 Bookmarks persist** — Close and reopen Ephesians window. Confirm bookmarks are still present (localStorage).
- [ ] **EPH-19 Tab title updates** — After page fully loads, confirm tab label updates to the page's `<title>`.
- [ ] **EPH-20 Session isolation** — Ephesians uses `partition="persist:ephesians"`. Verify RAXX app webviews use `persist:raxx_<id>` — they should not share cookies.

---

### FILE MANAGER

- [ ] **FLM-01 Opens at home directory** — Open Files. Confirm home directory entries shown (or dev-mode placeholder files).
- [ ] **FLM-02 Quick access sidebar** — Confirm 8 quick-access locations listed (Home, Desktop, Documents, Downloads, Music, Pictures, Movies, Applications).
- [ ] **FLM-03 Navigate by sidebar** — Click "Documents." Confirm path bar updates and directory contents load.
- [ ] **FLM-04 Navigate into folder** — Double-click a folder entry. Confirm directory changes and new contents load.
- [ ] **FLM-05 Back navigation** — Navigate into a subfolder, click Back arrow. Confirm returns to previous directory.
- [ ] **FLM-06 Forward navigation** — After going back, click Forward arrow. Confirm forward navigation works.
- [ ] **FLM-07 Refresh** — Click the refresh icon. Confirm current directory reloads.
- [ ] **FLM-08 Grid view** — Click Grid icon. Confirm files displayed in icon grid.
- [ ] **FLM-09 List view** — Click List icon. Confirm files displayed in table rows with name, size, date columns.
- [ ] **FLM-10 Sort by name** — Select "name-asc" sort. Confirm entries sorted A→Z. Select "name-desc," confirm Z→A.
- [ ] **FLM-11 Sort by size** — Select "size-asc." Confirm smallest files first.
- [ ] **FLM-12 Sort by date** — Select "date-desc." Confirm most recently modified first.
- [ ] **FLM-13 Search filter** — Type part of a filename in the search box. Confirm only matching entries are shown.
- [ ] **FLM-14 Search clear** — Clear search. Confirm all entries return.
- [ ] **FLM-15 File icons** — Different file types should show different emoji icons (📁 folder, 📄 document, 🖼️ image, 🎵 music, etc.) via `categorizeFile`.
- [ ] **FLM-16 File size formatting** — Confirm "1024" bytes shows as "1.0 KB," and large files show in MB or GB.
- [ ] **FLM-17 File right-click context menu** — Right-click a file entry. Confirm context menu appears.
- [ ] **FLM-18 Security boundary** — Confirm navigating to a path outside home/Applications/tmp/Users (e.g., /etc) either errors gracefully or returns empty (IPC guard in main process).

---

### SETTINGS

- [ ] **SET-01 All 17 panels accessible** — Click every item in Settings sidebar. Confirm each panel renders without error.
- [ ] **SET-02 Active panel highlight** — Click "Bluetooth." Confirm accent left-border and purple background on Bluetooth row.
- [ ] **SET-03 Appearance: theme buttons** — Click "darker," then "midnight." Confirm button border/background changes to show selection. Settings persisted to localStorage.
- [ ] **SET-04 Appearance: accent color swatches** — Click each of the 6 color swatches. Confirm selected swatch gets white ring border.
- [ ] **SET-05 Appearance: wallpaper options** — Click "aurora." Confirm button highlights. (Note: wallpaper change on desktop not yet wired—verify selection saves only.)
- [ ] **SET-06 Display: brightness slider** — Drag brightness slider. Confirm numeric label updates (e.g., "75%").
- [ ] **SET-07 Display: Night Mode toggle** — Click Night Mode toggle. Confirm it flips on/off.
- [ ] **SET-08 Display: Resolution dropdown** — Change resolution dropdown. Confirm selection persists.
- [ ] **SET-09 Audio: Volume slider** — Drag Output Volume. Confirm label updates.
- [ ] **SET-10 Audio: Output Device** — Change output device dropdown. Confirm persisted.
- [ ] **SET-11 Audio: Sound Effects toggle** — Toggle Sound Effects. Confirm state flips.
- [ ] **SET-12 Bluetooth: toggle + device list** — Toggle Bluetooth on. Confirm 4 nearby devices appear. Toggle off. Confirm device list hides.
- [ ] **SET-13 Bluetooth: Connect button** — Click "Connect" on a device. Button is present (currently cosmetic — confirm no crash).
- [ ] **SET-14 Wi-Fi: toggle + network list** — Toggle Wi-Fi on. Confirm 4 networks listed. Toggle off. Confirm list hides.
- [ ] **SET-15 Wi-Fi: switch network** — Click "Join" on a non-connected network. Confirm that network becomes "Connected" and previous loses checkmark.
- [ ] **SET-16 Keyboard: sliders work** — Drag Key Repeat Rate and Delay sliders. Confirm numeric labels update.
- [ ] **SET-17 Mouse: Tap to Click toggle** — Toggle Tap to Click. Confirm state flips.
- [ ] **SET-18 Accessibility: all toggles** — Toggle Reduce Motion, High Contrast, Large Text, Screen Reader individually. Confirm each flips independently.
- [ ] **SET-19 Accessibility: Color Blind Mode** — Change dropdown to "deuteranopia." Confirm selection persists.
- [ ] **SET-20 Battery: Sleep slider** — Drag "Sleep After" slider. Confirm value range is 1–60 minutes.
- [ ] **SET-21 Date & Time: Timezone** — Change timezone dropdown. Confirm selection saves.
- [ ] **SET-22 Date & Time: 24-Hour toggle** — Toggle 24-Hour Format. Confirm state flips.
- [ ] **SET-23 Language: Language dropdown** — Select "Español." Confirm selection saves.
- [ ] **SET-24 Privacy: Firewall toggle** — Toggle Firewall. Confirm state flips.
- [ ] **SET-25 Privacy: Security status panel** — Confirm all 5 green checkmarks present: AES-256-GCM, IPC rate limiting, CSP headers, Context isolation, Audit logging.
- [ ] **SET-26 Users panel: current user** — Confirm logged-in username and "Administrator" role shown.
- [ ] **SET-27 Storage panel: bar chart** — Confirm colored storage bar renders with 5 segments (Applications, Documents, Media, System, Other) + free space.
- [ ] **SET-28 Storage: free space calculation** — 256 GB total, used = sum of 5 categories (54.9 GB). Free = ~201.1 GB. Verify these numbers.
- [ ] **SET-29 Software Update: Check for Updates** — Click button. Confirm spinner for ~1.5s, then green "up to date" message.
- [ ] **SET-30 About panel: all metadata** — Confirm Electron 29, React 18, AES-256-GCM, Shane Bedasee, RAXX Beats Studios LLC, UEI QHGHVKNDMQ33, CAGE 19WS9 all present.
- [ ] **SET-31 Settings persist across reopen** — Change accent color to red, close Settings, reopen it. Confirm red is still selected.

---

### TERMINAL

- [ ] **TRM-01 ASCII banner on open** — Open Terminal. Confirm REVELATIONS ASCII art banner displays in purple.
- [ ] **TRM-02 `help` command** — Type `help`, Enter. Confirm all 11 commands listed.
- [ ] **TRM-03 `clear` command** — Type some output, then `clear`. Confirm all lines removed.
- [ ] **TRM-04 `whoami` command** — Type `whoami`. Confirm logged-in username printed.
- [ ] **TRM-05 `date` command** — Type `date`. Confirm current date/time printed.
- [ ] **TRM-06 `pwd` command** — Type `pwd`. Confirm `/home/<username>` printed.
- [ ] **TRM-07 `ls` command** — Type `ls`. Confirm directory listing printed.
- [ ] **TRM-08 `echo` command** — Type `echo hello world`. Confirm "hello world" printed.
- [ ] **TRM-09 `history` command** — After running several commands, type `history`. Confirm numbered list of previous commands.
- [ ] **TRM-10 `version` command** — Type `version`. Confirm "Revelations OS v1.0.0" + Electron/React/Tailwind versions.
- [ ] **TRM-11 `neofetch` command** — Type `neofetch`. Confirm ASCII art with OS info panel.
- [ ] **TRM-12 Unknown command error** — Type `foo`. Confirm red error "Command not found: foo."
- [ ] **TRM-13 Arrow Up: history recall** — After several commands, press Up arrow. Confirm previous command fills input. Press Up again for earlier commands.
- [ ] **TRM-14 Arrow Down: history forward** — Press Down arrow after going up. Confirm moves forward in history. At idx -1, input clears.
- [ ] **TRM-15 Tab autocomplete (single match)** — Type `hel` and press Tab. Confirm input fills to `help `.
- [ ] **TRM-16 Autocomplete suggestion pills** — Type `ver`. Confirm suggestion pills appear below output area. Click a pill, confirm it fills input.
- [ ] **TRM-17 Auto-scroll to bottom** — Run many commands until output fills window. Confirm output auto-scrolls to show latest line.
- [ ] **TRM-18 Click refocuses input** — Click anywhere in the terminal (not the input). Confirm text cursor returns to the input field.
- [ ] **TRM-19 `proverbs` (packaged only)** — In packaged app, type `proverbs --help`. Confirm Proverbs CLI output displayed in sky-blue color. In dev, confirm graceful error message.
- [ ] **TRM-20 Prompt format** — Confirm prompt reads `<username>@revelations-os:~$` in green.

---

### NOTEPAD

- [ ] **NPD-01 Loads persisted tabs** — If tabs were saved previously, confirm they reload with correct content.
- [ ] **NPD-02 Default "Untitled" tab** — First open with no saved tabs: confirm one "Untitled" tab exists.
- [ ] **NPD-03 New tab (+ button)** — Click "+". Confirm new tab opens and becomes active.
- [ ] **NPD-04 New tab (Ctrl+T)** — Press Ctrl+T. Confirm new tab opens.
- [ ] **NPD-05 Close tab (X on tab)** — Click X on an active tab. Confirm it closes and previous tab activates.
- [ ] **NPD-06 Close last tab creates fresh** — With one tab, close it. Confirm a blank "Untitled" tab is created instead of empty state.
- [ ] **NPD-07 Tab rename** — Click the tab title text, edit it inline, press Tab or click away. Confirm tab label updates.
- [ ] **NPD-08 Unsaved dot indicator** — Type in editor. Confirm amber dot appears on the tab label.
- [ ] **NPD-09 Autosave** — Type something, wait ~800ms. Confirm dot disappears (saved to localStorage). Reopen Notepad; confirm content is there.
- [ ] **NPD-10 Save/download (Ctrl+S)** — Press Ctrl+S. Confirm browser download prompt fires for `<tabname>.txt`.
- [ ] **NPD-11 Download toolbar button** — Click the Download icon button. Confirm same download behavior.
- [ ] **NPD-12 Word wrap toggle** — Check/uncheck "Wrap." Confirm long lines wrap or overflow horizontally respectively.
- [ ] **NPD-13 Font size selector** — Change size to 24. Confirm editor text visibly enlarges.
- [ ] **NPD-14 Find bar (Ctrl+F)** — Press Ctrl+F. Confirm find bar appears below tab strip with autofocused input.
- [ ] **NPD-15 Find bar (toolbar button)** — Click "Find" button. Confirm same.
- [ ] **NPD-16 Find match count** — Type text in editor (e.g., "apple apple apple"), open Find, type "apple." Confirm "3 matches" shown.
- [ ] **NPD-17 Find bar Escape closes** — With find bar open, press Escape. Confirm bar hides.
- [ ] **NPD-18 Tab key inserts spaces** — In editor, press Tab. Confirm 2 spaces inserted (no focus loss).
- [ ] **NPD-19 Status bar: line count** — Type 3 lines of text. Confirm "Lines: 3" shown in status bar.
- [ ] **NPD-20 Status bar: word count** — Type "one two three." Confirm "Words: 3."
- [ ] **NPD-21 Status bar: char count** — Confirm character count matches string length.
- [ ] **NPD-22 Multiple tabs: independent content** — Open 2 tabs, type different text in each. Switch between them. Confirm content is independent.

---

### PCSCANFIX

- [ ] **PSF-01 Idle state shows categories** — Open PCFixScan. Confirm 6 category cards + "Start Full Scan" button visible.
- [ ] **PSF-02 Start scan** — Click "Start Full Scan." Confirm progress bar appears and animated scanning state begins.
- [ ] **PSF-03 Category highlight during scan** — During scan, confirm active category pill is highlighted in purple.
- [ ] **PSF-04 Progress bar fills** — Confirm progress percentage increments from 0 toward 100% and bar fills left-to-right.
- [ ] **PSF-05 Scan completes → results** — After scanning finishes (100%), confirm results view shows.
- [ ] **PSF-06 Summary cards** — Confirm 3 stat cards: "Issues Found," "Total Items," "Space to Free."
- [ ] **PSF-07 Finding rows** — Confirm 6 finding rows (one per category), each with checkbox, icon, label, count, size, severity badge.
- [ ] **PSF-08 Severity badges** — Items > 12 show red "high," 7–12 show amber "medium," ≤ 6 show green "low."
- [ ] **PSF-09 Anomaly badge** — If the LocalAI anomaly detector flags an unusually large finding, confirm red "anomaly" badge appears.
- [ ] **PSF-10 All findings pre-selected** — After scan, all checkboxes should be checked by default.
- [ ] **PSF-11 Deselect individual finding** — Uncheck one finding. Confirm "Clean Selected (5)" count decrements.
- [ ] **PSF-12 Deselect all: clean disabled** — Uncheck all findings. Confirm "Clean Selected (0)" button is grayed out (disabled).
- [ ] **PSF-13 Re-scan button** — Click "Re-scan" on results screen. Confirm scan restarts and new findings generated.
- [ ] **PSF-14 Clean selected** — With some items checked, click "Clean Selected." Confirm cleaning phase starts with spinning gear icon.
- [ ] **PSF-15 Cleaning log updates live** — During cleaning, confirm each cleaned item appears in the log as "✓ Cleaned [icon] [label] — freed X MB."
- [ ] **PSF-16 Done state** — After cleaning completes, confirm "System Optimized!" screen with total freed space and per-category list.
- [ ] **PSF-17 Scan Again resets** — Click "Scan Again" from done state. Confirm back to idle screen with no stale data.
- [ ] **PSF-18 Format bytes** — Confirm sizes display correctly (e.g., "523.5 MB" not raw bytes).

---

### APP STORE

- [ ] **AST-01 Hero and search bar** — Open App Store. Confirm hero header, subtitle, and search input rendered.
- [ ] **AST-02 Featured section visible** — Confirm 4 featured app cards visible (TaxFlow, LegalVault, GovcoreERP, CommandHQ) when no search and "All" selected.
- [ ] **AST-03 Featured card hover** — Hover over a featured card. Confirm lift (translateY -2px) and border brightens.
- [ ] **AST-04 Category filters** — Click "Finance." Confirm only finance apps shown. Click "All." Confirm all 44 apps return.
- [ ] **AST-05 Fuzzy search** — Type "taxfl" in search. Confirm TaxFlow Pro appears (Fuse.js threshold 0.4).
- [ ] **AST-06 No results state** — Type "zzzzzz." Confirm "No apps found" message.
- [ ] **AST-07 App row: Open/Get button (free app)** — Find a free app row (e.g., Celestia). Click "Open." Confirm Celestia window opens.
- [ ] **AST-08 App row: Get button (paid app)** — Find a paid app row. Click "Get." Confirm SubscriptionModal opens.
- [ ] **AST-09 App detail view** — Click a featured card or app row (not the Open/Get button). Confirm detail view opens in-place.
- [ ] **AST-10 App detail back button** — In detail view, click "← Back." Confirm returns to app list.
- [ ] **AST-11 App detail: Subscribe & Open** — In detail view for a paid app, click "Subscribe & Open." Confirm SubscriptionModal opens.
- [ ] **AST-12 App detail: Open App (free)** — In detail view for a free app, click "Open App." Confirm app window opens.
- [ ] **AST-13 Stats footer** — Confirm footer shows app count (44 Apps), Enterprise Ready, Instant Access, Live Updates.
- [ ] **AST-14 Star ratings displayed** — Confirm rated apps (TaxFlow: 4.9, pcscanfix: 5.0, etc.) show star + number in rows.

---

### CELESTIA OFFICE SUITE

- [ ] **CEL-01 Idle empty state** — Open Celestia. Confirm clipboard icon, "Celestia Office" title, supported format cards, and "Open File" button.
- [ ] **CEL-02 File type badges** — Confirm 4 file type cards: Word/DOCX, Excel/XLSX, PDF, PowerPoint.
- [ ] **CEL-03 Open file via button** — Click "Open." Confirm native file picker opens filtered to .doc, .docx, .xls, .xlsx, .csv, .pdf, .ppt, .pptx, .txt, .md.
- [ ] **CEL-04 Drag-and-drop overlay** — Drag a file over Celestia content area. Confirm purple dashed "Drop file to open" overlay appears.
- [ ] **CEL-05 Drop file** — Drop a .txt or .docx file. Confirm it loads without error.
- [ ] **CEL-06 Loading spinner** — Confirm spinner + "Opening file..." shown while parsing a file.
- [ ] **CEL-07 Word (DOCX) renders** — Open a .docx file. Confirm document HTML content appears in the editable div.
- [ ] **CEL-08 Word editing** — Click inside the Word doc area and type. Confirm text is editable.
- [ ] **CEL-09 Word formatting toolbar** — Confirm Bold, Italic, Underline, alignment, font size, color picker buttons appear only for Word docs.
- [ ] **CEL-10 Bold button** — Select text in Word doc, click Bold. Confirm text becomes bold.
- [ ] **CEL-11 Italic button** — Select text, click Italic. Confirm italic applied.
- [ ] **CEL-12 Align Center** — Select text, click Align Center. Confirm text centers.
- [ ] **CEL-13 Font size selector** — Change font size to 36pt (value 7). Confirm text enlarges.
- [ ] **CEL-14 Text color picker** — Click color picker, choose a color. Confirm text color changes.
- [ ] **CEL-15 Export button** — With a Word doc open, click "Export." Confirm .html file downloads.
- [ ] **CEL-16 Print button** — Click the Printer icon. Confirm browser print dialog opens.
- [ ] **CEL-17 Excel/XLSX renders** — Open an .xlsx file. Confirm sheet data renders as a table.
- [ ] **CEL-18 Excel sheet tabs** — If .xlsx has multiple sheets, confirm tabs appear. Click each tab; confirm table updates.
- [ ] **CEL-19 Excel cell editing** — Click a cell in the table. Confirm it's editable (contentEditable).
- [ ] **CEL-20 PDF renders** — Open a .pdf file. Confirm first page renders on canvas.
- [ ] **CEL-21 PDF next/prev page** — Click ">" button. Confirm page increments. Confirm "<" is disabled at page 1.
- [ ] **CEL-22 PDF page counter** — Confirm "X / Y" page counter updates correctly.
- [ ] **CEL-23 Zoom in** — Click "+" zoom button. Confirm zoom percentage increments by 10% and content enlarges.
- [ ] **CEL-24 Zoom out** — Click "-" zoom button. Confirm zoom decrements. Minimum 50%.
- [ ] **CEL-25 Zoom max** — Zoom in repeatedly. Confirm stops at 200%.
- [ ] **CEL-26 Status bar** — With a file open, confirm status bar shows: file type, file name, zoom%.
- [ ] **CEL-27 Error state** — Attempt to open a corrupt or unsupported file. Confirm red error message + "Try Again" button (clears error).
- [ ] **CEL-28 PPT placeholder** — Open a .pptx file. Confirm placeholder "PowerPoint preview: full editing coming soon" shown without crash.

---

### RAXX APP VIEWER (LIVE WEBVIEW)

- [ ] **RAX-01 Webview loads live URL** — Subscribe to any RAXX app (e.g., TaxFlow Pro). Confirm webview attempts to load `https://taxflow-pro.vercel.app`.
- [ ] **RAX-02 "Live" badge** — Confirm "Live" badge pill in the nav bar.
- [ ] **RAX-03 HTTPS lock icon** — Confirm green lock icon for https:// URLs.
- [ ] **RAX-04 Loading spinner in URL bar** — Confirm spinner appears while page loads.
- [ ] **RAX-05 Back/Forward buttons** — Navigate within the webview to a sub-page, click Back. Confirm returns to previous page. Back disables at root.
- [ ] **RAX-06 Reload button** — Click Reload. Confirm page refreshes.
- [ ] **RAX-07 Stop during load** — Click Reload then immediately X (stop). Confirm load stops.
- [ ] **RAX-08 URL updates on navigate** — Navigate within the app webview. Confirm URL bar updates to current URL.
- [ ] **RAX-09 Error state for unreachable URL** — If app URL is down, confirm "App is unreachable" error state with Retry button.
- [ ] **RAX-10 Retry button** — Click Retry in error state. Confirm webview reloads.
- [ ] **RAX-11 Session isolation** — Confirm each RAXX app uses `persist:raxx_<appId>` partition (distinct sessions per app).
- [ ] **RAX-12 Multiple RAXX apps** — Open two RAXX paid apps simultaneously. Confirm both run in separate windows with independent webviews.

---

### WIDGETS

- [ ] **WGT-01 Clock shows HH:MM:SS** — On clean desktop, confirm widget clock shows hours, minutes, seconds in 24h format with live 1-second tick.
- [ ] **WGT-02 Clock shows full date** — Confirm date below time shows weekday, month, day, year.
- [ ] **WGT-03 System Health bars** — Confirm CPU, Memory, Disk bars present with labels and percentages.
- [ ] **WGT-04 CPU updates** — CPU percentage changes every ~3 seconds (random delta animation).
- [ ] **WGT-05 Quick Notes persists** — Type in Quick Notes widget, close the window and reopen OS (or just verify it saves between sessions via localStorage).
- [ ] **WGT-06 Widgets hidden when windows open** — Confirm all 3 widgets fade to opacity 0 when any window is open (pointer-events none).

---

### MONDAY UPDATE CHECKER

- [ ] **UPD-01 Check fires on Monday** — Log in on a Monday. Confirm `nexus.checkForUpdate()` is called (visible in dev console or by verifying no error thrown).
- [ ] **UPD-02 Non-Monday: no check** — Log in on a non-Monday. Confirm update check does NOT fire.
- [ ] **UPD-03 Update available banner** — If `checkForUpdate` returns `{ available: true }`, confirm `pendingUpdate` store state is set (future UI hook).

---

### SECURITY

- [ ] **SEC-01 CSP headers active** — Open DevTools (dev build). Confirm no CSP violation errors in console for normal usage.
- [ ] **SEC-02 contextIsolation verified** — Confirm `window.require` is undefined in renderer (Node APIs not exposed directly).
- [ ] **SEC-03 Navigation blocked** — Attempt to navigate the main renderer to an external URL (e.g., inject `window.location.href='https://evil.com'`). Confirm main process blocks it.
- [ ] **SEC-04 IPC rate limit** — Triggering `app:exit` IPC > 100 times/second should be throttled (test programmatically in dev).
- [ ] **SEC-05 File read boundary** — `nexus.readFile` on a path outside home dir returns null (e.g., `/etc/passwd`).
- [ ] **SEC-06 Directory scan boundary** — `nexus.scanDirectory('/etc')` returns empty array (not allowed path).
- [ ] **SEC-07 Proverbs command sanitization** — Passing `; rm -rf ~` as proverbs args should have shell metacharacters stripped before execution.
- [ ] **SEC-08 No DevTools in packaged build** — In packaged `.app`, confirm DevTools cannot be opened (F12 / Cmd+Opt+I do nothing, `devTools: false`).
- [ ] **SEC-09 Popup windows blocked** — Within any webview, a site attempting `window.open()` should be blocked by `setWindowOpenHandler({ action: 'deny' })`.

---

### EDGE CASES

- [ ] **EDG-01 Drag window to screen corner** — Drag a window to top-left corner. Confirm clamped at x=0, y=40. Drag to bottom-right, confirm right/bottom clamp.
- [ ] **EDG-02 Resize to minimum then back** — Shrink window to 320×200, then drag to enlarge. Confirm resumes growing normally.
- [ ] **EDG-03 Open → minimize → maximize sequence** — Open a window, minimize it, restore it via TopBar, maximize it, restore from maximize. Confirm window is at correct position.
- [ ] **EDG-04 All apps open simultaneously** — Open all 8 system apps. Confirm no crashes, all windows render, TopBar shows only 8 indicators max.
- [ ] **EDG-05 Rapid open/close cycles** — Rapidly click to open and close the same app 10 times. Confirm no ID collisions or state leaks.
- [ ] **EDG-06 Notification center with 20+ notifications** — Trigger 20+ notifications. Confirm list scrolls properly and "9+" badge shows.
- [ ] **EDG-07 Clear all notifications → empty state** — With many notifications, click "Clear." Confirm immediate empty state renders.
- [ ] **EDG-08 Log out with windows open** — Open 5 windows, then Sign Out from user menu. Confirm all windows are cleared and LoginScreen shows.
- [ ] **EDG-09 Resize window from maximized** — Maximize a window; confirm resize handle is hidden/disabled. Restore; confirm handle reappears.
- [ ] **EDG-10 TopBar drag region** — Click and drag the TopBar region (not on a button or pill). Confirm the Electron window is dragged (native window move). This only applies to the packaged `.app`.
- [ ] **EDG-11 Notepad: closing tabs with unsaved content** — With unsaved content (amber dot), close the tab. Confirm content is not persisted to localStorage after close (vs. autosave behavior). Note current behavior: there is no "Are you sure?" guard.
- [ ] **EDG-12 Celestia: open second file without closing first** — With a Word doc open, click "Open" again and pick an Excel file. Confirm it replaces the Word doc cleanly (no stale state from previous file type).
- [ ] **EDG-13 Browser tab with failed page** — Navigate Ephesians to a non-existent domain. Confirm `did-fail-load` error state shown in that tab (not a crash).
- [ ] **EDG-14 Settings persist after OS restart** — Change a setting (e.g., accent color), close the app, reopen. Confirm setting is loaded from localStorage.

---

## KNOWN ISSUES

> Items confirmed broken or not yet implemented. Update as bugs are found during testing.
> 2026-06-11: all 15 issues resolved or verified — see notes per item.

- [x] **ISS-01** ~~Battery hardcoded at "78%"~~ FIXED — TopBar now uses `navigator.getBattery()` with live level/charging state; red icon ≤ 20%, BatteryCharging icon when plugged in.
- [x] **ISS-02** ~~Status icons cosmetic~~ FIXED — Wifi icon reflects `navigator.onLine` (amber WifiOff when offline); Bluetooth/Volume/Battery icons open their respective panel windows.
- [x] **ISS-03** ~~Wallpaper selection not applied~~ FIXED — `theme.js` WALLPAPERS map (nebula/cosmos/aurora/void gradients); Desktop listens to `revos:settings-changed` and swaps live.
- [x] **ISS-04** ~~Accent color requires restart~~ FIXED — `applyAccent()` hot-swaps `--accent`, `--accent-2`, `--accent-hover`, `--accent-glow`, `--border-accent`; applied on boot from saved settings via `applySavedTheme()` in main.jsx.
- [x] **ISS-05** ~~Raw process.platform in neofetch~~ FIXED — friendly map (darwin → "macOS (Darwin)", win32 → "Windows", linux → "Linux").
- [x] **ISS-06** ~~No unsaved-changes guard on Notepad tab close~~ FIXED — confirm dialog when closing a modified tab with content; tab list flushed to localStorage immediately on close.
- [x] **ISS-07** VERIFIED FIXED — Celestia caches the lazy-imported xlsx module in `_xlsxModule`; no `require()` remains.
- [x] **ISS-08** ~~File Manager context menu placeholder~~ FIXED — Copy Name/Copy Path use clipboard; Open navigates dirs and notifies for files; Get Info shows size/date/category/path notification.
- [x] **ISS-09** ~~FeaturedCard renders icon name as text~~ FIXED — shared `appIcons.js` (`getAppIcon`) resolves Lucide components; applied in FeaturedCard, AppRow, AppDetail, and TopBar search results.
- [x] **ISS-10** ~~No UI for pendingUpdate~~ FIXED — new `UpdateBanner.jsx` rendered when logged in: version display, Install button (calls `nexus.applyUpdate`), dismiss.
- [x] **ISS-11** VERIFIED FIXED — HistoryPanel.jsx is imported and rendered in EphesiansBrowser; reads and clears HISTORY_KEY.
- [x] **ISS-12** VERIFIED FIXED — Fuse keys are `['name', 'desc', 'category']`.
- [x] **ISS-13** VERIFIED FIXED — no synchronous `require` in Celestia; SheetData uses the cached module.
- [x] **ISS-14** ~~Red error for proverbs in dev mode~~ FIXED — now amber system-style message: "Proverbs CLI unavailable in dev mode — package the app to enable IPC."
- [x] **ISS-15** VERIFIED — SubscriptionModal passes `props: { liveUrl, appId, appName }`; WindowManager's RAXXLiveApp forwards `url={liveUrl}` to RAXXAppViewer. No missing prop.
- [x] **ISS-16** (found 2026-06-11) Duplicate `border` key in VolumePanel mute-button style — dead `border: 'none'` removed; build is warning-free.
- [ ] **2026-07-22 12:41:13** `48b58c6a` — push to gh
- [ ] **2026-08-29 23:42:31** `89a840e8` — I need to build a .exe file for revelations os and push it to the gh repo for revelations
- [ ] **2026-08-29 23:42:51** `89a840e8` — Please ensure that it works and that I can install it on a windows seamlessly with the same functionality as on my mac
