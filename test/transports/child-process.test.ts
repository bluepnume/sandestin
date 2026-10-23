import { fork } from 'node:child_process';

import type { Remote } from '../../src';

import type { Api } from './api';
import type { BuiltFixtures } from './build';
import type { Envelope } from './protocol';

import { exerciseApi, EXPECTED_RESULTS } from './api';
import { buildFixtures } from './build';
import { createPeer } from './protocol';

type Report = { readonly type : 'reported', readonly log : ReadonlyArray<string>, readonly live : number };

describe('a child process over IPC (JSON)', () => {
    let fixtures : BuiltFixtures;

    beforeAll(async () => {
        fixtures = await buildFixtures();
    }, 60_000);

    afterAll(async () => {
        await fixtures.cleanup();
    });

    it('serves functions, promises, callbacks and errors across the process boundary as text', async () => {
        const child = fork(`${ fixtures.dir }/test/transports/child-side.js`, { stdio: [ `ignore`, `inherit`, `inherit`, `ipc` ] });

        try {
            const api = await new Promise<Remote<Api>>(resolve => {
                const peer = createPeer({
                    channel:                 'parent',
                    post:                    envelope => child.send(JSON.stringify(envelope)),
                    onValue:                 value => resolve(value as Remote<Api>),
                    authorizeInboundRequest: ({ context }) => context.channel === 'parent'
                });

                child.on('message', (message : string) => {
                    const parsed = JSON.parse(message) as Envelope | Report;

                    if (parsed.type !== 'reported') {
                        peer.receive(parsed);
                    }
                });
            });

            expect(await exerciseApi({ api })).toEqual(EXPECTED_RESULTS);

            const report = await new Promise<Report>(resolve => {
                child.once('message', (message : string) => resolve(JSON.parse(message) as Report));
                child.send(JSON.stringify({ type: 'report' }));
            });

            expect(report.log).toEqual([ 'once released' ]);
            expect(report.live).toBeGreaterThan(0);
        } finally {
            child.kill();
        }
    }, 30_000);
});
