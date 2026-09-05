import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Chat from './Chat'
import Settings from './Settings'
import './index.css'

const hash = window.location.hash
const view = hash.startsWith('#/chat') ? <Chat /> : hash.startsWith('#/settings') ? <Settings /> : <App />
createRoot(document.getElementById('root')!).render(<React.StrictMode>{view}</React.StrictMode>)
