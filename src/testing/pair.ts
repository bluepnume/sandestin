import type { Serdes, SerdesOptions } from '../types';

import { createSerdes } from '../serdes';

export type PairContext = {
    readonly from : 'a' | 'b',
};

export type PairOptions = Pick<SerdesOptions<PairContext>, 'authorizeInboundRequest' | 'includeStacks'> & {
    // Where a refused release or watch ends up. A real transport would drop
    // these on the floor too; the default does the same, visibly named.
    readonly onError ?: (err : unknown) => void,
};

export type Pair = readonly [ Serdes<PairContext>, Serdes<PairContext> ];

const dropped = () : void => undefined;

type Sides = {
    readonly a : Serdes<PairContext>,
    readonly b : Serdes<PairContext>,
};

type SideOptions = {
    readonly other : () => Serdes<PairContext>,
    readonly from : 'a' | 'b',
    readonly options : Omit<PairOptions, 'onError'>,
    readonly onError : (err : unknown) => void,
};

// One side: every outbound hook calls the other side's matching inbound
// method directly.
const side = ({ other, from, options, onError } : SideOptions) : Serdes<PairContext> => createSerdes<PairContext>({
    ...options,
    invokeRemoteFunction: ({ handle, args }) => other().invokeLocalFunction({ handle, args, context: { from } }),

    releaseRemoteHandle: ({ handle }) => {
        void other().releaseLocalHandle({ handle, context: { from } }).catch(onError);
    },

    watchRemotePromise: ({ handle, listener }) => {
        void other().watchLocalPromise({ handle, listener, context: { from } }).catch(onError);
    }
});

// Two instances wired directly to each other. No messages, no transport.
// This is how the package tests itself and how a layer above can test
// without a window.
export const pair = ({ onError = dropped, ...options } : PairOptions = {}) : Pair => {
    const sides : Sides = {
        a: side({ other: () => sides.b, from: 'a', options, onError }),
        b: side({ other: () => sides.a, from: 'b', options, onError })
    };

    return [ sides.a, sides.b ];
};
