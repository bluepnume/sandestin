import type { CustomType, Outcome } from '../src';

import { ref, sandestin } from '../src';

import { pair } from './helpers';

type Seen = { readonly phase : string, readonly context : unknown };

// A custom type that only records the context it was given.
type TagTypeOptions = { readonly seen : Array<Seen> };

const tagType = ({ seen } : TagTypeOptions) : CustomType<{ tag : string }, string> => ({
    name: 'tag',
    test: value => typeof value === 'object' && value !== null && 'tag' in value,

    encode: ({ value, context }) => {
        seen.push({ phase: 'encode', context });

        return value.tag;
    },

    decode: ({ value, context }) => {
        seen.push({ phase: 'decode', context });

        return { tag: value };
    }
});

describe('context flows with the handle', () => {
    it('reaches custom types from encode and decode', () => {
        const seen : Array<Seen> = [];
        const [ a, b ] = pair({ types: [ tagType({ seen }) ] });
        const wire = a.encode({ value: { tag: 'x' }, context: { from: 'a' } });

        b.decode({ wire, context: { from: 'b' } });

        expect(seen).toEqual([
            { phase: 'encode', context: { from: 'a' } },
            { phase: 'decode', context: { from: 'b' } }
        ]);
    });

    it('is undefined when none was given', () => {
        const seen : Array<Seen> = [];
        const [ a, b ] = pair({ types: [ tagType({ seen }) ] });

        b.decodeJSON({ text: a.encodeJSON({ value: { tag: 'x' } }) });

        expect(seen).toEqual([
            { phase: 'encode', context: undefined },
            { phase: 'decode', context: undefined }
        ]);
    });

    it('a call encodes its arguments under the context the ref was decoded with', async () => {
        const seen : Array<Seen> = [];
        const [ a, b ] = pair({ types: [ tagType({ seen }) ] });
        const echo = (value : { tag : string }) : { tag : string } => value;
        const remote = b.decode<typeof echo>({ wire: a.encode({ value: echo }), context: { from: 'b' } });

        await remote({ tag: 'arg' });

        expect(seen.map(entry => entry.phase)).toEqual([ 'encode', 'decode', 'encode', 'decode' ]);
        // b encodes the argument under its decode context; a decodes it and
        // encodes the result under the request's context; b decodes the
        // result under the ref's context again.
        expect(seen[0]?.context).toEqual({ from: 'b' });
        expect(seen[1]?.context).toEqual({ from: 'b' });
        expect(seen[2]?.context).toEqual({ from: 'b' });
        expect(seen[3]?.context).toEqual({ from: 'b' });
    });

    it('a promise settles under the context it was encoded with', async () => {
        const seen : Array<Seen> = [];
        const [ a, b ] = pair({ types: [ tagType({ seen }) ] });
        const wire = a.encode({ value: Promise.resolve({ tag: 'later' }), context: { from: 'a' } });

        expect(await b.decode<Promise<{ tag : string }>>({ wire, context: { from: 'b' } })).toEqual({ tag: 'later' });

        expect(seen).toEqual([
            { phase: 'encode', context: { from: 'a' } },
            { phase: 'decode', context: { from: 'b' } }
        ]);
    });

    it('the gate sees the context the handle was encoded under', async () => {
        const gates : Array<unknown> = [];

        const [ a, b ] = pair({
            authorizeInboundRequest: ({ context, handleContext }) => {
                gates.push({ context, handleContext });

                return true;
            }
        });

        const remote = b.decode<() => number>({ wire: a.encode({ value: () => 1, context: { from: 'a' } }) });

        await remote();

        expect(gates).toEqual([ { context: { from: 'b' }, handleContext: { from: 'a' } } ]);
    });

    it('a per-function gate sees it too', async () => {
        const gates : Array<unknown> = [];
        const [ a, b ] = pair();

        const guarded = ref({
            fn: () => 1,

            authorize: ({ context, handleContext }) => {
                gates.push({ context, handleContext });

                return true;
            }
        });

        const remote = b.decode<() => number>({ wire: a.encode({ value: guarded, context: { from: 'a' } }) });

        await remote();

        expect(gates).toEqual([ { context: { from: 'b' }, handleContext: { from: 'a' } } ]);
    });

    it('the outbound hooks receive the context of the ref or promise', async () => {
        const hooks : Array<unknown> = [];
        const [ a ] = pair();

        const holder = sandestin<{ readonly from : string }>({
            invokeRemoteFunction: ({ handle, args, context, reply }) => {
                hooks.push({ hook: 'invoke', context, reply });

                return a.invokeLocalFunction({ handle, args, context: { from: 'b' } });
            },

            releaseRemoteHandle: ({ context }) => {
                hooks.push({ hook: 'release', context });
            },

            watchRemotePromise: ({ handle, context }) => {
                hooks.push({ hook: 'watch', context });

                return a.watchLocalPromise({ handle, context: { from: 'b' } });
            }
        });

        const value = { fn: () => 'called', later: Promise.resolve('settled') };
        const remote = holder.decode<typeof value>({ wire: a.encode({ value }), context: { from: 'window-a' } });

        expect(await remote.fn()).toBe('called');
        expect(await remote.later).toBe('settled');
        remote.fn[Symbol.dispose]();

        expect(hooks).toEqual([
            { hook: 'watch', context: { from: 'window-a' } },
            { hook: 'invoke', context: { from: 'window-a' }, reply: true },
            { hook: 'release', context: { from: 'window-a' } }
        ]);
    });
});

