import type { CustomType, Ref, Remote } from '../src';

import { ref } from '../src';

import { pair } from './helpers';

class Money {
    readonly cents : number;

    readonly currency : string;

    constructor(cents : number, currency : string) {
        this.cents = cents;
        this.currency = currency;
    }

    format() : string {
        return `${ this.currency } ${ (this.cents / 100).toFixed(2) }`;
    }
}

const money : CustomType<Money, { cents : number, currency : string }> = {
    name:   'money',
    test:   value => value instanceof Money,
    encode: ({ value }) => ({ cents: value.cents, currency: value.currency }),
    decode: ({ value }) => new Money(value.cents, value.currency)
};

describe('custom by-value types', () => {
    it('rebuild the class on the far side, through text', () => {
        const [ a, b ] = pair({ types: [ money ] });
        const text = a.encodeJSON({ value: { price: new Money(1999, `USD`) } });
        const result : unknown = b.decodeJSON({ text });
        const { price } = result as { price : Money };

        expect(price).toBeInstanceOf(Money);
        expect(price.format()).toBe('USD 19.99');
    });

    it('cross as a tagged record with the custom name', () => {
        const [ a ] = pair({ types: [ money ] });

        expect(JSON.parse(a.encodeJSON({ value: new Money(5, 'EUR') }))).toEqual({
            $type:  'money',
            $value: { cents: 5, currency: 'EUR' }
        });
    });

    it('may carry functions inside an encoded form that still passes their own test', async () => {
        type Account = { readonly id : string, readonly balance : () => number };

        const account : CustomType<Account, { id : string, balance : () => number }> = {
            name:   'account',
            test:   value => typeof value === 'object' && value !== null && 'balance' in value && 'id' in value,
            encode: ({ value }) => ({ id: value.id, balance: value.balance }),
            decode: ({ value }) => value
        };

        const [ a, b ] = pair({ types: [ account ] });
        const remote = b.decode<Account>({ wire: a.encode({ value: { id: 'x', balance: () => 42 } }) });

        expect(remote.id).toBe('x');
        expect(await remote.balance()).toBe(42);
    });

    it('are tested before the built-ins, so a built-in can be overridden', () => {
        const dateAsNumber : CustomType<Date, number> = {
            name:   'epoch',
            test:   value => value instanceof Date,
            encode: ({ value }) => value.getTime(),
            decode: ({ value }) => new Date(value)
        };

        const [ a, b ] = pair({ types: [ dateAsNumber ] });
        const text = a.encodeJSON({ value: new Date(1234) });

        expect(JSON.parse(text)).toEqual({ $type: 'epoch', $value: 1234 });
        expect(b.decodeJSON<Date>({ text }).getTime()).toBe(1234);
    });

    it('must be registered on the decoding side too', () => {
        const [ a, b ] = pair();
        const [ c ] = pair({ types: [ money ] });

        expect(() => b.decodeJSON({ text: c.encodeJSON({ value: new Money(1, `GBP`) }) })).toThrow(/Unknown record type: money/);
        expect(a.liveHandleCount()).toBe(0);
    });

    it('rejects reserved and duplicate names at construction', () => {
        expect(() => pair({ types: [ { ...money, name: 'function' } ] })).toThrow(/reserved/);
        expect(() => pair({ types: [ money, money ] })).toThrow(/twice/);
    });
});

describe('custom by-reference types', () => {
    // A stand-in for a window: identity that lives on one side, usable from
    // the other only by calling home.
    class FakeWindow {
        readonly received : Array<string> = [];

        closed = false;
    }

    type WindowMethods = { readonly post : (message : string) => void, readonly close : () => void };

    const released : Array<FakeWindow> = [];

    const windowType : CustomType<FakeWindow, WindowMethods> = {
        name: 'window',
        test: value => value instanceof FakeWindow,

        encode: ({ value }) => ({
            post: message => value.received.push(message),

            close: () => {
                value.closed = true;
            }
        }),

        decode:  ({ value }) => value as unknown as FakeWindow,
        release: ({ value }) => released.push(value)
    };

    it('crosses as refs that act on the original', async () => {
        const [ a, b ] = pair({ types: [ windowType ] });
        const win = new FakeWindow();
        const proxy = b.decode<WindowMethods>({ wire: a.encode({ value: win }) });

        await proxy.post('hello');
        await proxy.close();

        expect(win.received).toEqual([ 'hello' ]);
        expect(win.closed).toBe(true);
    });

    it('tells the owner once when the far side has let go of every ref', () => {
        const [ a, b ] = pair({ types: [ windowType ] });
        const win = new FakeWindow();

        released.length = 0;

        const proxy = b.decode<Remote<WindowMethods>>({ wire: a.encode({ value: win }) });

        proxy.post[Symbol.dispose]();
        expect(released).toEqual([]);

        proxy.close[Symbol.dispose]();
        expect(released).toEqual([ win ]);
        expect(a.liveHandleCount()).toBe(0);
    });

    it('fires release on close too', () => {
        const [ a, b ] = pair({ types: [ windowType ] });
        const win = new FakeWindow();

        released.length = 0;
        b.decode({ wire: a.encode({ value: win }) });
        a.close();

        expect(released).toEqual([ win ]);
    });

    it('fires release immediately when the encoded form carried no refs at all', () => {
        const releasedPlain : Array<unknown> = [];

        const plain : CustomType<{ tag : 'plain' }, string> = {
            name:    'plain',
            test:    value => typeof value === `object` && value !== null && (value as { tag ?: string }).tag === `plain`,
            encode:  () => 'nothing to hold',
            decode:  () => ({ tag: 'plain' }),
            release: ({ value }) => releasedPlain.push(value)
        };

        const [ a ] = pair({ types: [ plain ] });

        a.encode({ value: { tag: 'plain' } });
        expect(releasedPlain).toEqual([ { tag: 'plain' } ]);
    });

    it('a once function inside a by-reference value counts toward the group', async () => {
        const seen : Array<string> = [];

        type Ticket = { readonly redeem : () => string };

        const ticket : CustomType<{ code : string }, Ticket> = {
            name:    'ticket',
            test:    value => typeof value === 'object' && value !== null && 'code' in value,
            encode:  ({ value }) => ({ redeem: ref({ fn: () => `redeemed ${ value.code }`, once: true }) }),
            decode:  ({ value }) => value as unknown as { code : string },
            release: ({ value }) => seen.push(value.code)
        };

        const [ a, b ] = pair({ types: [ ticket ] });
        const remote = b.decode<{ redeem : Ref }>({ wire: a.encode({ value: { code: 'T1' } }) });

        expect(await remote.redeem()).toBe('redeemed T1');
        expect(seen).toEqual([ 'T1' ]);
    });
});
