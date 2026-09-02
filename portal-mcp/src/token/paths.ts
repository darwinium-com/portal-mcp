/**
 * Cross-platform paths for the portal-mcp installer.
 *
 * Uses `env-paths`-driven platform-conventional locations:
 *   - macOS:   ~/Library/Application Support/darwinium-portal-mcp/
 *   - Windows: %APPDATA%/darwinium-portal-mcp/Data/  (env-paths default)
 *   - Linux:   ~/.local/share/darwinium-portal-mcp/  (XDG_DATA_HOME)
 *
 * The token file and the extracted bundled extension share this single per-user
 * data dir so customers see one platform-conventional folder rather than two.
 *
 * Migration of the legacy `~/.config/darwinium-portal-mcp/token` location to
 * `<env-paths data dir>/token` lives in `src/install/migrate.ts`.
 */
import envPaths from 'env-paths';
import * as path from 'node:path';

const paths = envPaths('darwinium-portal-mcp', { suffix: '' });

/** Per-user data directory; parent of the token file and extracted extension. */
export const TOKEN_DIR = paths.data;

/** Token file path: 64-hex secret used for the binary↔extension handshake. */
export const TOKEN_PATH = path.join(TOKEN_DIR, 'token');

/** Extracted bundled-extension directory (loaded via Chrome's "Load Unpacked"). */
export const EXTENSION_DIR = path.join(TOKEN_DIR, 'extension');
