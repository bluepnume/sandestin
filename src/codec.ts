import type { CustomType } from './custom-types';
import type { Bytes, EncodedError, EncodedFunction, TaggedRecord } from './records';
import type { AnyFunction, Handle } from './types';

import { base64ToBytes, bytesToBase64 } from './base64';
import { ReleasedError, RemoteError, UnauthorizedError } from './errors';
import {
    bytesFromKind, bytesOf, isMessagePort, isPlainObject, isRecord,
    needsEscaping, record, RECORD_TYPE
} from './records';

// Handles produced while encoding one custom-type value, so the owner can be
// told once when the far side has let go of all of them.
export type HandleGroup = {
    readonly handles : ReadonlyArray<Handle>,
    readonly release : () => void,
};

type EncodeWalkOptions = {
    readonly value : unknown,
    readonly includeStacks : boolean,
    readonly types : ReadonlyArray<CustomType>,
    // Leave binary and ports native and collect them for postMessage.
    readonly transferable : boolean,
    // Register a function or promise and get the handle that names it.
    readonly onFunction : (options : { readonly fn : AnyFunction }) => Handle,
    readonly onPromise : (options : { readonly promise : Promise<unknown> }) => Handle,
    readonly onGroup : (group : HandleGroup) => void,
};

type EncodeWalkResult = {
    readonly wire : unknown,
    readonly transfer : ReadonlyArray<Transferable>,
};

const ERROR_OWN_KEYS = new Set([ 'name', 'message', 'stack', 'cause' ]);

type Walk = (value : unknown) => unknown;

type EncodeState = Omit<EncodeWalkOptions, 'value'> & {
    // The recursive step, so helpers below can call back into the dispatcher.
    readonly walk : Walk,
    // The same walk, with one custom type left out at the top level only.
    readonly walkSkipping : (options : { readonly value : unknown, readonly skip : CustomType }) => unknown,
    // Input container -> encounter index, so cycles and shared references
    // become `ref` records.
    readonly indexes : Map<object, number>,
    readonly transfer : Array<Transferable>,
    // Handle collectors for custom-type values currently being encoded.
    readonly collectors : Array<Array<Handle>>,
};

type EncodeStep<Value> = {
    readonly value : Value,
    readonly state : EncodeState,
};

type CollectOptions = { readonly handle : Handle, readonly state : EncodeState };

