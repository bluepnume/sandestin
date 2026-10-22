import type { Remote } from '../../src';

// The value every transport test ships across, and the checks run on it from
// the other side. Keeping both here means each transport proves the same
// behaviour and only differs in how the envelopes travel.
import { ref } from '../../src';

export type Api = {
    readonly name : string,
    readonly add : (options : { readonly x : number, readonly y : number }) => number,
    readonly fail : () => never,
    readonly later : Promise<string>,
    readonly once : () => string,
    readonly subscribe : (listener : (event : string) => Promise<void>) => Promise<number>,
    readonly nested : {
        readonly when : Date,
        readonly make : () => { readonly inner : () => string },
    },
};

type BuildApiOptions = { readonly log : (line : string) => void };

export const buildApi = ({ log } : BuildApiOptions) : Api => ({
    name: 'sample api',
    add:  ({ x, y }) => x + y,

    fail: () => {
        throw new RangeError('out of range');
    },

    later: new Promise<string>(resolve => {
        setTimeout(() => resolve('settled'), 10);
    }),

    once: ref({ fn: () => 'one shot', once: true, onRelease: () => log('once released') }),

    subscribe: async listener => {
        await listener('tick');
        await listener('tock');

        return 2;
    },

    nested: {
        when: new Date('2026-01-01T00:00:00.000Z'),
        make: () => ({ inner: () => 'from inner' })
    }
});

const describeError = (err : unknown) : string => (err instanceof Error
    ? `${ err.name }:${ err.message }`
    : String(err));

const errorName = (err : unknown) : string => (err instanceof Error
    ? err.name
    : String(err));

type ExerciseApiOptions = { readonly api : Remote<Api> };

export const exerciseApi = async ({ api } : ExerciseApiOptions) : Promise<ReadonlyArray<string>> => {
    const events : Array<string> = [];

    const subscribed = await api.subscribe(event => {
        events.push(event);

        return Promise.resolve();
    });

    const made = await api.nested.make();

    return [
        `name=${ api.name }`,
        `add=${ await api.add({ x: 2, y: 40 }) }`,
        `fail=${ await api.fail().catch(describeError) }`,
        `later=${ await api.later }`,
        `once=${ await api.once() }`,
        `once again=${ await api.once().catch(errorName) }`,
        `subscribe=${ subscribed }`,
        `events=${ events.join(',') }`,
        `when=${ api.nested.when.toISOString() }`,
        `inner=${ await made.inner() }`
    ];
};

export const EXPECTED_RESULTS = [
    'name=sample api',
    'add=42',
    'fail=RangeError:out of range',
    'later=settled',
    'once=one shot',
    'once again=ReleasedError',
    'subscribe=2',
    'events=tick,tock',
    'when=2026-01-01T00:00:00.000Z',
    'inner=from inner'
];
