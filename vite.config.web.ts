// ========= Copyright 2025-2026 @ Eigent.ai All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2025-2026 @ Eigent.ai All Rights Reserved. =========
// Web-only Vite config for frontend-backend separation (no Electron).
// Usage: npm run dev:web | npm run build:web

import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { emojiData } from './scripts/vite-emoji-data';

const proxyHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
});
const proxyHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
});

/**
 * Proxy table shared by `dev:web` (server.proxy) and `preview:web`
 * (preview.proxy), so a production build served by `vite preview` reaches the
 * local FastAPI server instead of 404-ing on its own origin.
 */
function buildProxyTable(target?: string) {
  if (!target) return undefined;
  const agent = target.startsWith('https') ? proxyHttpsAgent : proxyHttpAgent;
  return {
    // A production build uses VITE_BASE_URL (/api) as the proxy base while some
    // callers already pass /api/v1/... — collapse the duplicated prefix.
    '/api/api': {
      target,
      changeOrigin: true,
      rewrite: (pathname: string) => pathname.replace(/^\/api\/api/, '/api'),
      agent,
    },
    '/api': {
      target,
      changeOrigin: true,
      ws: true,
      agent,
    },
    // Brain health checks resolve against the same origin when
    // VITE_BRAIN_ENDPOINT is unset.
    '/health': {
      target,
      changeOrigin: true,
      agent,
    },
  };
}

const LOCAL_CONTROL_TOKEN_FILE = path.join(
  os.homedir(),
  '.eigent',
  'local-control-token'
);

/**
 * Hand the page the Brain's autopaired control token, dev only.
 *
 * The Brain publishes a 0600 token file when it runs with
 * `EIGENT_LOCAL_BROWSER_AUTOPAIR=1`; reading it per document request means the
 * dev server does not have to be started after the Brain, and a Brain restart
 * is picked up on the next page load. Production builds never contain it.
 */
function localControlAutopairPlugin(): Plugin {
  return {
    name: 'eigent-local-control-autopair',
    apply: 'serve',
    transformIndexHtml(html) {
      let token = '';
      try {
        token = fs.readFileSync(LOCAL_CONTROL_TOKEN_FILE, 'utf8').trim();
      } catch {
        return html;
      }
      if (!token.startsWith('lc1.')) return html;
      return {
        html,
        tags: [
          {
            tag: 'script',
            injectTo: 'head-prepend',
            children: `window.__EIGENT_LOCAL_CONTROL_TOKEN__=${JSON.stringify(token)};`,
          },
        ],
      };
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // SERVER_URL is the real upstream (not exposed to the client). VITE_PROXY_URL
  // is the runtime base the bundle calls, which may be this preview origin when
  // the browser talks to the proxy same-origin — never use it as the target.
  const proxyTarget = env.SERVER_URL || env.VITE_PROXY_URL;
  const proxyTable = buildProxyTable(proxyTarget);
  return {
    resolve: {
      alias: {
        '@': path.join(__dirname, 'src'),
      },
    },
    plugins: [react(), emojiData(__dirname), localControlAutopairPlugin()],
    optimizeDeps: {
      exclude: ['@stackframe/react'],
    },
    build: {
      outDir: 'dist-web',
      emptyOutDir: true,
      sourcemap: true,
    },
    server: {
      port: Number(process.env.PORT) || 5173,
      open: false,
      proxy: proxyTable,
    },
    preview: {
      port: Number(process.env.PORT) || 4173,
      proxy: proxyTable,
    },
  };
});