const collect = ({ handle, state } : CollectOptions) : Handle => {
    for (const collector of state.collectors) {
        collector.push(handle);
    }

    return handle;
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

const remember = ({ value, state } : EncodeStep<object>) : void => {
    state.indexes.set(value, state.indexes.size);
};

const walkObject = ({ value, state } : EncodeStep<Record<string, unknown>>) : unknown => {
    const output : Record<string, unknown> = {};

    remember({ value, state });

    for (const key of Object.keys(value)) {
        output[key] = state.walk(value[key]);
    }

    return needsEscaping(value)
        ? record({ type: RECORD_TYPE.ESCAPED, value: output })
        : output;
};

const walkArray = ({ value, state } : EncodeStep<ReadonlyArray<unknown>>) : unknown => {
    const output : Array<unknown> = [];

    remember({ value, state });

    for (const element of value) {
        output.push(state.walk(element));
    }

    return output;
};

const walkMap = ({ value, state } : EncodeStep<ReadonlyMap<unknown, unknown>>) : unknown => {
    remember({ value, state });

    const entries = [ ...value ].map(([ key, entry ]) => [ state.walk(key), state.walk(entry) ]);

    return record({ type: RECORD_TYPE.MAP, value: entries });
};

const walkSet = ({ value, state } : EncodeStep<ReadonlySet<unknown>>) : unknown => {
    remember({ value, state });

    return record({ type: RECORD_TYPE.SET, value: [ ...value ].map(entry => state.walk(entry)) });
};

const walkBytes = ({ value, bytes, state } : EncodeStep<unknown> & { readonly bytes : Bytes }) : unknown => {
    if (state.transferable) {
        state.transfer.push(bytes.buffer);

        return value;
    }

    const encodedBytes = { kind: bytes.kind, base64: bytesToBase64({ bytes: bytes.bytes }) };

    return record({ type: RECORD_TYPE.BYTES, value: encodedBytes });
};

const walkCustom = ({ value, type, state } : EncodeStep<unknown> & { readonly type : CustomType }) : unknown => {
    const handles : Array<Handle> = [];

    state.collectors.push(handles);

    try {
        // The encoded form is walked without this type, so an encoder whose
        // output still passes its own test does not recurse into itself.
        const wire = state.walkSkipping({ value: type.encode({ value }), skip: type });

        if (type.release) {
            const { release } = type;

            // Nothing to hold means nothing to wait for: tell the owner now.
            state.onGroup({ handles, release: () => release({ value }) });
        }

        return record({ type: type.name, value: wire });
    } finally {
        state.collectors.pop();
    }
};

type Handled = { readonly handled : true, readonly output : unknown } | { readonly handled : false };

// The platform values that have no JSON form of their own.
const walkPlatform = ({ value, state } : EncodeStep<unknown>) : Handled => {
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

    if (isMessagePort(value)) {
        if (!state.transferable) {
            throw new TypeError('A MessagePort can only be encoded with transferable: true');
        }

        state.transfer.push(value);

        return { handled: true, output: value };
    }

    const bytes = bytesOf(value);

    return bytes === undefined
        ? { handled: false }
        : { handled: true, output: walkBytes({ value, bytes, state }) };
};

const dispatch = ({ value, state, skip } : EncodeStep<unknown> & { readonly skip ?: CustomType }) : unknown => {
    const custom = state.types.find(type => type !== skip && type.test(value));

    if (custom) {
        return walkCustom({ value, type: custom, state });
    }

    if (typeof value === 'function') {
        const fn = value as AnyFunction;
        const handle = collect({ handle: state.onFunction({ fn }), state });
        const encoded : EncodedFunction = { handle, name: fn.name };

        return record({ type: RECORD_TYPE.FUNCTION, value: encoded });
    }

    if (value instanceof Promise) {
        const handle = collect({ handle: state.onPromise({ promise: value }), state });

        return record({ type: RECORD_TYPE.PROMISE, value: handle });
    }

    if (value instanceof Error) {
        return encodeError({ value, state });
    }

    const platform = walkPlatform({ value, state });

    if (platform.handled) {
        return platform.output;
    }

    if (typeof value !== 'object' || value === null) {
        return value;
    }

    const index = state.indexes.get(value);

    if (index !== undefined) {
        return record({ type: RECORD_TYPE.REF, value: index });
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

    // Anything else (a class instance, say) is passed through and loses its
    // prototype in transit; register a custom type to carry it properly.
    return isPlainObject(value)
        ? walkObject({ value, state })
        : value;
};

export const encodeWalk = ({ value, ...options } : EncodeWalkOptions) : EncodeWalkResult => {
    const state : EncodeState = {
        ...options,
        walk:         input => dispatch({ value: input, state }),
        walkSkipping: ({ value: input, skip }) => dispatch({ value: input, state, skip }),
        indexes:      new Map(),
        transfer:     [],
        collectors:   []
    };

    return { wire: state.walk(value), transfer: state.transfer };
};

type DecodeWalkOptions = {
    readonly wire : unknown,
    readonly types : ReadonlyArray<CustomType>,
    readonly onFunction : (options : EncodedFunction) => AnyFunction,
    readonly onPromise : (options : { readonly handle : Handle }) => Promise<unknown>,
};

type DecodeState = Omit<DecodeWalkOptions, 'wire'> & {
    readonly walk : Walk,
    // Containers in encounter order, the targets of ref records.
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

type TrackOptions = { readonly output : unknown, readonly state : DecodeState };

const track = ({ output, state } : TrackOptions) : void => {
    state.containers.push(output);
};

const unwalkObject = ({ wire, state } : DecodeStep<Record<string, unknown>>) : unknown => {
    const output : Record<string, unknown> = {};

    track({ output, state });

    for (const key of Object.keys(wire)) {
        output[key] = state.walk(wire[key]);
    }

    return output;
};

const unwalkArray = ({ wire, state } : DecodeStep<ReadonlyArray<unknown>>) : unknown => {
    const output : Array<unknown> = [];

    track({ output, state });

    for (const element of wire) {
        output.push(state.walk(element));
    }

    return output;
};

type WireEntries = ReadonlyArray<readonly [ unknown, unknown ]>;

const unwalkMap = ({ wire, state } : DecodeStep<WireEntries>) : Map<unknown, unknown> => {
    const output = new Map<unknown, unknown>();

    track({ output, state });

    for (const [ key, entry ] of wire) {
        output.set(state.walk(key), state.walk(entry));
    }

    return output;
};

const unwalkSet = ({ wire, state } : DecodeStep<ReadonlyArray<unknown>>) : Set<unknown> => {
    const output = new Set<unknown>();

    track({ output, state });

    for (const entry of wire) {
        output.add(state.walk(entry));
    }

    return output;
};

const unwalkRecord = ({ wire, state } : DecodeStep<TaggedRecord>) : unknown => {
    const value = wire.$value;
    const custom = state.types.find(type => type.name === wire.$type);

    if (custom) {
        return custom.decode({ value: state.walk(value) });
    }

    switch (wire.$type) {
        case RECORD_TYPE.FUNCTION:
            return state.onFunction(value as EncodedFunction);
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
            return unwalkMap({ wire: value as ReadonlyArray<readonly [ unknown, unknown ]>, state });
        case RECORD_TYPE.SET:
            return unwalkSet({ wire: value as ReadonlyArray<unknown>, state });
        case RECORD_TYPE.REF:
            return state.containers[value as number];
        default:
            throw new TypeError(`Unknown record type: ${ wire.$type }`);
    }
};

const undispatch = ({ wire, state } : DecodeStep<unknown>) : unknown => {
    if (typeof wire !== 'object' || wire === null) {
        return wire;
    }

    if (isRecord(wire)) {
        return unwalkRecord({ wire, state });
    }

    if (Array.isArray(wire)) {
        return unwalkArray({ wire, state });
    }

    // Native binary and ports arrive only from a transferable encode over a
    // structured-clone transport; they are already what they should be.
    return isPlainObject(wire)
        ? unwalkObject({ wire, state })
        : wire;
};

export const decodeWalk = ({ wire, ...options } : DecodeWalkOptions) : unknown => {
    const state : DecodeState = {
        ...options,
        walk:       input => undispatch({ wire: input, state }),
        containers: []
    };

    return state.walk(wire);
};
