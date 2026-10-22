// Every special value crosses as one record shape. A user object that happens
// to carry a `$type` key is wrapped in an `escaped` record so it round-trips.
const RECORD_KEY = '$type';

const RECORD_VALUE_KEY = '$value';

export const RECORD_TYPE = {
    FUNCTION:  'function',
    PROMISE:   'promise',
    ERROR:     'error',
    ESCAPED:   'escaped',
    // JSON mode only: things structured clone would have carried natively.
    UNDEFINED: 'undefined',
    DATE:      'date',
    REGEXP:    'regexp',
    MAP:       'map',
    SET:       'set',
    BIGINT:    'bigint',
    BYTES:     'bytes',
    // JSON mode only: a second occurrence of an object already emitted.
    REF:       'ref'
} as const;

type RecordType = (typeof RECORD_TYPE)[keyof typeof RECORD_TYPE];

export type TaggedRecord<Type extends RecordType = RecordType, Value = unknown> = {
    readonly [ RECORD_KEY ] : Type,
    readonly [ RECORD_VALUE_KEY ] : Value,
};

type RecordOptions<Type extends RecordType, Value> = {
    readonly type : Type,
    readonly value : Value,
};

export const record = <Type extends RecordType, Value>(
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
};

// Recognises the binary values JSON mode carries as base64, as a kind plus a
// byte view over exactly the bytes they cover.
export const bytesOf = (value : unknown) : Bytes | undefined => {
    if (value instanceof ArrayBuffer) {
        return { kind: 'ArrayBuffer', bytes: new Uint8Array(value) };
    }

    if (!ArrayBuffer.isView(value) || value instanceof DataView) {
        return undefined;
    }

    const kind = value.constructor.name;

    return isViewKind(kind)
        ? { kind, bytes: new Uint8Array(value.buffer, value.byteOffset, value.byteLength) }
        : undefined;
};

export const bytesFromKind = ({ kind, bytes } : Bytes) : ArrayBuffer | ArrayBufferView => {
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
