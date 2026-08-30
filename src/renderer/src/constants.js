export const APP_REGISTRY = [
  // SYSTEM — free, no subscription
  { id: 'bible', name: 'Bible', icon: 'BookOpen', color: '#7c3aed', category: 'faith', free: true, desc: 'Read the Holy Bible — browse by book, chapter and verse', liveUrl: 'https://theconditionofman.com/bible' },
  { id: 'bible-plans', name: 'Bible Plans', icon: 'ScrollText', color: '#6d28d9', category: 'faith', free: true, desc: 'Daily Bible reading plans with progress tracking', liveUrl: 'https://theconditionofman.com/bible-plans' },
  { id: 'verse-of-day', name: 'Verse of the Day', icon: 'Flame', color: '#f59e0b', category: 'faith', free: true, desc: 'Daily featured scripture with reflection', liveUrl: 'https://theconditionofman.com/discover' },
  { id: 'prayer-wall', name: 'Prayer Wall', icon: 'HandHeart', color: '#ec4899', category: 'faith', free: true, desc: 'Submit and intercede for community prayer requests', liveUrl: 'https://theconditionofman.com/prayer' },
  { id: 'petitions', name: 'Petitions', icon: 'ScrollText', color: '#f97316', category: 'faith', free: true, desc: 'Community petitions and advocacy board', liveUrl: 'https://theconditionofman.com/petitions' },
  { id: 'forums', name: 'Forums', icon: 'MessageSquare', color: '#0ea5e9', category: 'faith', free: true, desc: 'Faith-based discussion threads and Q&A', liveUrl: 'https://theconditionofman.com/forums' },
  { id: 'community-hub', name: 'Community', icon: 'Users', color: '#10b981', category: 'faith', free: true, desc: 'Activity feed, announcements and community hub', liveUrl: 'https://theconditionofman.com/community' },
  { id: 'live-stream', name: 'Live Stream', icon: 'Radio', color: '#ef4444', category: 'faith', free: true, desc: 'Watch live worship broadcasts and sermons', liveUrl: 'https://theconditionofman.com/live' },
  { id: 'discover-faith', name: 'Discover', icon: 'Compass', color: '#8b5cf6', category: 'faith', free: true, desc: 'Explore curated faith content and trending scriptures', liveUrl: 'https://theconditionofman.com/discover' },
  { id: 'faith-games', name: 'Bible Games', icon: 'Gamepad2', color: '#06b6d4', category: 'faith', free: true, desc: 'Interactive faith-based games and quizzes', liveUrl: 'https://theconditionofman.com/games' },
  { id: 'bookmarks', name: 'Bookmarks', icon: 'BookMarked', color: '#84cc16', category: 'faith', free: true, desc: 'Saved verses, sermons and study content', liveUrl: 'https://theconditionofman.com/profile' },
  { id: 'donate-faith', name: 'Give / Tithe', icon: 'DollarSign', color: '#22c55e', category: 'faith', free: true, desc: 'Donations, tithes and offerings', liveUrl: 'https://theconditionofman.com/donate' },
  { id: 'my-profile', name: 'My Profile', icon: 'UserCircle', color: '#a78bfa', category: 'faith', free: true, desc: 'Your account, badges and activity history', liveUrl: 'https://theconditionofman.com/profile' },
  { id: 'calculator', name: 'Calculator', icon: 'Calculator', color: '#374151', category: 'system', free: true, desc: 'Scientific calculator with history' },
  { id: 'clock', name: 'Clock', icon: 'Clock', color: '#0891b2', category: 'system', free: true, desc: 'World clock, alarms, stopwatch & timer' },
  { id: 'music', name: 'Music', icon: 'Music2', color: '#7c3aed', category: 'system', free: true, desc: 'Worship music player' },
  { id: 'calendar', name: 'Calendar', icon: 'Calendar', color: '#dc2626', category: 'system', free: true, desc: 'Personal calendar & events' },
  { id: 'privacy', name: 'Privacy Policy', icon: 'Shield', color: '#065f46', category: 'system', free: true, desc: 'Privacy policy and data usage' },
  { id: 'support', name: 'Support', icon: 'HelpCircle', color: '#1d4ed8', category: 'system', free: true, desc: 'Help center, FAQ and contact support' },
  { id: 'mail', name: 'Mail', icon: 'Mail', color: '#0ea5e9', category: 'system', free: true, desc: 'Full mail client — connect Gmail, Outlook, Yahoo, iCloud' },
  { id: 'meetings', name: 'Meetings', icon: 'Video', color: '#22c55e', category: 'system', free: true, desc: 'Schedule and join video meetings — Zoom, Teams, Meet' },
  { id: 'stickynotes', name: 'Sticky Notes', icon: 'StickyNote', color: '#eab308', category: 'system', free: true, desc: 'Floating sticky notes on your desktop' },
  { id: 'notifications', name: 'Notifications', icon: 'Bell', color: '#f97316', category: 'system', free: true, desc: 'Manage all notification settings and alerts' },
  { id: 'calconnect', name: 'Calendar Sync', icon: 'CalendarDays', color: '#6366f1', category: 'system', free: true, desc: 'Connect Google Calendar, iCloud, Outlook and ICS feeds' },
  { id: 'ephesians', name: 'Ephesians', icon: 'Globe', color: '#2563eb', category: 'system', free: true, desc: 'Revelations OS Web Browser — Chromium-powered' },
  { id: 'files', name: 'Files', icon: 'Folder', color: '#d97706', category: 'system', free: true, desc: 'File Manager' },
  { id: 'settings', name: 'Settings', icon: 'Settings2', color: '#6d28d9', category: 'system', free: true, desc: 'System Preferences' },
  { id: 'terminal', name: 'Terminal', icon: 'TerminalSquare', color: '#059669', category: 'system', free: true, desc: 'Developer Terminal + Proverbs' },
  { id: 'notepad', name: 'Notepad', icon: 'FileText', color: '#64748b', category: 'system', free: true, desc: 'Text Editor' },
  { id: 'pcscanfix', name: 'PCFixScan', icon: 'Shield', color: '#16a34a', category: 'system', free: true, desc: 'System Cleaner — FREE' },
  { id: 'appstore', name: 'App Store', icon: 'Store', color: '#7c3aed', category: 'system', free: true, desc: 'App Marketplace' },
  { id: 'celestia', name: 'Celestia', icon: 'FileStack', color: '#0e7490', category: 'system', free: true, desc: 'Office Suite — Word, Excel, PowerPoint, PDF' },
  // Subscription apps (liveUrl = embedded webview; updates auto-sync from live deployment)
  { id: 'proverbs', name: 'Proverbs', icon: 'BookOpen', color: '#6d28d9', category: 'dev', free: true, desc: 'Developer intelligence and code scanning', liveUrl: 'https://proverbs.cloutkiller.com' },
  { id: 'ideaplanner', name: 'IdeaPlanner', icon: 'Lightbulb', color: '#b45309', category: 'system', free: true, desc: 'Canvas mind-map and ideation tool — runs locally' },
  { id: 'tcom', name: 'The Condition of Man', icon: 'BookHeart', color: '#b91c1c', category: 'faith', price: '$4.99/mo', trial: '30 days', free: false, desc: 'Bible study and Christian community platform', liveUrl: 'https://theconditionofman.com' },
  { id: 'admincenter', name: 'Admin Center', icon: 'LayoutDashboard', color: '#4f46e5', category: 'admin', price: 'Internal', trial: 'N/A', free: true, desc: 'App metrics dashboard', liveUrl: 'https://admin-center.vercel.app' },
]

export const SYSTEM_APPS = APP_REGISTRY.filter(a => a.category === 'system')
export const RAXX_APPS = APP_REGISTRY.filter(a => a.category !== 'system')
export const OS_VERSION = '1.0.0'
export const OS_BRAND = 'Revelations OS'
