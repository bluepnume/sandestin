// Runs inside a worker thread: builds the sample API and serves it over the
// parent port using structured clone.
import { parentPort } from 'node:worker_threads';

import type { Envelope } from './protocol';

import { buildApi } from './api';
import { createPeer } from './protocol';

if (!parentPort) {
    throw new Error('worker-side must run inside a worker thread');
}

const port = parentPort;
const log : Array<string> = [];

const peer = createPeer({
    channel:                 'worker',
    post:                    envelope => port.postMessage(envelope, []),
    onValue:                 () => undefined,
    authorizeInboundRequest: ({ context }) => context.channel === 'worker'
});

port.on('message', (message : Envelope | { readonly type : 'report' }) => {
    if (message.type === 'report') {
        port.postMessage({ type: 'reported', log, live: peer.serdes.liveHandleCount() }, []);

        return;
    }

    peer.receive(message);
});

peer.send(buildApi({ log: line => log.push(line) }));
