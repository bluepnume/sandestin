import type { Ref } from '../src';

import { isRef, ref, release, ReleasedError, revoke } from '../src';

import { pair } from './helpers';

describe('functions cross as live references', () => {
    it('calls the original and returns its result', async () => {
        const [ a, b ] = pair();
        const calls : Array<unknown> = [];

        const api = {
            add: ({ x, y } : { x : number, y : number }) : number => {
                calls.push({ x, y });

                return x + y;
            }
        };

        const remote = b.decode<typeof api>({ wire: a.encode({ value: api }) });

        expect(await remote.add({ x: 2, y: 3 })).toBe(5);
        expect(calls).toEqual([ { x: 2, y: 3 } ]);
        expect(a.liveHandleCount()).toBe(1);
    });

    it('awaits async originals and passes back whatever they resolve to', async () => {
        const [ a, b ] = pair();
        const remote = b.decode({ wire: a.encode({ value: () => Promise.resolve({ nested: [ 1, 2 ] }) }) }) as Ref;

        expect(await remote()).toEqual({ nested: [ 1, 2 ] });
    });

    it('returns functions and promises from calls, nested as deep as you like', async () => {
        const [ a, b ] = pair();

        type Item = { item : string, setQuantity : (qty : number) => string };
        type Cart = { add : (options : { id : string }) => Item, total : Promise<number> };

        const cart = () : Cart => ({
            add:   ({ id }) => ({ item: id, setQuantity: qty => `${ id } x ${ qty }` }),
            total: Promise.resolve(42)
        });

        const remoteCart = b.decode<typeof cart>({ wire: a.encode({ value: cart }) });
        const opened = await remoteCart();
        const item = await opened.add({ id: 'B1' });

        expect(item.item).toBe('B1');
        expect(await item.setQuantity(2)).toBe('B1 x 2');
        expect(await opened.total).toBe(42);
    });

    it('passes functions the other way as arguments (callbacks)', async () => {
        const [ a, b ] = pair();
        const received : Array<string> = [];

        const subscribe = async (listener : (event : string) => Promise<void>) : Promise<string> => {
            await listener('first');
            await listener('second');

            return 'subscribed';
        };

        const remote = b.decode({ wire: a.encode({ value: subscribe }) }) as Ref;

        const result = await remote((event : string) => {
            received.push(event);
        });

        expect(result).toBe('subscribed');
        expect(received).toEqual([ 'first', 'second' ]);
        expect(b.liveHandleCount()).toBe(1);
    });

    it('encodes the same function to the same handle while it is live', () => {
        const [ a ] = pair();
        const fn = () : number => 1;
        const first = a.encode({ value: fn }) as { $value : { handle : string } };
        const second = a.encode({ value: [ fn, fn ] }) as Array<{ $value : { handle : string } }>;

        expect(second[0]?.$value.handle).toBe(first.$value.handle);
        expect(second[1]?.$value.handle).toBe(first.$value.handle);
        expect(a.liveHandleCount()).toBe(1);
    });

    it('uses random, unguessable handles', () => {
        const [ a ] = pair();
        type FunctionRecord = { $type : string, $value : { handle : string } };

        const wire = a.encode({ value: [ () => 1, () => 2 ] }) as Array<FunctionRecord>;

        expect(wire[0]?.$type).toBe('function');
        expect(wire[0]?.$value.handle).toMatch(/^[0-9a-f-]{36}$/);
        expect(wire[0]?.$value.handle).not.toBe(wire[1]?.$value.handle);
    });

    it('rejects an unknown handle with ReleasedError', async () => {
        const [ , b ] = pair();
        const remote = b.decode({ wire: { $type: `function`, $value: { handle: `no-such-handle`, name: `ghost` } } }) as Ref;

        await expect(remote()).rejects.toBeInstanceOf(ReleasedError);
    });

    it('relays a foreign ref when it is encoded again', async () => {
        const [ a, b ] = pair();
        const [ b2, c ] = pair();

        const remoteOnB = b.decode({ wire: a.encode({ value: (x : number) => x * 2 }) }) as Ref;
        const remoteOnC = c.decode({ wire: b2.encode({ value: remoteOnB }) }) as Ref;

        expect(await remoteOnC(21)).toBe(42);
        expect(b2.liveHandleCount()).toBe(1);
    });

    it('marks decoded functions as refs and nothing else', () => {
        const [ a, b ] = pair();
        const remote = b.decode({ wire: a.encode({ value: () => 1 }) });

        expect(isRef(remote)).toBe(true);
        expect(isRef(() => 1)).toBe(false);
        expect(isRef(1)).toBe(false);
    });
});

