# Security

Treat GemRouter as a privileged routing backend.

## Protect

- `GEMROUTER_ADMIN_TOKEN`
- bootstrap API keys
- Gemini API keys
- Gemini CLI OAuth cache if that backend is enabled
- audit and interaction logs if they contain sensitive prompts

## Recommendations

- keep admin auth separate from client bootstrap auth
- expose the admin UI only where operators need it
- rotate bootstrap keys and app keys when access changes
- do not commit `.env`, `data/`, or `.gemini/`
