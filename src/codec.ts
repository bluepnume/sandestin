import type { Bytes, EncodedError, TaggedRecord } from './records';
import type { AnyFunction, Handle } from './types';

import { base64ToBytes, bytesToBase64 } from './base64';
import { ReleasedError, RemoteError, UnauthorizedError } from './errors';
import { bytesFromKind, bytesOf, isPlainObject, isRecord, needsEscaping, record, RECORD_TYPE } from './records';

export type CodecMode = 'clone' | 'json';

type EncodeWalkOptions = {
    readonly value : unknown,
    readonly mode : CodecMode,
    readonly includeStacks : boolean,
    // Register a function or promise and get the handle that names it.
    readonly onFunction : (options : { readonly fn : AnyFunction }) => Handle,
    readonly onPromise : (options : { readonly promise : Promise<unknown> }) => Handle,
};

const ERROR_OWN_KEYS = new Set([ 'name', 'message', 'stack', 'cause' ]);

type Walk = (value : unknown) => unknown;

type EncodeState = Omit<EncodeWalkOptions, 'value'> & {
    // The recursive step, so helpers below can call back into the dispatcher.
    readonly walk : Walk,
    // clone mode: input object -> output object, so cycles stay cycles.
    readonly outputs : Map<object, unknown>,
    // json mode: input object -> encounter index, so cycles become refs.
    readonly indexes : Map<object, number>,
};

type EncodeStep<Value> = {
    readonly value : Value,
    readonly state : EncodeState,
};

const encodeError = ({ value, state } : EncodeStep<Error>) : TaggedRecord => {
    const properties : Record<string, unknown> = {};

    for (const key of Object.keys(value)) {
        if (!ERROR_OWN_KEYS.has(key)) {
            properties[key] = state.walk((value as unknown as Record<string, unknown>)[key]);
        }
    }

    const encoded : EncodedError = {
        name:    value.name,
        message: value.message,
        properties,
        ...state.includeStacks && value.stack !== undefined
            ? { stack: value.stack }
            : {},
        ...value.cause === undefined
            ? {}
            : { cause: state.walk(value.cause) }
    };

    return record({ type: RECORD_TYPE.ERROR, value: encoded });
};

// Tracks a container in whichever way the mode needs.
type RememberOptions = { readonly input : object, readonly output : unknown, readonly state : EncodeState };

const remember = ({ input, output, state } : RememberOptions) : void => {
    if (state.mode === 'clone') {
        state.outputs.set(input, output);
    } else {
        state.indexes.set(input, state.indexes.size);
    }
};

type Seen = { readonly hit : true, readonly value : unknown } | { readonly hit : false };

const seen = ({ value, state } : EncodeStep<object>) : Seen => {
    if (state.mode === 'clone') {
        return state.outputs.has(value)
            ? { hit: true, value: state.outputs.get(value) }
            : { hit: false };
    }

    const index = state.indexes.get(value);

    return index === undefined
        ? { hit: false }
        : { hit: true, value: record({ type: RECORD_TYPE.REF, value: index }) };
};

const walkObject = ({ value, state } : EncodeStep<Record<string, unknown>>) : unknown => {
    const output : Record<string, unknown> = {};

    remember({ input: value, output, state });

    for (const key of Object.keys(value)) {
        output[key] = state.walk(value[key]);
    }

    return needsEscaping(value)
        ? record({ type: RECORD_TYPE.ESCAPED, value: output })
        : output;
};

const walkArray = ({ value, state } : EncodeStep<ReadonlyArray<unknown>>) : unknown => {
    const output : Array<unknown> = [];

    remember({ input: value, output, state });

    for (const element of value) {
        output.push(state.walk(element));
    }

    return output;
};

const walkMap = ({ value, state } : EncodeStep<ReadonlyMap<unknown, unknown>>) : unknown => {
    if (state.mode === 'clone') {
        const output = new Map<unknown, unknown>();

        remember({ input: value, output, state });

        for (const [ key, entry ] of value) {
            output.set(state.walk(key), state.walk(entry));
        }

        return output;
    }

    remember({ input: value, output: undefined, state });

    const entries = [ ...value ].map(([ key, entry ]) => [ state.walk(key), state.walk(entry) ]);

    return record({ type: RECORD_TYPE.MAP, value: entries });
};

