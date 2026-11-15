/**
 * Preloaded (`node --import`) into the LOCAL runtime the corpus soak starts, and nowhere else.
 *
 * On Cloud Run the runtime holds a service account, and Google bills its own project. On a
 * developer's machine Application Default Credentials are usually a USER login, and Google then
 * needs to be told which project to bill (`x-goog-user-project`), or Text-to-Speech and Vertex answer
 * 403. The runtime's REST adapters (`src/speech/tts.ts`, `src/agent/intent.ts`) rightly send no such
 * header, so this adds it, for googleapis.com hosts only, from `GOOGLE_CLOUD_QUOTA_PROJECT` (which
 * the gRPC recogniser's auth library reads by itself). Nothing in src/ changes; the deployed image
 * never loads this file.
 */

const project = process.env.GOOGLE_CLOUD_QUOTA_PROJECT;
if (project) {
    const original = globalThis.fetch;
    globalThis.fetch = (input, init = {}) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (!url.hostname.endsWith('.googleapis.com')) return original(input, init);
        const headers = new Headers(init.headers ?? {});
        if (!headers.has('x-goog-user-project')) headers.set('x-goog-user-project', project);
        return original(input, { ...init, headers });
    };
}
