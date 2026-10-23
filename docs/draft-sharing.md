# Draft sharing

Drafts stay private until the owner or a super administrator opens **Share** and
selects **Enable public link**. **Copy private link** retains the existing
sign-in and session-access requirements. **Copy public link** gives anyone with
the address a read-only view of the latest HTML, including managed images and
media. The public view has no comments, private review controls, session/machine
metadata or version-history endpoint. No sign-in or live Connector is required.

**Disable public link** makes that address return 404. Enabling sharing again
creates a new address; the old address stays invalid. Publishing a new revision
preserves sharing and updates what the public address displays. A public link is
not listed in any anonymous library and carries a noindex/nofollow directive.

The anonymous route is `/d/<draft-id>/<random-256-bit-token>`. Sharing records are
kept separately in the existing Draft store (`tmax-draft-sharing`) so publishing
cannot overwrite them. Conditional writes reject concurrent changes. Only the
owner/admin can change sharing through the authenticated JSON API; read access
alone does not grant publication rights. Public HTML retains the existing CSP
sandbox with an opaque origin, no host API access and no external scripts.

Managed media uses the existing exact-object signed URLs. The bucket remains
private. Disabling sharing stops new document loads; media URLs already issued
to a viewer can remain valid for their existing 24-hour TTL, and downloaded
content cannot be recalled. No public bucket, separate upload credential or
native app release is needed.

Validation: `node test/draft-sharing.mjs` and `node test/drafts-http.mjs` cover
private defaults, permission boundaries, anonymous GET/HEAD, media signatures,
CSRF rejection, latest-version behavior, revocation/token rotation, persistence
and concurrent writes. Run the existing Draft and asset tests as well.
