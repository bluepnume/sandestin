import type { Envelope } from './protocol';

// Runs as a separate OS process: serves the sample API over Node IPC, where
// every envelope is JSON text, so this exercises encodeJSON / decodeJSON.
import { buildApi } from './api';
import { createPeer } from './protocol';

const send = (message : unknown) : void => {
    if (!process.send) {
        throw new Error('child-side must run with an IPC channel');
    }

    process.send(message);
};

const log : Array<string> = [];

const peer = createPeer({
    channel:                 'child',
    json:                    true,
    post:                    envelope => send(JSON.stringify(envelope)),
    onValue:                 () => undefined,
    authorizeInboundRequest: ({ context }) => context.channel === 'child'
});

process.on('message', (message : string) => {
    const parsed = JSON.parse(message) as Envelope | { readonly type : 'report' };

    if (parsed.type === 'report') {
        send(JSON.stringify({ type: 'reported', log, live: peer.serdes.liveHandleCount() }));

        return;
    }

    peer.receive(parsed);
});

peer.send(buildApi({ log: line => log.push(line) }));
