# Test fixtures

## `postman-collection-v2.1.0.schema.json`

Postman's published Collection Format v2.1 schema, fetched unmodified from
<https://schema.postman.com/json/collection/v2.1.0/collection.json> on
2026-08-18.

It is vendored rather than fetched at test time so the suite validates offline
and so a change to the hosted schema cannot turn a passing build red on its own.
`test/postman.test.ts` validates the output of both apps' exporters against it;
`test/jsonschema.ts` is the small draft-04 validator that reads it.

Refresh it by downloading the same URL again and running `npm test`.