describe('thenables', () => {
    class Deferred {
        then(resolve : (value : string) => void) : void {
            resolve('from a thenable');
        }
    }

    it('cross as promises', async () => {
        const [ a, b ] = pair();
        const wire = a.encodeJSON({ value: { pending: new Deferred() } });

        expect(JSON.parse(wire)).toEqual({ pending: { $type: 'promise', $value: expect.any(String) } });

        const remote = b.decodeJSON<{ pending : Promise<string> }>({ text: wire });

        expect(remote.pending).toBeInstanceOf(Promise);
        expect(await remote.pending).toBe('from a thenable');
    });

    it('are the same handle when encoded twice', () => {
        const [ a ] = pair();
        const pending = new Deferred();
        const first = a.encode({ value: pending }) as { $value : string };
        const second = a.encode({ value: pending }) as { $value : string };

        expect(second.$value).toBe(first.$value);
        expect(a.liveHandleCount()).toBe(1);
    });

    it('come back as the original thenable when returned to the owner', () => {
        const [ a, b ] = pair();
        const pending = new Deferred();
        const remote = b.decode<Promise<string>>({ wire: a.encode({ value: pending }) });

        expect(a.decode({ wire: b.encode({ value: remote }) })).toBe(pending);
    });
});

describe('hasHandle', () => {
    it('says whether this side still holds what a handle names', () => {
        const [ a, b ] = pair();
        const wire = a.encode({ value: () => 1 }) as { $value : { handle : string } };
        const remote = b.decode<() => number>({ wire });

        expect(a.hasHandle({ handle: wire.$value.handle })).toBe(true);
        expect(a.hasHandle({ handle: 'no-such-handle' })).toBe(false);
        expect(b.hasHandle({ handle: wire.$value.handle })).toBe(false);

        remote[Symbol.dispose]();

        expect(a.hasHandle({ handle: wire.$value.handle })).toBe(false);
    });
});

describe('reply: false', () => {
    it('runs the function but resolves with nothing and drops the result', async () => {
        const [ a, b ] = pair();
        let calls = 0;

        const remote = b.decode<() => string>({
            wire: a.encode({
                value: () => {
                    calls += 1;

                    return 'ignored';
                }
            })
        });

        expect(await remote.invoke({ args: [], reply: false })).toBeUndefined();
        expect(calls).toBe(1);
    });

    it('drops a thrown error too', async () => {
        const [ a, b ] = pair();

        const remote = b.decode<() => never>({
            wire: a.encode({
                value: () => {
                    throw new Error('nobody is listening');
                }
            })
        });

        await expect(remote.invoke({ args: [], reply: false })).resolves.toBeUndefined();
    });

    it('lets the transport answer with nothing', async () => {
        const [ a ] = pair();
        const seen : Array<boolean> = [];

        const holder = sandestin({
            invokeRemoteFunction: ({ handle, args, reply }) => {
                seen.push(reply);

                if (!reply) {
                    void a.invokeLocalFunction({ handle, args, context: { from: 'b' } });

                    return Promise.resolve();
                }

                return a.invokeLocalFunction({ handle, args, context: { from: 'b' } });
            },

            releaseRemoteHandle: () => undefined,
            watchRemotePromise:  () => Promise.reject(new Error('unused'))
        });

        const remote = holder.decode<() => number>({ wire: a.encode({ value: () => 7 }) });

        expect(await remote.invoke({ args: [], reply: false })).toBeUndefined();
        expect(await remote()).toBe(7);
        expect(seen).toEqual([ false, true ]);
    });
});

describe('the watch hook', () => {
    it('rejecting fails the remote promise with that error', async () => {
        const [ a ] = pair();

        const holder = sandestin({
            invokeRemoteFunction: () => Promise.reject(new Error('unused')),
            releaseRemoteHandle:  () => undefined,
            watchRemotePromise:   () => Promise.reject(new Error('window closed'))
        });

        const remote = holder.decode<Promise<number>>({ wire: a.encode({ value: Promise.resolve(1) }) });

        await expect(remote).rejects.toThrow('window closed');
    });

    it('throwing synchronously does the same', async () => {
        const [ a ] = pair();

        const holder = sandestin({
            invokeRemoteFunction: () => Promise.reject(new Error('unused')),
            releaseRemoteHandle:  () => undefined,

            watchRemotePromise: () : Promise<Outcome> => {
                throw new Error('no transport');
            }
        });

        const remote = holder.decode<Promise<number>>({ wire: a.encode({ value: Promise.resolve(1) }) });

        await expect(remote).rejects.toThrow('no transport');
    });
});
