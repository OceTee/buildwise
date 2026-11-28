/** Runs once when the web server starts: a deployed server refuses to start on development fallbacks. */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertServerEnv } = await import('./lib/env');
    assertServerEnv();
  }
}
