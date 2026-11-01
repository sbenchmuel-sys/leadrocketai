# Architecture rules

- Classifier queue indexes must match the global event predicates and ordering, not lead-first lookups, to avoid scanning unrelated history on every scheduled run.
- Gmail detection must mark both the legacy connection and its user-and-email-scoped canonical mail account on revoked permission, because sync and the reconnect banner read different stores.