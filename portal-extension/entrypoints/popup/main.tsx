/**
 * Darwinium Portal MCP — popup React mount.
 *
 * WXT auto-detects entrypoints/popup/index.html → manifest.action.default_popup.
 * The HTML loads this file as `<script type="module" src="./main.tsx">`.
 *
 * State management: plain React useState + useEffect + chrome.storage.onChanged
 * for live updates (no Recoil).
 */
import { createRoot } from 'react-dom/client';
import { Popup } from './Popup';
import './popup.module.css';

const root = document.getElementById('root');
if (!root) throw new Error('popup: #root not found');
createRoot(root).render(<Popup />);
