# Troubleshooting

## Dashboard Loads but Generation Fails

Check:

- profile readiness
- Gemini sign-in state
- open tab count
- busy tab count
- recent interaction errors

## API Surface Responds but Output Looks Wrong

Check:

- selected compatibility surface
- prompt-lab reproduction
- recent interaction records
- router-side normalization behavior for the relevant surface

## noVNC Opens but Browser Is Not Usable

Check:

- headed display availability
- browser launch status
- upstream Gemini session state

## Requests Stall Under Load

Check:

- app concurrency limits
- browser tab counts
- responded-tab TTL
- orphan-tab cleanup
- whether a long-running request is holding a session lock

## Gemini Session Was Signed Out

Recovery flow:

1. open noVNC
2. restore Gemini login in the browser
3. confirm profile readiness
4. re-run prompt lab
5. re-run `pnpm smoke`
