// Bundle for process tests without touching the user's port or token.
import { runServer } from '../../src/server/index.js';
import { readToken } from '../../src/token/store.js';

await runServer({ port: Number(process.argv[2]), token: readToken(process.argv[3]) });
