import { pair } from './helpers';

type Mode = 'clone' | 'json';

// Round-trips a value through side a's encoder and side b's decoder.
type RoundTripOptions = { readonly value : unknown, readonly mode : Mode };

const roundTrip = ({ value, mode } : RoundTripOptions) : unknown => {
    const [ a, b ] = pair();

    return mode === 'clone'
        ? b.decode({ wire: a.encode({ value }) })
        : b.decodeJSON({ text: a.encodeJSON({ value }) });
};

describe.each([ 'clone', 'json' ] as const)('plain values survive a %s round trip', mode => {
    it.each([
        [ 'string', 'hello' ],
        [ 'number', 42 ],
        [ 'boolean', true ],
        [ 'null', null ],
        [ 'array', [ 1, 'two', [ 3 ] ] ],
        [ 'nested object', { a: { b: { c: [ 1, { d: 'deep' } ] } } } ],
        [ 'empty object', {} ],
        [ 'empty array', [] ]
    ])('%s', (_, value) => {
        expect(roundTrip({ value, mode })).toEqual(value);
    });

    it('carries negative zero in clone mode and flattens it in JSON mode, as JSON itself does', () => {
        const result = roundTrip({ value: -0, mode }) as number;

        expect(Object.is(result, -0)).toBe(mode === 'clone');
    });

    it('keeps object key order', () => {
        const value = { z: 1, a: 2, m: 3 };

        expect(Object.keys(roundTrip({ value, mode }) as object)).toEqual([ 'z', 'a', 'm' ]);
    });

    it('round-trips Date, Map, Set and undefined', () => {
        const date = new Date('2026-10-22T20:00:00.000Z');
        const value = { date, map: new Map([ [ 'k', { v: 1 } ] ]), set: new Set([ 1, 2 ]), gap: undefined };
        const result = roundTrip({ value, mode }) as typeof value;

        expect(result.date).toBeInstanceOf(Date);
        expect(result.date.toISOString()).toBe(date.toISOString());
        expect(result.map).toBeInstanceOf(Map);
        expect([ ...result.map ]).toEqual([ [ 'k', { v: 1 } ] ]);
        expect(result.set).toBeInstanceOf(Set);
        expect([ ...result.set ]).toEqual([ 1, 2 ]);
        expect(Object.hasOwn(result, 'gap')).toBe(true);
        expect(result.gap).toBeUndefined();
    });

    it('round-trips cycles and shared references', () => {
        const shared = { name: 'shared' };
        type Cyclic = { self ?: unknown, left : typeof shared, right : typeof shared, list : Array<unknown> };
        const value : Cyclic = { left: shared, right: shared, list: [] };

        value.self = value;
        value.list.push(value.list);

        const result = roundTrip({ value, mode }) as typeof value;

        expect(result.self).toBe(result);
        expect(result.left).toBe(result.right);
        expect(result.left).toEqual({ name: 'shared' });
        expect(result.list[0]).toBe(result.list);
    });

    it('escapes a user object that looks like a record', () => {
        const value = { $type: 'function', $value: 'not a handle', extra: 1 };

        expect(roundTrip({ value, mode })).toEqual(value);
    });

    it('escapes a nested record-looking object inside an array', () => {
        const value = [ { $type: 'map', $value: [] } ];

        expect(roundTrip({ value, mode })).toEqual(value);
    });

    it('passes values with a $type key but no $value through the escape too', () => {
        const value = { $type: 'only' };

        expect(roundTrip({ value, mode })).toEqual(value);
    });
});

describe('json mode extras', () => {
    it('round-trips RegExp, bigint and typed arrays', () => {
        const value = {
            re:    /a+b/giu,
            big:   123_456_789_012_345_678_901_234_567_890n,
            bytes: new Uint8Array([ 1, 2, 255 ]),
            buf:   new Uint8Array([ 9, 8 ]).buffer,
            f64:   new Float64Array([ 1.5, -2.5 ])
        };

        const result = roundTrip({ value, mode: 'json' }) as typeof value;

        expect(result.re).toBeInstanceOf(RegExp);
        expect(result.re.source).toBe('a+b');
        expect(result.re.flags).toBe('giu');
        expect(result.big).toBe(value.big);
        expect(result.bytes).toBeInstanceOf(Uint8Array);
        expect([ ...result.bytes ]).toEqual([ 1, 2, 255 ]);
        expect(result.buf).toBeInstanceOf(ArrayBuffer);
        expect([ ...new Uint8Array(result.buf) ]).toEqual([ 9, 8 ]);
        expect(result.f64).toBeInstanceOf(Float64Array);
        expect([ ...result.f64 ]).toEqual([ 1.5, -2.5 ]);
    });

    it('round-trips a typed array view that does not start at the buffer start', () => {
        const backing = new Uint8Array([ 0, 0, 7, 8, 9 ]);
        const view = new Uint8Array(backing.buffer, 2, 2);

        expect([ ...(roundTrip({ value: view, mode: 'json' }) as Uint8Array) ]).toEqual([ 7, 8 ]);
    });

    it('round-trips a bare undefined and undefined inside arrays', () => {
        expect(roundTrip({ value: undefined, mode: 'json' })).toBeUndefined();
        expect(roundTrip({ value: [ 1, undefined, 3 ], mode: 'json' })).toEqual([ 1, undefined, 3 ]);
    });

    it('produces a string that is plain JSON', () => {
        const [ a ] = pair();
        const text = a.encodeJSON({ value: { when: new Date(0), tag: /x/ } });

        expect(typeof text).toBe('string');

        expect(JSON.parse(text)).toEqual({
            when: { $type: 'date', $value: '1970-01-01T00:00:00.000Z' },
            tag:  { $type: 'regexp', $value: { source: 'x', flags: '' } }
        });
    });

    it('rejects an unknown record type on decode', () => {
        const [ , b ] = pair();

        expect(() => b.decodeJSON({ text: JSON.stringify({ $type: `nope`, $value: 1 }) })).toThrow(/Unknown record type/);
    });

    it('rejects an unknown bytes kind on decode', () => {
        const [ , b ] = pair();

        expect(() => b.decodeJSON({ text: JSON.stringify({ $type: `bytes`, $value: { kind: `Nope`, base64: `` } }) })).toThrow(/Unknown bytes kind/);
    });
});

describe('clone mode', () => {
    it('leaves structured-clone-native values untouched', () => {
        const [ a ] = pair();
        const date = new Date(0);
        const bytes = new Uint8Array([ 1 ]);
        const wire = a.encode({ value: { date, bytes, re: /x/ } }) as { date : unknown, bytes : unknown, re : unknown };

        expect(wire.date).toBe(date);
        expect(wire.bytes).toBe(bytes);
        expect(wire.re).toBeInstanceOf(RegExp);
    });

    it('does not walk class instances', () => {
        class Thing {
            readonly fn = () : number => 1;
        }

        const [ a, b ] = pair();
        const thing = new Thing();
        const wire = a.encode({ value: { thing } }) as { thing : unknown };

        expect(wire.thing).toBe(thing);
        expect(a.liveHandleCount()).toBe(0);
        expect((b.decode({ wire }) as { thing : Thing }).thing).toBe(thing);
    });

    it('survives structured clone itself', () => {
        const [ a, b ] = pair();
        const value = { nested: { list: [ 1, 2 ] }, when: new Date(5), map: new Map([ [ 1, 2 ] ]) };
        const cloned = structuredClone(a.encode({ value }));

        expect(b.decode({ wire: cloned })).toEqual(value);
    });
});
