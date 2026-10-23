import type { CustomTypeLike } from './custom-types';

// Any callable; the `Function` type is banned by the lint config.
export type AnyFunction = (...args : never) => unknown;

// A handle names one function or promise in one instance's table. Random, so
// holding a handle is the only way to reach what it names.
export type Handle = string;

// What `encode` produces: JSON-safe plain data that structuredClone and
// JSON.stringify both carry unchanged. Opaque to callers.
export type Encoded = unknown;

// How a call or a promise ended, with the value or error already encoded so a
// transport can forward it without looking inside.
export type Outcome =
    | { readonly ok : true, readonly value : Encoded }
    | { readonly ok : false, readonly error : Encoded };

export type InvokeRemoteFunctionOptions<Context> = {
    readonly handle : Handle,
    readonly args : Encoded,
    // Present when the caller gave up: the transport may stop waiting and may
    // tell the far side. The ref has already rejected by then.
    readonly signal ?: AbortSignal,
    // False when the caller does not want the outcome: the transport may send
    // one way and resolve with nothing.
    readonly reply : boolean,
    // The context the ref was decoded under, if any.
    readonly context : Context | undefined,
};

export type ReleaseRemoteHandleOptions<Context> = {
    readonly handle : Handle,
    readonly context : Context | undefined,
};

export type WatchRemotePromiseOptions<Context> = {
    readonly handle : Handle,
    readonly context : Context | undefined,
};

export type AuthorizeInboundRequestOptions<Context> = {
    readonly handle : Handle,
    // What the transport attached to this request.
    readonly context : Context,
    // The context the handle was encoded under, if any: who it was given to.
    readonly handleContext : Context | undefined,
    // The function or promise the request is about, when it is still held.
    readonly target : unknown,
};

export type AuthorizeInboundRequest<Context> =
    (options : AuthorizeInboundRequestOptions<Context>) => boolean | Promise<boolean>;

export type SandestinOptions<Context> = {
    // Outbound: carry a call for a function the other side owns, and resolve
    // with its outcome. The transport decides how.
    readonly invokeRemoteFunction : (options : InvokeRemoteFunctionOptions<Context>) => Promise<Outcome | void>,
    // Outbound: tell the other side this side no longer holds a handle.
    readonly releaseRemoteHandle : (options : ReleaseRemoteHandleOptions<Context>) => void,
    // Outbound: get a promise's outcome from the other side. Reject when it
    // cannot be had; the remote promise rejects with that error.
    readonly watchRemotePromise : (options : WatchRemotePromiseOptions<Context>) => Promise<Outcome>,
    // Inbound gate: runs before every call, release and watch that arrives.
    // `context` is whatever the transport attached; this package never reads
    // it. Absent means every request is allowed.
    readonly authorizeInboundRequest ?: AuthorizeInboundRequest<Context>,
    // Types of your own, tested before the built-ins.
    readonly types ?: ReadonlyArray<CustomTypeLike>,
    // Reject any ref call that has not answered within this many milliseconds.
    // Absent means wait forever.
    readonly callTimeout ?: number,
    // Include `stack` in encoded errors. Off by default: a stack is the
    // owner's business, not something to hand across an origin.
    readonly includeStacks ?: boolean,
};

export type EncodeOptions<Context> = {
    readonly value : unknown,
    // Remembered by every function and promise handed out in this value:
    // calls, outcomes and custom types for them see it again.
    readonly context ?: Context,
};

export type TransferableEncodeOptions<Context> = EncodeOptions<Context> & {
    // Leave ArrayBuffers, typed arrays and MessagePorts native and list what to
    // hand to postMessage as transferables. Only for structured-clone
    // transports: a text transport cannot carry what this leaves native.
    readonly transferable : true,
};

export type TransferableEncoded = {
    readonly wire : Encoded,
    readonly transfer : ReadonlyArray<Transferable>,
};

