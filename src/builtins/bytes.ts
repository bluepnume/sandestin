import type { CustomType } from '../custom-types';

import { native } from '../native';

import { base64ToBytes, bytesToBase64 } from './base64';

type BytesKind =
    | 'ArrayBuffer' | 'Uint8Array' | 'Uint8ClampedArray' | 'Int8Array' | 'Uint16Array' | 'Int16Array'
    | 'Uint32Array' | 'Int32Array' | 'Float32Array' | 'Float64Array';

type ViewKind = Exclude<BytesKind, 'ArrayBuffer'>;

const VIEW_CONSTRUCTORS : Readonly<Record<ViewKind, new (buffer : ArrayBuffer) => ArrayBufferView>> = {
    Uint8Array,
    Uint8ClampedArray,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array
};

const isViewKind = (kind : string) : kind is ViewKind => Object.hasOwn(VIEW_CONSTRUCTORS, kind);

type Bytes = {
    readonly kind : BytesKind,
    readonly bytes : Uint8Array,
    readonly buffer : ArrayBuffer,
};

// A kind plus a byte view over exactly the bytes a buffer or view covers.
const bytesOf = (value : unknown) : Bytes | undefined => {
    if (value instanceof ArrayBuffer) {
        return { kind: 'ArrayBuffer', bytes: new Uint8Array(value), buffer: value };
    }

    if (!ArrayBuffer.isView(value) || value instanceof DataView || !(value.buffer instanceof ArrayBuffer)) {
        return undefined;
    }

    const kind = value.constructor.name;

    return isViewKind(kind)
        ? { kind, bytes: new Uint8Array(value.buffer, value.byteOffset, value.byteLength), buffer: value.buffer }
        : undefined;
};

export type EncodedBytes = {
    readonly kind : BytesKind,
    readonly base64 : string,
};

// ArrayBuffers and typed arrays: base64 on a text wire, left native and
// listed for transfer on a transferable one.
export const bytesType : CustomType<ArrayBuffer | ArrayBufferView, EncodedBytes> = {
    name: 'bytes',
    test: value => bytesOf(value) !== undefined,

    encode: ({ value, transferable }) => {
        const bytes = bytesOf(value);

        if (!bytes) {
            throw new TypeError('Not an ArrayBuffer or a typed array');
        }

        return transferable
            ? native({ value, transfer: [ bytes.buffer ] })
            : { kind: bytes.kind, base64: bytesToBase64({ bytes: bytes.bytes }) };
    },

    decode: ({ value: { kind, base64 } }) => {
        const bytes = base64ToBytes({ text: base64 });
        const buffer = new ArrayBuffer(bytes.byteLength);

        new Uint8Array(buffer).set(bytes);

        if (kind === 'ArrayBuffer') {
            return buffer;
        }

        if (!isViewKind(kind)) {
            throw new TypeError(`Unknown bytes kind: ${ String(kind) }`);
        }

        return new VIEW_CONSTRUCTORS[kind](buffer);
    }
};
