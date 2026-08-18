/// <reference types="vite/client" />
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { applyTheme, readStoredTheme } from './theme'
import './style.css'

// Before render, so a stored override is already in effect for the first paint
// instead of flashing the OS theme and snapping over.
applyTheme(readStoredTheme())

// StrictMode is deliberately omitted: its dev-mode double mount fights the
// async Crepe create/destroy lifecycle.
const container = document.getElementById('root')
if (!container) throw new Error('missing #root container')
createRoot(container).render(<App />)
