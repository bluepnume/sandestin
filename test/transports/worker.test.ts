import { Worker } from 'node:worker_threads';

import type { Remote } from '../../src';

import type { Api } from './api';
import type { BuiltFixtures } from './build';
import type { Envelope } from './protocol';

import { exerciseApi, EXPECTED_RESULTS } from './api';
import { buildFixtures } from './build';
import { createPeer } from './protocol';

type Report = { readonly type : 'reported', readonly log : ReadonlyArray<string>, readonly live : number };

describe('a worker thread over a MessagePort (structured clone)', () => {
    let fixtures : BuiltFixtures;

    beforeAll(async () => {
        fixtures = await buildFixtures();
    }, 60_000);

    afterAll(async () => {
        await fixtures.cleanup();
    });

    it('serves functions, promises, callbacks and errors across the thread boundary', async () => {
        const worker = new Worker(`${ fixtures.dir }/test/transports/worker-side.js`);

        try {
            const api = await new Promise<Remote<Api>>(resolve => {
                const peer = createPeer({
                    channel:                 'main',
                    post:                    envelope => worker.postMessage(envelope, []),
                    onValue:                 value => resolve(value as Remote<Api>),
                    authorizeInboundRequest: ({ context }) => context.channel === 'main'
                });

                worker.on('message', (message : Envelope | Report) => {
                    if (message.type !== 'reported') {
                        peer.receive(message);
                    }
                });
            });

            expect(await exerciseApi({ api })).toEqual(EXPECTED_RESULTS);

            const report = await new Promise<Report>(resolve => {
                worker.once('message', (message : Report) => resolve(message));
                worker.postMessage({ type: 'report' }, []);
            });

            expect(report.log).toEqual([ 'once released' ]);
            // Everything the worker still holds is what the main side still references.
            expect(report.live).toBeGreaterThan(0);
        } finally {
            await worker.terminate();
        }
    }, 30_000);
});
