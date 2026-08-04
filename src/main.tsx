import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { detectSource } from './lib/detectSource'

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found')

const source = detectSource(window.location.origin, window.location.search)

// Keep the token out of the address bar, history, and any copy-pasted URL.
if (new URLSearchParams(window.location.search).has('t')) {
  window.history.replaceState({}, '', window.location.pathname)
}

createRoot(container).render(
  <React.StrictMode>
    <App source={source} />
  </React.StrictMode>
)
