import type { Sandestin, SandestinOptions } from '../types';

import { sandestin } from '../sandestin';

export type PairContext = {
    readonly from : 'a' | 'b',
};

type Inherited = 'authorizeInboundRequest' | 'includeStacks' | 'types' | 'callTimeout';

export type PairOptions = Pick<SandestinOptions<PairContext>, Inherited> & {
    // Where a refused release or watch ends up. A real transport would drop
    // these on the floor too; the default does the same, visibly named.
    readonly onError ?: (err : unknown) => void,
};

export type Pair = readonly [ Sandestin<PairContext>, Sandestin<PairContext> ];

const dropped = () : void => undefined;

type Sides = {
    readonly a : Sandestin<PairContext>,
    readonly b : Sandestin<PairContext>,
};

type SideOptions = {
    readonly other : () => Sandestin<PairContext>,
    readonly from : 'a' | 'b',
    readonly options : Omit<PairOptions, 'onError'>,
    readonly onError : (err : unknown) => void,
};

// One side: every outbound hook calls the other side's matching inbound
// method directly.
const side = ({ other, from, options, onError } : SideOptions) : Sandestin<PairContext> => sandestin<PairContext>({
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
