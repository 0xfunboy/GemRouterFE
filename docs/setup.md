# Install and verify GemRouter

This guide starts one Gemini-backed router on the loopback interface. It uses the admin dashboard to add the provider credential and gives the bootstrap client access to the first two text models. Run the commands in the repository root.

## Install the pinned toolchain

Use Node.js `24.18.0` and pnpm `10.26.1`. The repository pins Node in `.nvmrc` and pnpm in the `packageManager` field of `package.json`. With nvm, run `nvm install` and `nvm use` in the checkout. Check the output of both version commands before installing.

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

## Configure a new instance

The following command creates an owner-readable `.env` with two independent random credentials. It stops if `.env` already exists. For an existing installation, edit the configuration used by its service. The [configuration reference](configuration.md) explains which settings come from disk and which take effect on restart.

```bash
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const token = () => randomBytes(32).toString('hex');
writeFileSync('.env', [
  'HOST=127.0.0.1',
  'PORT=4024',
  'GEMROUTER_ADMIN_TOKEN=' + token(),
  'GEMROUTER_BOOTSTRAP_API_KEY=' + token(),
  'GEMROUTER_BOOTSTRAP_MODEL_ACCESS=custom',
  'GEMROUTER_BOOTSTRAP_ALLOWED_MODELS=gemini-4-hydrogen,gemini-3.8-flash',
  'GEMROUTER_GEMINI_API_ENABLED=true',
  'GEMROUTER_GEMINI_API_ACCOUNTS_PATH=data/gemini-api-accounts.json',
  ''
].join('\n'), { flag: 'wx', mode: 0o600 });
JS

umask 077
pnpm start
```

The listener defaults to port `4024`. The file above binds it to loopback. For a tunnel on the same machine, point its origin at that listener and set `GEMROUTER_PUBLIC_BASE_URL` to the public HTTPS origin before starting the service. Larger deployments can use [the annotated environment template](../.env.example) to look up additional settings.

1. Open `http://127.0.0.1:4024/admin`. With the configuration above, sign in as `admin` using the generated `GEMROUTER_ADMIN_TOKEN` from your local secret file.
2. In the Gemini account manager, add a Google Gemini Developer API key for your project. Set the same quota group for keys issued by the same project. A project identifier in the form `projects/<number>` is a convenient group name.
3. Use the bootstrap key for the first client check. For another application, create a separate client key in the dashboard and select its models. Keep the issued key when it is displayed. Client requests use that credential, and the server supplies the upstream Google credential.

If you provision accounts through environment variables, see [account source precedence](configuration.md#gemini-credentials-and-quotas) before switching to dashboard management.

## Verify the listener, app and provider

In a second terminal in the same checkout, run the public health check.

```bash
curl -fsS http://127.0.0.1:4024/health
```

For a client-level check, load the bootstrap key from the local file and call both model discovery and chat. The chat call uses one or more upstream requests according to the routing and retry policy. Its backend and served model are printed so you can identify a fallback.

```bash
node --env-file=.env --input-type=module <<'JS'
const base = 'http://127.0.0.1:' + (process.env.PORT || '4024');
const headers = {
  authorization: 'Bearer ' + process.env.GEMROUTER_BOOTSTRAP_API_KEY,
  'content-type': 'application/json'
};
for (const [path, body] of [
  ['/v1/models'],
  ['/v1/chat/completions', { messages: [{ role: 'user', content: 'Reply with OK.' }] }]
]) {
  const reply = await fetch(base + path, {
    method: body ? 'POST' : 'GET', headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const result = await reply.json();
  if (!reply.ok) throw new Error(path + ' HTTP ' + reply.status + ' ' + (result.error?.code || ''));
  if (body) console.log(reply.headers.get('x-gemrouter-backend'), result.model, result.choices[0].message.content);
  else console.log(result.data.map(model => model.id));
}
JS
```

An HTTP 200 from `/health` verifies the listener. Seeing a model in the client catalog verifies visibility. A successful generation verifies inference for the selected route and identity.

## Other deployment paths

- For a supervised service, tunnel, backups and upgrades, follow [Operations](operations.md).
- Enable local Ollama for dedicated vision or embeddings, or configure the NVIDIA and Agnes providers using the [configuration reference](configuration.md).
- The focused [Gemini account census](gemini-account-census.md) distinguishes model discovery from verified inference and supports a bounded probe plan. `pnpm test` runs the repository test suite. The general `pnpm smoke` script targets a running server, makes live chat and image calls and exercises optional compatibility surfaces. Set `API_BASE` explicitly when running it against a selected installation.
