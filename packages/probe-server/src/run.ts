import { ProbeServer } from './server.js';

const host = process.env.COCOS_AI_PROBE_HOST ?? '127.0.0.1';
const port = Number(process.env.COCOS_AI_PROBE_PORT ?? '32188');
const requestTimeoutMs = Number(process.env.COCOS_AI_PROBE_TIMEOUT_MS ?? '10000');

const server = new ProbeServer({ host, port, requestTimeoutMs });
const address = await server.start();
console.log(JSON.stringify({ type: 'probe-server.ready', url: `ws://${address.host}:${address.port}` }));

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
