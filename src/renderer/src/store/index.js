import { create } from 'zustand'
import { resolveIdentity, saveSession, clearSession } from '../auth/session'
import { provisionAccount, findAccount, needsPassword } from '../auth/localAuth'

// ─── CUSTOM (INTERNET-INSTALLED) APPS ─────────────────────────────────────────
const CUSTOM_APPS_KEY = 'revos_custom_apps'

function loadCustomApps() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_APPS_KEY) || '[]') } catch { return [] }
}
function saveCustomApps(apps) {
  try { localStorage.setItem(CUSTOM_APPS_KEY, JSON.stringify(apps)) } catch {}
}
function normalizeUrl(raw) {
  const t = String(raw || '').trim()
  if (!t) return ''
  if (/^https?:\/\//i.test(t)) return t
  return `https://${t}`
}

export const useOSStore = create((set, get) => ({
  // ─── USER ───────────────────────────────────────────────────────────────────
  user: { name: '', loggedIn: false, avatar: null, username: '', source: null },

  // True until hydrate() has decided whether we already know who this is.
  // Without it the login screen flashes on every reload before the stored
  // session resolves, which is most of what made the OS feel forgetful.
  booting: true,

  // Resolve an identity without asking: the gateway first (authoritative when
  // the OS is served from code.raxxware.com), then a stored session. Only when
  // both come back empty does the login screen appear.
  hydrate: async () => {
    try {
      const id = await resolveIdentity()
      if (!id) return set({ booting: false })

      // A gateway identity may have no local account yet -- provision one so
      // preferences and the password prompt have something to attach to.
      if (id.source === 'gateway') {
        provisionAccount({ username: id.username, name: id.name, role: id.role })
      }
      const acct = findAccount(id.username) || {}
      set({
        user: {
          name: acct.name || id.name,
          username: id.username,
          loggedIn: true,
          avatar: null,
          source: id.source,
        },
        // Surfaced by App as a prompt. A provisioned account has no password
        // yet, and we ask rather than invent one.
        passwordSetupFor: needsPassword(id.username) ? id.username : null,
        booting: false,
      })
    } catch {
      set({ booting: false })
    }
  },

  passwordSetupFor: null,
  clearPasswordSetup: () => set({ passwordSetupFor: null }),

  login: (name, meta = {}) => {
    const username = meta.username || name
    set({ user: { name, username, loggedIn: true, avatar: null, source: meta.source || 'local' } })
    saveSession({ name, username, source: meta.source || 'local' })
    set({ passwordSetupFor: needsPassword(username) ? username : null })
    get().addNotification({
      title: 'Welcome back!',
      body: `Logged in as ${name}`,
      type: 'info',
    })
  },

  logout: () => {
    clearSession()
    set({
      user: { name: '', loggedIn: false, avatar: null, username: '', source: null },
      passwordSetupFor: null,
      windows: [],
      nextId: 1,
      nextZ: 10,
    })
  },

  // ─── WINDOWS ────────────────────────────────────────────────────────────────
  windows: [],
  nextId: 1,
  nextZ: 10,

  openWindow: ({ appId, title, width = 960, height = 640, props = {}, maximized = true }) => {
    const { windows, nextId, nextZ, focusWindow, activeDesktop } = get()
    const existing = windows.find((w) => w.appId === appId)
    if (existing) {
      // If minimized, restore it; otherwise just focus. An app opened from
      // another desktop comes to the one you are looking at.
      set((s) => ({
        windows: s.windows.map((w) =>
          w.id === existing.id ? { ...w, minimized: false, desktop: activeDesktop } : w
        ),
      }))
      focusWindow(existing.id)
      return
    }
    const vw = window.innerWidth || 1280
    const vh = window.innerHeight || 800
    // Centred bounds are what the window restores to when un-maximized; it
    // opens full screen, which is what you want from a launcher.
    const TOP = 40, BOTTOM = 48
    const x = Math.max(0, Math.floor((vw - width) / 2))
    const y = Math.max(TOP, Math.floor((vh - TOP - BOTTOM - height) / 2) + TOP)
    const newWin = {
      id: nextId,
      appId,
      title,
      x,
      y,
      width,
      height,
      minimized: false,
      maximized,
      // Bounds to return to when leaving maximized/snapped.
      restore: { x, y, width, height },
      snap: null,
      desktop: activeDesktop,
      focused: true,
      zIndex: nextZ,
      props,
    }
    set((s) => ({
      windows: s.windows.map((w) => ({ ...w, focused: false })).concat(newWin),
      nextId: s.nextId + 1,
      nextZ: s.nextZ + 1,
    }))
  },

  // ─── WINDOW LAYOUT ──────────────────────────────────────────────────────────
  // The usable desktop: below the top bar, above the taskbar.
  workArea: () => {
    const TOP = 40, BOTTOM = 48
    return {
      x: 0,
      y: TOP,
      width: window.innerWidth || 1280,
      height: (window.innerHeight || 800) - TOP - BOTTOM,
    }
  },

  toggleMaximize: (id) => {
    set((s) => ({
      windows: s.windows.map((w) => {
        if (w.id !== id) return w
        if (w.maximized) {
          const r = w.restore || { x: w.x, y: w.y, width: w.width, height: w.height }
          return { ...w, maximized: false, snap: null, ...r }
        }
        return {
          ...w,
          maximized: true,
          snap: null,
          restore: { x: w.x, y: w.y, width: w.width, height: w.height },
        }
      }),
    }))
    get().focusWindow(id)
  },

  // Dragging the title bar of a maximized window pops it back to its restored
  // size under the cursor, the way Windows does, instead of refusing to move.
  popOutOfMaximize: (id, { x, y }) => {
    set((s) => ({
      windows: s.windows.map((w) => {
        if (w.id !== id) return w
        const r = w.restore || { width: 960, height: 640 }
        return {
          ...w,
          maximized: false,
          snap: null,
          width: r.width,
          height: r.height,
          x: Math.max(0, Math.round(x)),
          y: Math.max(40, Math.round(y)),
        }
      }),
    }))
  },

  // Snap a window into one half or quarter of the screen, so several apps can
  // share the desktop. corner: 'tl' | 'tr' | 'bl' | 'br' | 'left' | 'right' | null
  snapWindow: (id, corner) => {
    const area = get().workArea()
    const halfW = Math.floor(area.width / 2)
    const halfH = Math.floor(area.height / 2)
    const slots = {
      tl: { x: area.x, y: area.y, width: halfW, height: halfH },
      tr: { x: area.x + halfW, y: area.y, width: area.width - halfW, height: halfH },
      bl: { x: area.x, y: area.y + halfH, width: halfW, height: area.height - halfH },
      br: { x: area.x + halfW, y: area.y + halfH, width: area.width - halfW, height: area.height - halfH },
      left: { x: area.x, y: area.y, width: halfW, height: area.height },
      right: { x: area.x + halfW, y: area.y, width: area.width - halfW, height: area.height },
    }
    const target = slots[corner]
    set((s) => ({
      windows: s.windows.map((w) => {
        if (w.id !== id) return w
        if (!target) {
          // Un-snap: back to the pre-snap bounds.
          const r = w.restore || { x: w.x, y: w.y, width: w.width, height: w.height }
          return { ...w, snap: null, maximized: false, ...r }
        }
        return {
          ...w,
          snap: corner,
          maximized: false,
          // Only remember the restore bounds on the first snap, so snapping
          // corner to corner doesn't lose the original size.
          restore: (w.snap || w.maximized) ? w.restore : { x: w.x, y: w.y, width: w.width, height: w.height },
          ...target,
        }
      }),
    }))
    get().focusWindow(id)
  },

  // ─── VIRTUAL DESKTOPS ───────────────────────────────────────────────────────
  desktops: [{ id: 1, name: 'Desktop 1' }],
  activeDesktop: 1,
  nextDesktopId: 2,

  addDesktop: () => {
    const { nextDesktopId, desktops } = get()
    set({
      desktops: [...desktops, { id: nextDesktopId, name: `Desktop ${desktops.length + 1}` }],
      nextDesktopId: nextDesktopId + 1,
      activeDesktop: nextDesktopId,
    })
    return nextDesktopId
  },

  switchDesktop: (id) => {
    if (!get().desktops.some((d) => d.id === id)) return
    set({ activeDesktop: id })
  },

  // Closing a desktop keeps its windows — they move to the one on its left so
  // nothing is lost by tidying up. The last desktop cannot be removed.
  removeDesktop: (id) => {
    set((s) => {
      if (s.desktops.length <= 1) return {}
      const idx = s.desktops.findIndex((d) => d.id === id)
      if (idx === -1) return {}
      const remaining = s.desktops.filter((d) => d.id !== id)
      const fallback = remaining[Math.max(0, idx - 1)].id
      return {
        desktops: remaining,
        windows: s.windows.map((w) => (w.desktop === id ? { ...w, desktop: fallback } : w)),
        activeDesktop: s.activeDesktop === id ? fallback : s.activeDesktop,
      }
    })
  },

  moveWindowToDesktop: (winId, desktopId) => {
    set((s) => ({
      windows: s.windows.map((w) => (w.id === winId ? { ...w, desktop: desktopId } : w)),
    }))
  },

  closeWindow: (id) => {
    set((s) => ({ windows: s.windows.filter((w) => w.id !== id) }))
  },

  focusWindow: (id) => {
    set((s) => {
      const nextZ = s.nextZ + 1
      return {
        windows: s.windows.map((w) =>
          w.id === id
            ? { ...w, focused: true, zIndex: nextZ }
            : { ...w, focused: false }
        ),
        nextZ,
      }
    })
  },

  minimizeWindow: (id) => {
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === id ? { ...w, minimized: true, focused: false } : w
      ),
    }))
  },

  restoreWindow: (id) => {
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === id ? { ...w, minimized: false } : w
      ),
    }))
    get().focusWindow(id)
  },

  moveWindow: (id, x, y) => {
    const vw = window.innerWidth || 1280
    const vh = window.innerHeight || 800
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === id
          ? {
              ...w,
              x: Math.max(0, Math.min(x, vw - w.width)),
              y: Math.max(0, Math.min(y, vh - w.height)),
            }
          : w
      ),
    }))
  },

  resizeWindow: (id, width, height) => {
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === id
          ? { ...w, width: Math.max(320, width), height: Math.max(200, height) }
          : w
      ),
    }))
  },

  // Set position AND size in one update — used by edge/corner resizing where
  // dragging the top or left edge changes x/y and width/height together.
  setBounds: (id, { x, y, width, height }) => {
    const MIN_W = 320, MIN_H = 200
    set((s) => ({
      windows: s.windows.map((w) => {
        if (w.id !== id) return w
        return {
          ...w,
          x: Math.max(0, Math.round(x)),
          y: Math.max(0, Math.round(y)),
          width: Math.max(MIN_W, Math.round(width)),
          height: Math.max(MIN_H, Math.round(height)),
        }
      }),
    }))
  },

  // ─── NOTIFICATIONS ──────────────────────────────────────────────────────────
  notifications: [],
  notificationPanelOpen: false,

  addNotification: ({ title, body, type = 'info' }) => {
    set((s) => ({
      notifications: [
        ...s.notifications,
        {
          id: Date.now(),
          title,
          body,
          type,
          timestamp: new Date().toISOString(),
          read: false,
        },
      ],
    }))
  },

  markRead: (id) => {
    set((s) => ({
      notifications: s.notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n
      ),
    }))
  },

  markAllRead: () => {
    set((s) => ({
      notifications: s.notifications.map((n) => ({ ...n, read: true })),
    }))
  },

  clearAll: () => {
    set({ notifications: [] })
  },

  toggleNotificationPanel: () => {
    set((s) => ({ notificationPanelOpen: !s.notificationPanelOpen }))
  },

  // ─── CUSTOM APPS (installed from the internet) ───────────────────────────────
  customApps: loadCustomApps(),

  installWebApp: ({ name, url, color }) => {
    const liveUrl = normalizeUrl(url)
    if (!liveUrl) return null
    const app = {
      id: 'web_' + Date.now(),
      name: (name || '').trim() || liveUrl.replace(/^https?:\/\//, '').split('/')[0],
      icon: 'Globe',
      color: color || '#2563eb',
      category: 'installed',
      free: true,
      desc: liveUrl,
      liveUrl,
      custom: true,
    }
    set((s) => {
      const next = [...s.customApps, app]
      saveCustomApps(next)
      return { customApps: next }
    })
    get().addNotification({ title: 'App installed', body: `${app.name} was added to your apps`, type: 'success' })
    return app
  },

  uninstallWebApp: (id) => {
    set((s) => {
      const next = s.customApps.filter((a) => a.id !== id)
      saveCustomApps(next)
      return { customApps: next, windows: s.windows.filter((w) => w.appId !== id) }
    })
  },

  // ─── ORB LAUNCHER ───────────────────────────────────────────────────────────
  orbLauncherOpen: false,

  toggleOrbLauncher: () => {
    set((s) => ({ orbLauncherOpen: !s.orbLauncherOpen }))
  },

  // ─── EXIT MODAL ─────────────────────────────────────────────────────────────
  exitModalOpen: false,

  openExitModal: () => set({ exitModalOpen: true }),
  closeExitModal: () => set({ exitModalOpen: false }),

  // ─── SUBSCRIPTION MODAL ─────────────────────────────────────────────────────
  subscriptionApp: null,

  openSubscription: (app) => set({ subscriptionApp: app }),
  closeSubscription: () => set({ subscriptionApp: null }),

  // ─── CURRENT TIME ───────────────────────────────────────────────────────────
  currentTime: null,

  // ─── AUDIT LOG ──────────────────────────────────────────────────────────────
  auditLog: [],

  logAudit: (action, detail) => {
    set((s) => {
      const entry = { ts: new Date().toISOString(), action, detail }
      const log = [...s.auditLog, entry]
      return { auditLog: log.slice(-500) }
    })
  },

  // ─── PENDING UPDATE ─────────────────────────────────────────────────────────
  pendingUpdate: null,

  setPendingUpdate: (u) => set({ pendingUpdate: u }),

  // ─── EPHESIANS BROWSER TABS ─────────────────────────────────────────────────
  ephesiansTabs: [
    {
      id: 1,
      url: 'https://www.google.com',
      title: 'New Tab',
      favicon: null,
      loading: false,
      canBack: false,
      canFwd: false,
    },
  ],
  activeTabId: 1,
  tabCounter: 2,

  addTab: (url = 'https://www.google.com') => {
    set((s) => {
      const id = s.tabCounter
      return {
        ephesiansTabs: [
          ...s.ephesiansTabs,
          { id, url, title: 'New Tab', favicon: null, loading: false, canBack: false, canFwd: false },
        ],
        activeTabId: id,
        tabCounter: s.tabCounter + 1,
      }
    })
  },

  closeTab: (id) => {
    set((s) => {
      if (s.ephesiansTabs.length === 1) return {}
      const idx = s.ephesiansTabs.findIndex((t) => t.id === id)
      const remaining = s.ephesiansTabs.filter((t) => t.id !== id)
      let nextActive = s.activeTabId
      if (s.activeTabId === id) {
        // Switch to adjacent tab
        const nextIdx = Math.min(idx, remaining.length - 1)
        nextActive = remaining[nextIdx].id
      }
      return { ephesiansTabs: remaining, activeTabId: nextActive }
    })
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  updateTab: (id, patch) => {
    set((s) => ({
      ephesiansTabs: s.ephesiansTabs.map((t) =>
        t.id === id ? { ...t, ...patch } : t
      ),
    }))
  },
}))
