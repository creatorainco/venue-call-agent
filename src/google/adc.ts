/**
 * Google credentials for the cascade: Application Default Credentials, and nothing else.
 *
 * On Cloud Run ADC is the runtime service account, read from the metadata server; on a laptop it is
 * `gcloud auth application-default login`. Either way this file never sees a key: it asks the
 * library for a short-lived access token and the project id, and the library decides where they
 * come from.
 *
 * 🔴 NO API KEY, NO KEY FILE, NO SECRET. The design (TASK-3748, C2) says the agent holds none of
 * them. `test/importBoundary.test.ts` fails the build if anything under `src/` reads one.
 *
 * `google-auth-library` is imported lazily, inside the factory, so every test that injects a fake
 * token source still runs on a clone with nothing installed (repo `CLAUDE.md`, the three-minute
 * cold start).
 */

/** What a Google REST adapter needs: a bearer token per request, and which project to bill. */
export interface TokenSource {
    token(): Promise<string>;
    projectId(): Promise<string>;
}

export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** The real one. Call it once per process; the library caches and refreshes the token. */
export async function createAdcTokenSource(): Promise<TokenSource> {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
    return {
        async token(): Promise<string> {
            const token = await auth.getAccessToken();
            if (!token) throw new Error('ADC returned no access token');
            return token;
        },
        projectId: () => auth.getProjectId(),
    };
}
