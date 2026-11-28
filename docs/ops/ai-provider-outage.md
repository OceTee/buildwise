# AI provider outage or quota

Every AI job falls back to BuildWise's own engine or assistant, so an outage makes designs simpler and replies
shorter, never broken. The jobs and their switches:

| Job | Provider variable | Fallback |
|---|---|---|
| AI designer (*Design it for me*) | `DESIGNER_PROVIDER` (`anthropic,gemini` chain) | The design engine's designs |
| 3D critique | `CRITIQUE_PROVIDER` | The first layout is kept |
| AI architect | `ARCHITECT_PROVIDER` | The engine's own notes and ranking |
| Builder AI chat | `BUILDER_AI_PROVIDER` | The local assistant's reply |
| Live brain | `ASSISTANT_PROVIDER` | The local model |
| Photoreal render | `RENDER_PROVIDER` | No render button result ("busy") |
| Dream renders | `DREAM_PROVIDER` | No gallery images |

Each job has a daily ceiling (`*_DAILY_LIMIT`, counted in the `ai_usage` table); past it, the job falls back until midnight UTC.

## Signs

- The website banner says AI features are busy (from `/v1/status`: a connected job whose latest call failed in the last 15 minutes with no success since, or a job at its ceiling).
- `/health/details` → `ai.jobs[]`: `failing`, `lastFailAt`, `lastFailReason`, `used`/`limit`, `ceilingReached`.
- Logs: warn lines such as `AI designer failed; using the engine`, `The live brain failed; the local assistant answers`.
- Provider status pages: Anthropic, Google AI Studio, OpenAI.

## What to do

1. **Provider down or slow** (5xx, timeouts, Gemini 503 "high demand"). Nothing to do for a short outage: the chains already hand over (Gemini tries the next model; the designer chain tries Gemini after Claude). For a long one, set `DEGRADED_MESSAGE` if you want wording more specific than the automatic banner.
2. **Quota or rate limit** (429 `RESOURCE_EXHAUSTED`, Anthropic `rate_limit_error`). Free-tier Gemini quotas reset daily. Either wait, or move the job to another provider (e.g. `BUILDER_AI_PROVIDER=gemini` → `none`), and redeploy.
3. **Spend running away** (paid providers: Claude, OpenAI, Gemini image models). Check `ai_usage` for today, then lower the job's `*_DAILY_LIMIT` or set its provider to `none` and redeploy. `PAID_AI=off` makes the API refuse to start while any job is on a paid provider: a guard against switching one back by mistake. `/health` lists `paidAi`.
4. **Bad output from a new model** (designs failing checks, odd replies). Pin the previous model with `DESIGNER_CLAUDE_MODEL`, `DESIGNER_MODEL`, `BUILDER_AI_MODEL`, `ARCHITECT_MODEL`, `ASSISTANT_MODEL`, `CRITIQUE_MODEL`, `RENDER_MODEL` or `DREAM_MODEL`, and redeploy. Cached AI designs (`ai_designs`, 30 days) and architect reviews (`architect_reviews`) keep serving old answers; delete today's rows for that model if they are bad.
5. **Key leaked or revoked.** Rotate `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` in the provider console and in Vercel env, redeploy.
6. **Assistant model regression** (the local model, retrained by the worker). Staff UI `/moderation/assistant` shows the promoted model; the previous one stays in `assistant_models` for rollback.

Each change of provider or limit is an env change: `vercel env add …` then `vercel redeploy` ([deploy-and-rollback.md](deploy-and-rollback.md)).
