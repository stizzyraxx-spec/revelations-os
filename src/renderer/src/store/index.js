import { create } from 'zustand'

export const useOSStore = create((set, get) => ({
  // ─── USER ───────────────────────────────────────────────────────────────────
  user: { name: '', loggedIn: false, avatar: null },

  login: (name) => {
    set({ user: { name, loggedIn: true, avatar: null } })
    get().addNotification({
      title: 'Welcome back!',
      body: `Logged in as ${name}`,
      type: 'info',
    })
  },

  logout: () => {
    set({
      user: { name: '', loggedIn: false, avatar: null },
      windows: [],
      nextId: 1,
      nextZ: 10,
    })
  },

  // ─── WINDOWS ────────────────────────────────────────────────────────────────
  windows: [],
  nextId: 1,
  nextZ: 10,

  openWindow: ({ appId, title, width = 960, height = 640, props = {} }) => {
    const { windows, nextId, nextZ, focusWindow } = get()
    const existing = windows.find((w) => w.appId === appId)
    if (existing) {
      // If minimized, restore it; otherwise just focus
      if (existing.minimized) {
        set((s) => ({
          windows: s.windows.map((w) =>
            w.id === existing.id ? { ...w, minimized: false } : w
          ),
        }))
      }
      focusWindow(existing.id)
      return
    }
    const vw = window.innerWidth || 1280
    const vh = window.innerHeight || 800
    const x = Math.max(0, Math.floor((vw - width) / 2) + (nextId % 5) * 12)
    const y = Math.max(0, 80 + (nextId % 4) * 20)
    const newWin = {
      id: nextId,
      appId,
      title,
      x,
      y,
      width,
      height,
      minimized: false,
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
