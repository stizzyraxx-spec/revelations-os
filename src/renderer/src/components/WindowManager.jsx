import { useOSStore } from '../store'
import AppWindow from './AppWindow'
import EphesiansBrowser from '../browser/EphesiansBrowser'
import FileManager from './FileManager'
import Settings from './Settings'
import Terminal from './Terminal'
import TerminalX from './TerminalX'
import Scrolls from './Scrolls'
import Notepad from './Notepad'
import PCFixScan from './PCFixScan'
import AppStore from './AppStore'
import Celestia from './Celestia'
import RAXXAppViewer from './RAXXAppViewer'
import WiFiPanel from './WiFiPanel'
import BluetoothPanel from './BluetoothPanel'
import BatteryPanel from './BatteryPanel'
import VolumePanel from './VolumePanel'
import Calculator from './Calculator'
import ClockAlarm from './ClockAlarm'
import MusicPlayer from './MusicPlayer'
import CalendarApp from './CalendarApp'
import PrivacySupport from './PrivacySupport'
import StickyNotes from './StickyNotes'
import MailClient from './MailClient'
import MeetingsApp from './MeetingsApp'
import NotificationsManager from './NotificationsManager'
import CalendarConnector from './CalendarConnector'
import IdeaPlanner from './IdeaPlanner'

function PrivacyApp(props) { return <PrivacySupport {...props} initialTab="privacy" /> }
function SupportApp(props) { return <PrivacySupport {...props} initialTab="support" /> }

const APP_COMPONENTS = {
  ephesians: EphesiansBrowser,
  files: FileManager,
  settings: Settings,
  terminal: Terminal,
  terminalx: TerminalX,
  scrolls: Scrolls,
  notepad: Notepad,
  pcscanfix: PCFixScan,
  appstore: AppStore,
  celestia: Celestia,
  wifi: WiFiPanel,
  bluetooth: BluetoothPanel,
  battery: BatteryPanel,
  volume: VolumePanel,
  calculator: Calculator,
  clock: ClockAlarm,
  music: MusicPlayer,
  calendar: CalendarApp,
  privacy: PrivacyApp,
  support: SupportApp,
  stickynotes: StickyNotes,
  mail: MailClient,
  meetings: MeetingsApp,
  notifications: NotificationsManager,
  calconnect: CalendarConnector,
  ideaplanner: IdeaPlanner,
}

function RAXXLiveApp({ appId, liveUrl, appName }) {
  return <RAXXAppViewer url={liveUrl} title={appName} appId={appId} />
}

function PlaceholderApp({ appId }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:16, background:'var(--bg-secondary)', color:'var(--text-muted)' }}>
      <div style={{ fontSize:48 }}>🚀</div>
      <div style={{ color:'var(--text-secondary)', fontSize:'1rem', fontWeight:600 }}>{appId}</div>
      <div style={{ fontSize:'0.8rem' }}>Coming soon</div>
    </div>
  )
}

export default function WindowManager() {
  const windows = useOSStore(s => s.windows)
  const visibleWindows = windows.filter(w => !w.minimized)

  return (
    <div style={{ position:'absolute', inset:0, pointerEvents:'none' }}>
      {visibleWindows.map(win => {
        // External webview apps (subscription apps + free liveUrl apps like Bible)
        if (win.appId.startsWith('raxx_') || win.props?.liveUrl) {
          const ContentComp = (props) => <RAXXLiveApp {...props} {...win.props} />
          return <AppWindow key={win.id} win={win} ContentComponent={ContentComp} />
        }
        const Content = APP_COMPONENTS[win.appId] || PlaceholderApp
        return (
          <AppWindow key={win.id} win={win} ContentComponent={Content} />
        )
      })}
    </div>
  )
}
