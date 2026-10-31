# New in 1.0.5: protocols

Six small protocols, all on by default, all with no extra setup.
Full guides with examples live on the docs site (yatta.js.org).

## WebDAV — files over HTTP

Your storage, reachable from any file manager or `curl`.
Backed by the storage engine.

```bash
curl -X PUT --data-binary @report.pdf http://localhost:4000/dav/report.pdf
curl -X PROPFIND -H "Depth: 1" http://localhost:4000/dav/
```

Methods: OPTIONS, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY,
LOCK, UNLOCK, PROPFIND (Depth 0 and 1).

## gRPC-Web — browser calls with protobuf

Single-request, single-reply calls on
`/grpc-web/<Service>/<Method>`. Two services ship built in:
`yatta.Health/Check` and `yatta.Echo/Echo`.

```ts
import { grpcWebCall, encodeStringField } from "yatta.js/grpcweb";

const reply = await grpcWebCall(
  "http://localhost:4000/grpc-web",
  "yatta.Echo",
  "Echo",
  encodeStringField(1, "hello"),
);
```

## DNS over HTTPS — DNS questions over HTTPS

On `/dns-query`. A and AAAA records only.

```bash
curl "http://localhost:4000/dns-query?name=example.com&type=A"
```

## WebFinger — who is this account?

On `/.well-known/webfinger`. Only users in the auth store answer.

```bash
curl "http://localhost:4000/.well-known/webfinger?resource=acct:ada@example.com"
```

## OAuth 2.0 server — be the login server

Code flow with PKCE, client credentials, refresh tokens (which
rotate). Clients come from the `OAUTH_CLIENTS` environment variable.

```bash
curl -X POST http://localhost:4000/oauth/token \
  -d grant_type=client_credentials \
  -d client_id=web-app -d client_secret=SECRET
```

## OpenID Connect — proof of who the user is

On top of OAuth. Ask for the `openid` scope and the token reply
also carries a signed `id_token` (RS256).

```bash
curl http://localhost:4000/.well-known/openid-configuration
curl http://localhost:4000/oauth/userinfo \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

## Notes, kept short

- WebDAV, gRPC-Web, and DoH have no login of their own. Put them
  behind your own auth before they face the internet.
- OAuth codes and tokens live in memory. They do not survive a
  restart, and each server node holds its own.
- OIDC signing keys are made at first use and do not survive a
  restart. Old ID tokens stop verifying after one.
