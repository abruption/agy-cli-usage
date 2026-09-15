// Internal background entry point. It never reads quota or installs packages.
import { refreshUpdateCache, UPDATE_WORKER_DEADLINE_MS } from './update-cache.js';

const timer = setTimeout(() => process.exit(0), UPDATE_WORKER_DEADLINE_MS);
try {
  if (process.argv[2]) await refreshUpdateCache({ cacheFile: process.argv[2] });
} catch { /* all output is intentionally silent */ }
finally { clearTimeout(timer); }
// Do not let registry keep-alive sockets prolong the detached worker lifetime.
process.exit(0);
