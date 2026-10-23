import { bytesType, isNative, messagePortType, native } from '../src';

import { pair } from './helpers';

describe('transferable encode', () => {
    it('leaves buffers native and lists them for postMessage', () => {
        const [ a ] = pair({ types: [ bytesType, messagePortType ] });
        const buffer = new Uint8Array([ 1, 2, 3 ]).buffer;
        const view = new Float32Array([ 1.5 ]);

        const { wire, transfer } = a.encode({ value: { buffer, view, plain: 1 }, transferable: true });
        const output = wire as { buffer : ArrayBuffer, view : Float32Array, plain : number };

        expect(output.buffer).toBe(buffer);
        expect(output.view).toBe(view);
        expect(output.plain).toBe(1);
        expect(transfer).toEqual([ buffer, view.buffer ]);
    });

    it('decodes what structuredClone delivers from a transferable wire', () => {
        const [ a, b ] = pair({ types: [ bytesType, messagePortType ] });
        const value = { bytes: new Uint8Array([ 9, 8 ]), when: new Date(5) };
        const { wire } = a.encode({ value, transferable: true });
        const result = b.decode<{ bytes : Uint8Array, when : Date }>({ wire: structuredClone(wire) });

        expect([ ...result.bytes ]).toEqual([ 9, 8 ]);
        expect(result.when.getTime()).toBe(5);
    });

    it('carries a MessagePort, and refuses one without transferable', () => {
        const [ a ] = pair({ types: [ bytesType, messagePortType ] });
        const { port1, port2 } = new MessageChannel();

        try {
            const { wire, transfer } = a.encode({ value: { port: port1 }, transferable: true });

            expect((wire as { port : MessagePort }).port).toBe(port1);
            expect(transfer).toEqual([ port1 ]);
            expect(() => a.encode({ value: port2 })).toThrow(/transferable: true/);
        } finally {
            port1.close();
            port2.close();
        }
    });

    it('still moves functions and promises as handles alongside transferables', async () => {
        const [ a, b ] = pair({ types: [ bytesType, messagePortType ] });
        const { wire } = a.encode({ value: { buf: new ArrayBuffer(4), fn: () => 'ok' }, transferable: true });
        const result = b.decode<{ buf : ArrayBuffer, fn : () => string }>({ wire });

        expect(result.buf.byteLength).toBe(4);
        expect(await result.fn()).toBe('ok');
    });

    it('is a plain encode when transferable is not requested', () => {
        const [ a ] = pair({ types: [ bytesType, messagePortType ] });
        const wire = a.encode({ value: new Uint8Array([ 1 ]) });

        expect(wire).toEqual({ $type: 'bytes', $value: { kind: 'Uint8Array', base64: 'AQ==' } });
    });
});

describe('native values', () => {
    it('are refused by a plain encode, since text cannot carry them', () => {
        const [ a ] = pair({
            types: [ {
                name:   'raw',
                test:   (value : unknown) => typeof value === 'object' && value !== null && 'raw' in value,
                encode: ({ value }) => native({ value }),
                decode: ({ value }) => value
            } ]
        });

        expect(() => a.encode({ value: { raw: true } })).toThrow('transferable: true');
        expect(a.encode({ value: { raw: true }, transferable: true }).wire).toEqual({ raw: true });
        expect(isNative(native({ value: 1 }))).toBe(true);
        expect(isNative({ value: 1 })).toBe(false);
    });
});

describe('bytesType', () => {
    it('refuses to encode something that is not bytes', () => {
        expect(() => bytesType.encode({ value: `nope` as never, context: undefined, transferable: false })).toThrow(`typed array`);
    });
});