const walkSet = ({ value, state } : EncodeStep<ReadonlySet<unknown>>) : unknown => {
    if (state.mode === 'clone') {
        const output = new Set<unknown>();

        remember({ input: value, output, state });

        for (const entry of value) {
            output.add(state.walk(entry));
        }

        return output;
    }

    remember({ input: value, output: undefined, state });

    return record({ type: RECORD_TYPE.SET, value: [ ...value ].map(entry => state.walk(entry)) });
};

type Handled = { readonly handled : true, readonly output : unknown } | { readonly handled : false };

// JSON mode only: things structured clone would have carried natively.
const walkJsonOnly = ({ value } : EncodeStep<unknown>) : Handled => {
    if (value === undefined) {
        return { handled: true, output: record({ type: RECORD_TYPE.UNDEFINED, value: null }) };
    }

    if (typeof value === 'bigint') {
        return { handled: true, output: record({ type: RECORD_TYPE.BIGINT, value: value.toString() }) };
    }

    if (value instanceof Date) {
        return { handled: true, output: record({ type: RECORD_TYPE.DATE, value: value.toISOString() }) };
    }

    if (value instanceof RegExp) {
        const regexp = { source: value.source, flags: value.flags };

        return { handled: true, output: record({ type: RECORD_TYPE.REGEXP, value: regexp }) };
    }

    const bytes = bytesOf(value);

    if (bytes === undefined) {
        return { handled: false };
    }

    const encodedBytes = { kind: bytes.kind, base64: bytesToBase64({ bytes: bytes.bytes }) };

    return { handled: true, output: record({ type: RECORD_TYPE.BYTES, value: encodedBytes }) };
};

const dispatch = ({ value, state } : EncodeStep<unknown>) : unknown => {
    if (typeof value === 'function') {
        return record({ type: RECORD_TYPE.FUNCTION, value: state.onFunction({ fn: value as AnyFunction }) });
    }

    if (value instanceof Promise) {
        return record({ type: RECORD_TYPE.PROMISE, value: state.onPromise({ promise: value }) });
    }

    if (value instanceof Error) {
        return encodeError({ value, state });
    }

    if (state.mode === 'json') {
        const jsonOnly = walkJsonOnly({ value, state });

        if (jsonOnly.handled) {
            return jsonOnly.output;
        }
    }

    if (typeof value !== 'object' || value === null) {
        return value;
    }

    const previous = seen({ value, state });

    if (previous.hit) {
        return previous.value;
    }

    if (Array.isArray(value)) {
        return walkArray({ value, state });
    }

    if (value instanceof Map) {
        return walkMap({ value, state });
    }

    if (value instanceof Set) {
        return walkSet({ value, state });
    }

    // Anything else (Date, RegExp, typed arrays, class instances) is left for
    // structured clone to carry or reject on its own terms.
    return isPlainObject(value)
        ? walkObject({ value, state })
        : value;
};

export const encodeWalk = ({ value, ...options } : EncodeWalkOptions) : unknown => {
    const state : EncodeState = {
        ...options,
        walk:    input => dispatch({ value: input, state }),
        outputs: new Map(),
        indexes: new Map()
    };

    return state.walk(value);
};

type DecodeWalkOptions = {
    readonly wire : unknown,
    readonly mode : CodecMode,
    readonly onFunction : (options : { readonly handle : Handle }) => AnyFunction,
    readonly onPromise : (options : { readonly handle : Handle }) => Promise<unknown>,
};

type DecodeState = Omit<DecodeWalkOptions, 'wire'> & {
    readonly walk : Walk,
    readonly outputs : Map<object, unknown>,
    // json mode: containers in encounter order, the targets of ref records.
    readonly containers : Array<unknown>,
};

type DecodeStep<Wire> = {
    readonly wire : Wire,
    readonly state : DecodeState,
};

const SPECIAL_ERRORS : Readonly<Record<string, (options : { readonly handle : string }) => RemoteError>> = {
    ReleasedError:     options => new ReleasedError(options),
    UnauthorizedError: options => new UnauthorizedError(options)
};

const decodeError = ({ wire, state } : DecodeStep<EncodedError>) : RemoteError => {
    const properties : Record<string, unknown> = {};

    for (const key of Object.keys(wire.properties)) {
        properties[key] = state.walk(wire.properties[key]);
    }

    const cause = wire.cause === undefined
        ? undefined
        : state.walk(wire.cause);

    const special = SPECIAL_ERRORS[wire.name];

    if (special) {
        const error = special({ handle: '' });

        error.message = wire.message;
        Object.assign(error, properties);

        return error;
    }

    return new RemoteError({ name: wire.name, message: wire.message, stack: wire.stack, cause, properties });
};

