/**
 * Browser half of dsh-context-zip.
 *
 * Registers one independent settings section beside the built-in ones. The
 * section reads and writes the `context-zip` settings namespace through the
 * plugin's own host routes, so it never needs a core change and never guesses at
 * another plugin's storage.
 *
 * @module dsh-context-zip/client
 */
/** Client entry name, as the loader mounts it. */
export declare const name = "dsh-context-zip/client";
/** Services the section needs before it renders. */
export declare const inject: string[];
/** Locale namespace used for the section's strings. */
export declare const NS = "context-zip";
/**
 * Mount the browser half.
 *
 * @param ctx - client context carrying the slot registry and locale service.
 */
export declare function apply(ctx: any): void;
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
    NS: string;
};
export default _default;
