import { useOSStore } from '../store'
import AppWindow from './AppWindow'
import EphesiansBrowser from '../browser/EphesiansBrowser'
import FileManager from './FileManager'
import Settings from './Settings'
import Terminal from './Terminal'
import Notepad from './Notepad'
import PCFixScan from './PCFixScan'
import AppStore from './AppStore'
import Celestia from './Celestia'
import RAXXAppViewer from './RAXXAppViewer'
import WiFiPanel from './WiFiPanel'
import BluetoothPanel from './BluetoothPanel'
import BatteryPanel from './BatteryPanel'
import VolumePanel from './VolumePanel'

const APP_COMPONENTS = {
  ephesians: EphesiansBrowser,
  files: FileManager,
  settings: Settings,
  terminal: Terminal,
  notepad: Notepad,
  pcscanfix: PCFixScan,
  appstore: AppStore,
  celestia: Celestia,
  wifi: WiFiPanel,
  bluetooth: BluetoothPanel,
  battery: BatteryPanel,
  volume: VolumePanel,
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
        // RAXX live apps — rendered as webview pointing to production URL
        if (win.appId.startsWith('raxx_')) {
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
