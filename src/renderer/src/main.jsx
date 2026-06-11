import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './styles/design-system.css'
import './styles/animations.css'
import { applySavedTheme } from './theme'
applySavedTheme()
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
)
