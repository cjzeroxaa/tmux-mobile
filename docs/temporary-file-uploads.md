# Temporary file uploads

Native iOS/Android and both Web composers upload file bytes directly to the
Controller's private S3 artifact bucket. The Controller handles metadata only;
the target Connector does not receive or relay the file during upload.

1. Authenticated `POST /api/uploads` accepts `name`, `size`, and `contentType`.
   It issues a signed PUT URL valid for 30 minutes and an owner-bound ticket.
2. The client uploads the original file with the returned headers. Native uses
   Expo's binary file upload; it does not buffer the file as JavaScript Base64.
   Controller authentication is never attached to the storage request.
3. `POST /api/uploads/complete` verifies the ticket owner and actual S3 metadata.
   It returns a download URL, filename, size and expiry. The composer inserts
   this URL instead of a machine-local path.
4. `/files/<token>/<filename>` is a bearer download link. Anyone possessing it
   can download the file until two hours after S3 finishes the upload. The
   Controller verifies expiry, then redirects to a short S3 GET/HEAD URL. This
   avoids tying the full two-hour link lifetime to one ECS credential rotation.

Expiry is fixed by the immutable object's timestamp. Repeated completion or
opening a link cannot renew it. Conditional PUT (`If-None-Match: *`) prevents
replacement. Completion can finish after the upload authorization expires if
S3 accepted the transfer before expiry; this never grants another upload URL.
The client must select the file again to start a new upload after a failure.
Downloads already in progress can finish after expiry.

Single PUT supports files up to 5 GiB. Empty files and missing sizes are rejected.
The existing `/api/upload` endpoint remains for older clients and local-only
Controllers. New clients use that path only when the metadata endpoint returns
404 or 501. Native fallback also streams the original file without Base64.

## Deployment

Use the existing `TMUX_MOBILE_ARTIFACT_STORAGE=s3` configuration and Controller
workload role. No storage credentials are distributed to clients or Connectors.
The token signing key is derived from `SESSION_SECRET`. Rotating that secret
invalidates outstanding application download links.

The S3 bucket needs CORS for PUT/GET/HEAD from both `https://eng.xyznot.com` and
`https://eng.impo.ai`, including Content-Type and If-None-Match request headers.
Preserve unrelated CORS and lifecycle rules. Temporary objects live under
`${TMUX_MOBILE_S3_KEY_PREFIX}temporary-uploads/`; prefix concatenation follows the
existing artifact driver (the production prefix is `artifactstemporary-uploads/`).
A lifecycle rule expires only this prefix after one day. S3 deletes asynchronously;
the application's two-hour access expiry does not depend on physical deletion.
Pins, Drafts, transcripts and other artifact prefixes retain their existing policy.

Run `node test/temporary-uploads.mjs`, `node test/file-upload-client.mjs`, and
`node test/upload-http.mjs`. The native API tests cover disk streaming, large-file
metadata, failed uploads, credential isolation and local-server fallback.