type TrackOptions = { readonly input : object, readonly output : unknown, readonly state : DecodeState };

const track = ({ input, output, state } : TrackOptions) : void => {
    if (state.mode === 'clone') {
        state.outputs.set(input, output);
    } else {
        state.containers.push(output);
    }
};

const unwalkObject = ({ wire, state } : DecodeStep<Record<string, unknown>>) : unknown => {
    const output : Record<string, unknown> = {};

    track({ input: wire, output, state });

    for (const key of Object.keys(wire)) {
        output[key] = state.walk(wire[key]);
    }

    return output;
};

const unwalkArray = ({ wire, state } : DecodeStep<ReadonlyArray<unknown>>) : unknown => {
    const output : Array<unknown> = [];

    track({ input: wire, output, state });

    for (const element of wire) {
        output.push(state.walk(element));
    }

    return output;
};

type UnwalkMapOptions = DecodeStep<object> & {
    readonly entries : Iterable<readonly [ unknown, unknown ]>,
};

const unwalkMap = ({ wire, entries, state } : UnwalkMapOptions) : Map<unknown, unknown> => {
    const output = new Map<unknown, unknown>();

    track({ input: wire, output, state });

    for (const [ key, entry ] of entries) {
        output.set(state.walk(key), state.walk(entry));
    }

    return output;
};

type UnwalkSetOptions = DecodeStep<object> & {
    readonly entries : Iterable<unknown>,
};

const unwalkSet = ({ wire, entries, state } : UnwalkSetOptions) : Set<unknown> => {
    const output = new Set<unknown>();

    track({ input: wire, output, state });

    for (const entry of entries) {
        output.add(state.walk(entry));
    }

    return output;
};

const unwalkRecord = ({ wire, state } : DecodeStep<TaggedRecord>) : unknown => {
    const value = wire.$value;

    switch (wire.$type) {
        case RECORD_TYPE.FUNCTION:
            return state.onFunction({ handle: value as Handle });
        case RECORD_TYPE.PROMISE:
            return state.onPromise({ handle: value as Handle });
        case RECORD_TYPE.ERROR:
            return decodeError({ wire: value as EncodedError, state });
        case RECORD_TYPE.ESCAPED:
            return unwalkObject({ wire: value as Record<string, unknown>, state });
        case RECORD_TYPE.UNDEFINED:
            return undefined;
        case RECORD_TYPE.BIGINT:
            return BigInt(value as string);
        case RECORD_TYPE.DATE:
            return new Date(value as string);
        case RECORD_TYPE.REGEXP: {
            const { source, flags } = value as { source : string, flags : string };

            // eslint-disable-next-line security/detect-non-literal-regexp -- rebuilding a RegExp the other side sent
            return new RegExp(source, flags);
        }
        case RECORD_TYPE.BYTES: {
            const { kind, base64 } = value as { kind : Bytes['kind'], base64 : string };

            return bytesFromKind({ kind, bytes: base64ToBytes({ text: base64 }) });
        }
        case RECORD_TYPE.MAP:
            return unwalkMap({ wire, entries: value as ReadonlyArray<readonly [ unknown, unknown ]>, state });
        case RECORD_TYPE.SET:
            return unwalkSet({ wire, entries: value as ReadonlyArray<unknown>, state });
        case RECORD_TYPE.REF:
            return state.containers[value as number];
        default:
            throw new TypeError(`Unknown record type: ${ String(wire.$type) }`);
    }
};

const undispatch = ({ wire, state } : DecodeStep<unknown>) : unknown => {
    if (typeof wire !== 'object' || wire === null) {
        return wire;
    }

    if (isRecord(wire)) {
        return unwalkRecord({ wire, state });
    }

    if (state.mode === 'clone' && state.outputs.has(wire)) {
        return state.outputs.get(wire);
    }

    if (Array.isArray(wire)) {
        return unwalkArray({ wire, state });
    }

    if (wire instanceof Map) {
        return unwalkMap({ wire, entries: wire, state });
    }

    if (wire instanceof Set) {
        return unwalkSet({ wire, entries: wire, state });
    }

    return isPlainObject(wire)
        ? unwalkObject({ wire, state })
        : wire;
};

export const decodeWalk = ({ wire, ...options } : DecodeWalkOptions) : unknown => {
    const state : DecodeState = {
        ...options,
        walk:       input => undispatch({ wire: input, state }),
        outputs:    new Map(),
        containers: []
    };

    return state.walk(wire);
};
