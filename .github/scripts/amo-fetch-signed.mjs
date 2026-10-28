// Ask AMO whether it already has a version of the add-on, and download the
// signed file if Mozilla has approved it.
//
// web-ext can't do this. Once `web-ext sign` has submitted a version, running
// it again only gets "version already exists", even when the first run timed
// out waiting for approval. So the sign workflow checks here first and only
// uploads a version AMO has never seen.
//
//   node amo-fetch-signed.mjs <addon-guid> <version> <out.xpi>
//
// Exit 0: approved and downloaded to <out.xpi>.
// Exit 2: AMO doesn't have this version. Upload it.
// Exit 3: AMO has it but it isn't approved yet. Try again later.
// Exit 1: anything else.
//
// Credentials come from WEB_EXT_API_KEY / WEB_EXT_API_SECRET, the same pair
// web-ext reads. Uses only Node built-ins, so nothing gets installed for it.
import { createHmac, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const [guid, version, out] = process.argv.slice(2);
const { WEB_EXT_API_KEY: key, WEB_EXT_API_SECRET: secret } = process.env;
if (!guid || !version || !out || !key || !secret) {
  console.error('usage: WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… node amo-fetch-signed.mjs <guid> <version> <out.xpi>');
  process.exit(1);
}

// AMO's JWT: HS256, issuer = the key, a unique jti, and an expiry of at most
// five minutes. A fresh token per request keeps every jti unique.
function authHeader() {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: key, jti: randomUUID(), iat, exp: iat + 60 })}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `JWT ${body}.${sig}`;
}

const get = (url) => fetch(url, { headers: { Authorization: authHeader(), Accept: 'application/json' } });

// The `v` prefix makes AMO look the version up by its number, not its id.
const detailUrl = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(guid)}/versions/v${encodeURIComponent(version)}/`;
const res = await get(detailUrl);
if (res.status === 404) {
  console.log(`AMO has no version ${version} of ${guid}.`);
  process.exit(2);
}
if (!res.ok) {
  console.error(`AMO version lookup failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const { file } = await res.json();
if (!file || file.status !== 'public') {
  console.log(`AMO has version ${version}, but it isn't approved yet (file status: ${file?.status ?? 'none'}).`);
  process.exit(3);
}

// Unlisted files need the same auth to download.
const dl = await get(file.url);
if (!dl.ok) {
  console.error(`Download of ${file.url} failed: ${dl.status}`);
  process.exit(1);
}
await writeFile(out, Buffer.from(await dl.arrayBuffer()));
console.log(`Downloaded signed ${version} to ${out}`);
