import type { Remote } from '../../src';

import type { Api } from './api';
import type { Envelope } from './protocol';

// Runs in headless Chromium: a real iframe, a real window.postMessage, origin
// checks on both sides. The iframe loads the same modules through vite.
import { exerciseApi, EXPECTED_RESULTS } from './api';
import { createPeer } from './protocol';

type Report = { readonly type : 'reported', readonly log : ReadonlyArray<string>, readonly live : number };

type IframeError = { readonly type : 'iframe-error', readonly message : string };

type Inbound = Envelope | Report | IframeError;

// An about:srcdoc frame cannot resolve root-relative URLs, so the module
// specifiers carry the page origin.
type IframeSourceOptions = { readonly origin : string };

const iframeSource = ({ origin } : IframeSourceOptions) : string => `
    <!doctype html>
    <script type="module">
        const report = message => window.parent.postMessage({ type: 'iframe-error', message }, '${ origin }');

        window.addEventListener('error', event => report(String(event.message)));
        window.addEventListener('unhandledrejection', event => report(String(event.reason)));

        import { buildApi } from '${ origin }/test/transports/api.ts';
        import { createPeer } from '${ origin }/test/transports/protocol.ts';

        const log = [];

        const peer = createPeer({
            channel: 'iframe',
            post: envelope => window.parent.postMessage(envelope, '${ origin }'),
            onValue: () => undefined,
            authorizeInboundRequest: ({ context }) => context.channel === 'iframe'
        });

        window.addEventListener('message', event => {
            if (event.origin !== '${ origin }' || event.source !== window.parent) {
                return;
            }

            if (event.data.type === 'report') {
                window.parent.postMessage({ type: 'reported', log, live: peer.serdes.liveHandleCount() }, '${ origin }');

                return;
            }

            peer.receive(event.data);
        });

        peer.send(buildApi({ log: line => log.push(line) }));
    </script>
`;

describe('an iframe over window.postMessage', () => {
    it('serves functions, promises, callbacks and errors across the frame boundary', async () => {
        const iframe = document.createElement('iframe');
        const origin = window.location.origin;

        iframe.srcdoc = iframeSource({ origin });
        document.body.append(iframe);

        const target = () : Window => {
            if (!iframe.contentWindow) {
                throw new Error('iframe has no window');
            }

            return iframe.contentWindow;
        };

        const fromIframe = (event : MessageEvent) : Inbound | undefined =>
            (event.origin === origin && event.source === iframe.contentWindow
                ? event.data as Inbound
                : undefined);

        try {
            const api = await new Promise<Remote<Api>>((resolve, reject) => {
                const peer = createPeer({
                    channel:                 'parent',
                    post:                    envelope => target().postMessage(envelope, origin),
                    onValue:                 value => resolve(value as Remote<Api>),
                    authorizeInboundRequest: ({ context }) => context.channel === 'parent'
                });

                window.addEventListener('message', event => {
                    const message = fromIframe(event);

                    if (message?.type === 'iframe-error') {
                        reject(new Error(`iframe: ${ message.message }`));
                    } else if (message !== undefined && message.type !== 'reported') {
                        peer.receive(message);
                    }
                });
            });

            expect(await exerciseApi({ api })).toEqual(EXPECTED_RESULTS);

            const report = await new Promise<Report>(resolve => {
                window.addEventListener('message', event => {
                    const message = fromIframe(event);

                    if (message?.type === 'reported') {
                        resolve(message);
                    }
                });

                target().postMessage({ type: 'report' }, origin);
            });

            expect(report.log).toEqual([ 'once released' ]);
            expect(report.live).toBeGreaterThan(0);
        } finally {
            iframe.remove();
        }
    }, 30_000);
});
