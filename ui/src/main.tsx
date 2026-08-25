import React from 'react'
import ReactDOM from 'react-dom/client'
import { LiveConsoleView } from './views/LiveConsoleView'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LiveConsoleView />
  </React.StrictMode>,
)
