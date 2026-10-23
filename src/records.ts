// Every special value crosses as one record shape. A user object that happens
// to carry a `$type` key is wrapped in an `escaped` record so it round-trips.
const RECORD_KEY = '$type';

const RECORD_VALUE_KEY = '$value';

export const RECORD_TYPE = {
    FUNCTION:  'function',
    PROMISE:   'promise',
    ERROR:     'error',
    ESCAPED:   'escaped',
    UNDEFINED: 'undefined',
    DATE:      'date',
    REGEXP:    'regexp',
    MAP:       'map',
    SET:       'set',
    BIGINT:    'bigint',
    BYTES:     'bytes',
    // A second occurrence of a container already emitted: cycles and shared
    // references.
    REF:       'ref',
    // A ref or remote promise sent back to the side it came from: names the
    // owner's own handle, so the owner gets its original back.
    RETURNED:  'returned'
} as const;

export const BUILT_IN_RECORD_TYPES : ReadonlySet<string> = new Set(Object.values(RECORD_TYPE));

export type TaggedRecord<Type extends string = string, Value = unknown> = {
    readonly [ RECORD_KEY ] : Type,
    readonly [ RECORD_VALUE_KEY ] : Value,
};

type RecordOptions<Type extends string, Value> = {
    readonly type : Type,
    readonly value : Value,
};

export const record = <Type extends string, Value>(
    { type, value } : RecordOptions<Type, Value>
) : TaggedRecord<Type, Value> => ({
    [ RECORD_KEY ]:       type,
    [ RECORD_VALUE_KEY ]: value
});

export const isRecord = (value : unknown) : value is TaggedRecord =>
    typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.hasOwn(value, RECORD_KEY) && Object.hasOwn(value, RECORD_VALUE_KEY) &&
    typeof (value as { [ RECORD_KEY ] : unknown })[RECORD_KEY] === 'string';

// A user object that would be mistaken for a record on the far side.
export const needsEscaping = (value : object) : boolean => Object.hasOwn(value, RECORD_KEY);

// What a function record carries: the handle, and the name for humans.
export type EncodedFunction = {
    readonly handle : string,
    readonly name : string,
};

export type EncodedReturned = {
    readonly kind : 'function' | 'promise',
    readonly handle : string,
};

export type EncodedError = {
    readonly name : string,
    readonly message : string,
    readonly stack ?: string,
    readonly cause ?: unknown,
    readonly properties : Readonly<Record<string, unknown>>,
};

export const isPlainObject = (value : unknown) : value is Record<string, unknown> => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const proto : unknown = Object.getPrototypeOf(value);

    return proto === Object.prototype || proto === null;
};

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

export type Bytes = {
    readonly kind : BytesKind,
    readonly bytes : Uint8Array,
    // The buffer a transferable encode would hand to postMessage.
    readonly buffer : ArrayBuffer,
};

// Recognises the binary values carried as base64, as a kind plus a byte view
// over exactly the bytes they cover.
export const bytesOf = (value : unknown) : Bytes | undefined => {
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

export const bytesFromKind = ({ kind, bytes } : Pick<Bytes, 'kind' | 'bytes'>) : ArrayBuffer | ArrayBufferView => {
    const buffer = new ArrayBuffer(bytes.byteLength);

    new Uint8Array(buffer).set(bytes);

    if (kind === 'ArrayBuffer') {
        return buffer;
    }

    if (!isViewKind(kind)) {
        throw new TypeError(`Unknown bytes kind: ${ String(kind) }`);
    }

    return new VIEW_CONSTRUCTORS[kind](buffer);
};

// A MessagePort can only cross as a transferable; there is no text form.
export const isMessagePort = (value : unknown) : value is MessagePort =>
    typeof MessagePort !== 'undefined' && value instanceof MessagePort;
