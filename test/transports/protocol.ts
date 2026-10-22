import type { Outcome, Serdes, SerdesOptions } from '../../src';

// The smallest message protocol that carries the three inbound methods over a
// channel. Shared by the worker, child-process and browser transport tests;
// each one only supplies `post` and feeds `receive`.
import { createSerdes } from '../../src';

export type Envelope =
    | { readonly type : 'value', readonly wire : unknown }
    | { readonly type : 'invoke', readonly id : number, readonly handle : string, readonly args : unknown }
    | { readonly type : 'result', readonly id : number, readonly outcome : Outcome }
    | { readonly type : 'release', readonly handle : string }
    | { readonly type : 'watch', readonly handle : string }
    | { readonly type : 'settle', readonly handle : string, readonly outcome : Outcome };

export type PeerContext = {
    readonly channel : string,
};

export type PeerOptions = {
    readonly channel : string,
    // Deliver an envelope to the other side. In JSON mode the caller is
    // expected to stringify; the peer just hands over objects.
    readonly post : (envelope : Envelope) => void,
    readonly onValue : (value : unknown) => void,
    readonly json ?: boolean,
    readonly authorizeInboundRequest ?: SerdesOptions<PeerContext>['authorizeInboundRequest'],
};

export type Peer = {
    readonly serdes : Serdes<PeerContext>,
    readonly send : (value : unknown) => void,
    readonly receive : (envelope : Envelope) => void,
};

export const createPeer = ({ channel, post, onValue, json = false, authorizeInboundRequest } : PeerOptions) : Peer => {
    const pending = new Map<number, (outcome : Outcome) => void>();
    const watchers = new Map<string, (outcome : Outcome) => void>();
    let nextId = 0;
    const context : PeerContext = { channel };

    const serdes = createSerdes<PeerContext>({
        authorizeInboundRequest,

        invokeRemoteFunction: ({ handle, args }) => new Promise(resolve => {
            const id = nextId;

            nextId += 1;

            pending.set(id, resolve);
            post({ type: 'invoke', id, handle, args });
        }),

        releaseRemoteHandle: ({ handle }) => post({ type: 'release', handle }),

        watchRemotePromise: ({ handle, listener }) => {
            watchers.set(handle, listener);
            post({ type: 'watch', handle });
        }
    });

    // In JSON mode every wire inside an envelope is a string produced by
    // encodeJSON; in clone mode it is the structured-cloneable object.
    const encode = (value : unknown) : unknown => (json
        ? serdes.encodeJSON({ value })
        : serdes.encode({ value }));

    const decode = (wire : unknown) : unknown => (json
        ? serdes.decodeJSON({ text: wire as string })
        : serdes.decode({ wire }));

    const receive = (envelope : Envelope) : void => {
        switch (envelope.type) {
            case 'value':
                onValue(decode(envelope.wire));
                break;
            case 'invoke':
                void serdes.invokeLocalFunction({ handle: envelope.handle, args: envelope.args, context })
                    .then(outcome => post({ type: 'result', id: envelope.id, outcome }));

                break;
            case 'result':
                pending.get(envelope.id)?.(envelope.outcome);
                pending.delete(envelope.id);
                break;
            case 'release':
                void serdes.releaseLocalHandle({ handle: envelope.handle, context }).catch(() => undefined);
                break;
            case 'watch':
                void serdes.watchLocalPromise({
                    handle:   envelope.handle,
                    listener: outcome => post({ type: 'settle', handle: envelope.handle, outcome }),
                    context
                }).catch(() => undefined);

                break;
            case 'settle':
                watchers.get(envelope.handle)?.(envelope.outcome);
                watchers.delete(envelope.handle);
                break;
            default:
                throw new Error(`Unknown envelope: ${ JSON.stringify(envelope) }`);
        }
    };

    return {
        serdes,
        receive,
        send: value => post({ type: 'value', wire: encode(value) })
    };
};
