// Any callable; the `Function` type is banned by the lint config.
export type AnyFunction = (...args : never) => unknown;

// A handle names one function or promise in one instance's table. Random, so
// holding a handle is the only way to reach what it names.
export type Handle = string;

// What `encode` produces. Opaque to callers: structured-cloneable in the
// default mode, and the input to `encodeJSON` for the string form.
export type Encoded = unknown;

// How a call or a promise ended, with the value or error already encoded so a
// transport can forward it without looking inside.
export type Outcome =
    | { readonly ok : true, readonly value : Encoded }
    | { readonly ok : false, readonly error : Encoded };

export type InvokeRemoteFunctionOptions = {
    readonly handle : Handle,
    readonly args : Encoded,
};

export type ReleaseRemoteHandleOptions = {
    readonly handle : Handle,
};

export type WatchRemotePromiseOptions = {
    readonly handle : Handle,
    readonly listener : (outcome : Outcome) => void,
};

export type AuthorizeInboundRequestOptions<Context> = {
    readonly handle : Handle,
    readonly context : Context,
    // The function or promise the request is about, when it is still held.
    readonly target : unknown,
};

export type AuthorizeInboundRequest<Context> =
    (options : AuthorizeInboundRequestOptions<Context>) => boolean | Promise<boolean>;

export type SerdesOptions<Context> = {
    // Outbound: carry a call for a function the other side owns, and resolve
    // with its outcome. The transport decides how.
    readonly invokeRemoteFunction : (options : InvokeRemoteFunctionOptions) => Promise<Outcome>,
    // Outbound: tell the other side this side no longer holds a handle.
    readonly releaseRemoteHandle : (options : ReleaseRemoteHandleOptions) => void,
    // Outbound: ask the other side to deliver a promise's outcome when it has one.
    readonly watchRemotePromise : (options : WatchRemotePromiseOptions) => void,
    // Inbound gate: runs before every call, release and watch that arrives.
    // `context` is whatever the transport attached; this package never reads
    // it. Absent means every request is allowed.
    readonly authorizeInboundRequest ?: AuthorizeInboundRequest<Context>,
    // Include `stack` in encoded errors. Off by default: a stack is the
    // owner's business, not something to hand across an origin.
    readonly includeStacks ?: boolean,
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
    readonly listener : (outcome : Outcome) => void,
    readonly context : Context,
};

export type Serdes<Context> = {
    readonly encode : (options : { readonly value : unknown }) => Encoded,
    readonly decode : (options : { readonly wire : Encoded }) => unknown,
    readonly encodeJSON : (options : { readonly value : unknown }) => string,
    readonly decodeJSON : (options : { readonly text : string }) => unknown,
    // Inbound: the other side called a function this side encoded.
    readonly invokeLocalFunction : (options : InvokeLocalFunctionOptions<Context>) => Promise<Outcome>,
    // Inbound: the other side let go of a handle this side encoded.
    readonly releaseLocalHandle : (options : ReleaseLocalHandleOptions<Context>) => Promise<void>,
    // Inbound: the other side wants the outcome of a promise this side encoded.
    readonly watchLocalPromise : (options : WatchLocalPromiseOptions<Context>) => Promise<void>,
    // Handles this side is holding on the other side's behalf.
    readonly liveHandleCount : () => number,
    // Release everything in both directions.
    readonly close : () => void,
};

// A function received from the other side: calls go across, results come
// back as a promise. Disposable so `using` releases it.
export type Ref<Args extends ReadonlyArray<unknown> = ReadonlyArray<unknown>, Result = unknown> =
    ((...args : Args) => Promise<Result>) & { readonly [ Symbol.dispose ] : () => void };

// What a value looks like after it has crossed: functions return promises,
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
