/// <reference types="vite/client" />
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './style.css'

// StrictMode is deliberately omitted: its dev-mode double mount fights the
// async Crepe create/destroy lifecycle.
const container = document.getElementById('root')
if (!container) throw new Error('missing #root container')
createRoot(container).render(<App />)