describe('lifetime', () => {
    it('once: callable exactly one time', async () => {
        const [ a, b ] = pair();
        let calls = 0;

        const fn = ref({
            fn: () => {
                calls += 1;

                return calls;
            },

            once: true
        });

        const remote = b.decode({ wire: a.encode({ value: fn }) }) as Ref;

        expect(await remote()).toBe(1);
        await expect(remote()).rejects.toBeInstanceOf(ReleasedError);
        expect(calls).toBe(1);
        expect(a.liveHandleCount()).toBe(0);
    });

    it('once: a second concurrent call is refused before the first finishes', async () => {
        const [ a, b ] = pair();

        const fn = ref({
            fn: () => new Promise(resolve => {
                setTimeout(() => resolve('done'), 20);
            }),

            once: true
        });

        const remote = b.decode({ wire: a.encode({ value: fn }) }) as Ref;

        const first = remote();
        const second = remote();
        // Observe the rejection before waiting on the first call, or it is
        // briefly unhandled.
        const secondRefused = expect(second).rejects.toBeInstanceOf(ReleasedError);

        expect(await first).toBe('done');
        await secondRefused;
    });

    it('onRelease fires once, by whichever route releases first', async () => {
        const [ a, b ] = pair();
        const released : Array<string> = [];

        const api = {
            byOnce:    ref({ fn: () => 1, once: true, onRelease: () => released.push('once') }),
            byRelease: ref({ fn: () => 2, onRelease: () => released.push('release') }),
            byRevoke:  ref({ fn: () => 3, onRelease: () => released.push('revoke') }),
            byClose:   ref({ fn: () => 4, onRelease: () => released.push('close') })
        };

        const remote = b.decode<typeof api>({ wire: a.encode({ value: api }) });

        await remote.byOnce();
        release({ ref: remote.byRelease });
        release({ ref: remote.byRelease });
        revoke({ fn: api.byRevoke });
        expect(released).toEqual([ 'once', 'release', 'revoke' ]);

        a.close();
        expect(released).toEqual([ 'once', 'release', 'revoke', 'close' ]);
        expect(a.liveHandleCount()).toBe(0);
    });

    it('a released ref rejects locally without a round trip', async () => {
        const [ a, b ] = pair();
        const remote = b.decode({ wire: a.encode({ value: () => 1 }) }) as Ref;

        release({ ref: remote });
        await expect(remote()).rejects.toBeInstanceOf(ReleasedError);
        expect(a.liveHandleCount()).toBe(0);
    });

    it('`using` releases at scope exit', async () => {
        const [ a, b ] = pair();
        const remote = b.decode({ wire: a.encode({ value: () => 1 }) }) as Ref;

        {
            using scoped = remote;

            expect(await scoped()).toBe(1);
        }

        await expect(remote()).rejects.toBeInstanceOf(ReleasedError);
    });

    it('revoke stops every handle, including ones encoded later', async () => {
        const [ a, b ] = pair();
        const fn = () : number => 1;
        const before = b.decode({ wire: a.encode({ value: fn }) }) as Ref;

        revoke({ fn });

        const after = b.decode({ wire: a.encode({ value: fn }) }) as Ref;

        await expect(before()).rejects.toBeInstanceOf(ReleasedError);
        await expect(after()).rejects.toBeInstanceOf(ReleasedError);
        expect(a.liveHandleCount()).toBe(0);
    });

    it('releasing an unknown or already released handle is harmless', async () => {
        const [ a ] = pair();

        await expect(a.releaseLocalHandle({ handle: 'nope', context: { from: 'b' } })).resolves.toBeUndefined();
    });

    it('close releases what this side holds and refuses further encodes', async () => {
        const [ a, b ] = pair();
        const remote = b.decode({ wire: a.encode({ value: () => 1 }) }) as Ref;

        expect(a.liveHandleCount()).toBe(1);
        b.close();
        expect(a.liveHandleCount()).toBe(0);
        await expect(remote()).rejects.toBeInstanceOf(ReleasedError);
        expect(() => b.encode({ value: 1 })).toThrow(/closed/);
        expect(() => b.decode({ wire: 1 })).toThrow(/closed/);
        expect(() => b.encodeJSON({ value: 1 })).toThrow(/closed/);
        expect(() => b.decodeJSON({ text: '1' })).toThrow(/closed/);
    });
});

describe('a ref sent back to its owner', () => {
    it('decodes as the original function, called directly', () => {
        const [ a, b ] = pair();
        const calls : Array<number> = [];

        const original = (x : number) : number => {
            calls.push(x);

            return x * 2;
        };

        const remote = b.decode<typeof original>({ wire: a.encode({ value: original }) });
        const wire = b.encode({ value: { fn: remote } });
        const returned : unknown = a.decode({ wire });
        const { fn } = returned as { fn : typeof original };

        expect(fn).toBe(original);
        expect(fn(2)).toBe(4);
        expect(calls).toEqual([ 2 ]);
        expect(b.liveHandleCount()).toBe(0);
    });

    it('crosses as a returned record naming the owner handle', () => {
        const [ a, b ] = pair();
        const wire = a.encode({ value: () => 1 }) as { $value : { handle : string } };
        const remote = b.decode({ wire });

        expect(b.encode({ value: remote })).toEqual({
            $type:  'returned',
            $value: { kind: 'function', handle: wire.$value.handle }
        });
    });

    it('is a stand-in that rejects when the owner has already released it', async () => {
        const [ a, b ] = pair();
        const once = ref({ fn: () => 'first', once: true });
        const remote = b.decode<typeof once>({ wire: a.encode({ value: once }) });

        expect(await remote()).toBe('first');

        const returned = a.decode<typeof once>({ wire: b.encode({ value: remote }) });

        expect(returned).not.toBe(once);
        await expect(returned()).rejects.toBeInstanceOf(ReleasedError);
    });

    it('still relays a ref to a third side as a new handle', async () => {
        const [ a, b ] = pair();
        const [ b2, c ] = pair();
        const original = () : string => 'from a';
        const onB = b.decode<typeof original>({ wire: a.encode({ value: original }) });
        const onC = c.decode<typeof original>({ wire: b2.encode({ value: onB }) });

        expect(await onC()).toBe('from a');
        expect(b2.liveHandleCount()).toBe(1);
    });
});

describe('the request context', () => {
    it('is the this value of the function being called', async () => {
        const [ a, b ] = pair();

        const whoAsked = function (this : { from : string }) : string {
            return `asked by ${ this.from }`;
        };

        const remote = b.decode<typeof whoAsked>({ wire: a.encode({ value: whoAsked }) });

        expect(await remote()).toBe('asked by b');
    });
});