export type Encode<Context> = {
    (options : EncodeOptions<Context>) : Encoded,
    (options : TransferableEncodeOptions<Context>) : TransferableEncoded,
};

export type DecodeOptions<Context> = {
    readonly wire : Encoded,
    // Remembered by every ref and remote promise in the result.
    readonly context ?: Context,
};

export type InvokeLocalFunctionOptions<Context> = {
    readonly handle : Handle,
    readonly args : Encoded,
    readonly context : Context,
};

export type ReleaseLocalHandleOptions<Context> = {
    readonly handle : Handle,
    readonly context : Context,
};

export type WatchLocalPromiseOptions<Context> = {
    readonly handle : Handle,
    readonly context : Context,
};

export type Sandestin<Context> = {
    readonly encode : Encode<Context>,
    // Returns `unknown` unless told the shape; `T` is the type the other side
    // encoded and the result is its `Remote<T>` form.
    readonly decode : <T = unknown>(options : DecodeOptions<Context>) => Remote<T>,
    readonly encodeJSON : (options : EncodeOptions<Context>) => string,
    readonly decodeJSON : <T = unknown>(options : { readonly text : string, readonly context ?: Context }) => Remote<T>,
    // Inbound: the other side called a function this side encoded.
    readonly invokeLocalFunction : (options : InvokeLocalFunctionOptions<Context>) => Promise<Outcome>,
    // Inbound: the other side let go of a handle this side encoded.
    readonly releaseLocalHandle : (options : ReleaseLocalHandleOptions<Context>) => Promise<void>,
    // Inbound: the other side wants the outcome of a promise this side
    // encoded; resolves when it is known, rejects when refused or unknown.
    readonly watchLocalPromise : (options : WatchLocalPromiseOptions<Context>) => Promise<Outcome>,
    // Whether this side still holds the function or promise the handle names.
    readonly hasHandle : (options : { readonly handle : Handle }) => boolean,
    // Handles this side is holding on the other side's behalf.
    readonly liveHandleCount : () => number,
    // Release everything in both directions.
    readonly close : () => void,
};

export type InvokeOptions<Args> = {
    readonly args : Args,
    // Stop waiting when this fires; the call rejects with its reason.
    readonly signal ?: AbortSignal,
    // False to fire and forget: resolves with undefined once the call is on
    // its way, and whatever the far side returns or throws is dropped.
    readonly reply ?: boolean,
};

// A function received from the other side: calls go across, results come
// back as a promise. `invoke` is the same call with a signal; `using`
// releases it.
export type Ref<Args extends ReadonlyArray<unknown> = ReadonlyArray<unknown>, Result = unknown> =
    ((...args : Args) => Promise<Result>) & {
        // A method, not a property, so that a `Ref<[], number>` is assignable
        // to the bare `Ref` the same way its call signature is.
        // eslint-disable-next-line @typescript-eslint/method-signature-style
        invoke(options : InvokeOptions<Args>) : Promise<Result>,
        readonly [ Symbol.dispose ] : () => void,
    };

// What a value looks like after it has crossed: functions become refs,
// promises stay promises, everything else is itself. Apply it to the type the
// other side encoded.
export type Remote<T> =
    T extends (...args : infer Args) => infer Result
        ? Ref<Args, Remote<Awaited<Result>>>
        : T extends Promise<infer Value>
            ? Promise<Remote<Value>>
            : T extends ReadonlyMap<infer Key, infer Value>
                ? ReadonlyMap<Remote<Key>, Remote<Value>>
                : T extends ReadonlySet<infer Value>
                    ? ReadonlySet<Remote<Value>>
                    : T extends ReadonlyArray<infer Element>
                        ? ReadonlyArray<Remote<Element>>
                        : T extends Error
                            ? Error
                            : T extends Date | RegExp | ArrayBuffer | ArrayBufferView | bigint
                                ? T
                                : T extends object
                                    ? { readonly [Key in keyof T] : Remote<T[Key]> }
                                    : T;
