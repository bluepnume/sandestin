import { builtinTypes } from '../src';

import { pair } from './helpers';

// Round-trips a value through side a's encoder and side b's decoder, via the
// string form so every test proves the wire is plain JSON.
const roundTrip = (value : unknown) : unknown => {
    const [ a, b ] = pair({ types: builtinTypes });

    return b.decodeJSON({ text: a.encodeJSON({ value }) });
};

describe('plain values survive a round trip', () => {
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
        expect(roundTrip(value)).toEqual(value);
    });

    it('flattens negative zero, as JSON does', () => {
        expect(Object.is(roundTrip(-0), 0)).toBe(true);
    });

    it('keeps object key order', () => {
        expect(Object.keys(roundTrip({ z: 1, a: 2, m: 3 }) as object)).toEqual([ 'z', 'a', 'm' ]);
    });

    it('round-trips Date, Map, Set and undefined', () => {
        const date = new Date('2026-10-22T20:00:00.000Z');
        const value = { date, map: new Map([ [ 'k', { v: 1 } ] ]), set: new Set([ 1, 2 ]), gap: undefined };
        const result = roundTrip(value) as typeof value;

        expect(result.date).toBeInstanceOf(Date);
        expect(result.date.toISOString()).toBe(date.toISOString());
        expect(result.map).toBeInstanceOf(Map);
        expect([ ...result.map ]).toEqual([ [ 'k', { v: 1 } ] ]);
        expect(result.set).toBeInstanceOf(Set);
        expect([ ...result.set ]).toEqual([ 1, 2 ]);
        expect(Object.hasOwn(result, 'gap')).toBe(true);
        expect(result.gap).toBeUndefined();
    });

    it('round-trips RegExp, bigint and typed arrays', () => {
        const value = {
            re:    /a+b/giu,
            big:   123_456_789_012_345_678_901_234_567_890n,
            bytes: new Uint8Array([ 1, 2, 255 ]),
            buf:   new Uint8Array([ 9, 8 ]).buffer,
            f64:   new Float64Array([ 1.5, -2.5 ])
        };

        const result = roundTrip(value) as typeof value;

        expect(result.re).toBeInstanceOf(RegExp);
        expect(result.re.source).toBe('a+b');
        expect(result.re.flags).toBe('giu');
        expect(result.big).toBe(value.big);
        expect([ ...result.bytes ]).toEqual([ 1, 2, 255 ]);
        expect(result.buf).toBeInstanceOf(ArrayBuffer);
        expect([ ...new Uint8Array(result.buf) ]).toEqual([ 9, 8 ]);
        expect(result.f64).toBeInstanceOf(Float64Array);
        expect([ ...result.f64 ]).toEqual([ 1.5, -2.5 ]);
    });

    it('round-trips a typed array view that does not start at the buffer start', () => {
        const backing = new Uint8Array([ 0, 0, 7, 8, 9 ]);
        const view = new Uint8Array(backing.buffer, 2, 2);

        expect([ ...(roundTrip(view) as Uint8Array) ]).toEqual([ 7, 8 ]);
    });

    it('round-trips a bare undefined and undefined inside arrays', () => {
        expect(roundTrip(undefined)).toBeUndefined();
        expect(roundTrip([ 1, undefined, 3 ])).toEqual([ 1, undefined, 3 ]);
    });

    it('round-trips cycles and shared references', () => {
        const shared = { name: 'shared' };

        type Cyclic = { self ?: unknown, left : typeof shared, right : typeof shared, list : Array<unknown> };

        const value : Cyclic = { left: shared, right: shared, list: [] };

        value.self = value;
        value.list.push(value.list);

        const result = roundTrip(value) as Cyclic;

        expect(result.self).toBe(result);
        expect(result.left).toBe(result.right);
        expect(result.left).toEqual({ name: 'shared' });
        expect(result.list[0]).toBe(result.list);
    });

    it('escapes a user object that looks like a record', () => {
        const value = { $type: 'function', $value: 'not a handle', extra: 1 };

        expect(roundTrip(value)).toEqual(value);
    });

    it('escapes a nested record-looking object inside an array', () => {
        expect(roundTrip([ { $type: 'map', $value: [] } ])).toEqual([ { $type: 'map', $value: [] } ]);
    });

    it('passes values with a $type key but no $value through the escape too', () => {
        expect(roundTrip({ $type: 'only' })).toEqual({ $type: 'only' });
    });
});

describe('the wire', () => {
    it('is plain JSON-safe data that structuredClone also carries unchanged', () => {
        const [ a, b ] = pair({ types: builtinTypes });
        const value = { when: new Date(0), tag: /x/, nested: { list: [ 1, 2 ] }, map: new Map([ [ 1, 2 ] ]) };
        const wire = a.encode({ value });

        expect(JSON.parse(a.encodeJSON({ value }))).toEqual(wire);
        expect(b.decode({ wire: structuredClone(wire) })).toEqual(value);
    });

    it('uses one record shape for every special value', () => {
        const [ a ] = pair({ types: builtinTypes });

        expect(JSON.parse(a.encodeJSON({ value: { when: new Date(0), tag: /x/ } }))).toEqual({
            when: { $type: 'date', $value: '1970-01-01T00:00:00.000Z' },
            tag:  { $type: 'regexp', $value: { source: 'x', flags: '' } }
        });
    });

    it('without dateType registered, a Date is whatever the transport makes of it', () => {
        const [ a, b ] = pair();

        // Passed through untouched: JSON's own toJSON turns it into text,
        // structured clone would keep it a Date.
        expect(b.decodeJSON({ text: a.encodeJSON({ value: { when: new Date(0) } }) })).toEqual({ when: `1970-01-01T00:00:00.000Z` });
        const cloned = structuredClone(a.encode({ value: { when: new Date(0) } }));

        expect(b.decode({ wire: cloned })).toEqual({ when: new Date(0) });
    });

    it('passes a class instance through, which loses its prototype in transit', () => {
        class Thing {
            readonly label = 'thing';
        }

        const [ a, b ] = pair();
        const result = b.decodeJSON({ text: a.encodeJSON({ value: new Thing() }) });

        expect(result).toEqual({ label: 'thing' });
        expect(result).not.toBeInstanceOf(Thing);
    });

    it('rejects an unknown record type on decode', () => {
        const [ , b ] = pair();

        expect(() => b.decodeJSON({ text: JSON.stringify({ $type: `nope`, $value: 1 }) })).toThrow(/Unknown record type/);
    });

    it('rejects an unknown bytes kind on decode', () => {
        const [ , b ] = pair({ types: builtinTypes });

        expect(() => b.decodeJSON({ text: JSON.stringify({ $type: 'bytes', $value: { kind: 'Nope', base64: '' } }) }))
            .toThrow(/Unknown bytes kind/);
    });
});
