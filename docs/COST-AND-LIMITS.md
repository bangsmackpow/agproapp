# Cost and limits

**Verdict: cost is not a risk for this application.** The included allowances on the Workers Paid plan are orders of magnitude above what an internal tool for a few users will consume. The constraints that will actually bite are platform limits that fail loudly, and latency from D1 being single-threaded — not the bill.

This document exists so the question can be answered with numbers rather than vibes, and revisited if the usage pattern changes.

---

## 1. Actual usage

Measured from the D1 analytics API for `agpro-db` (`fa197b3f-…484f`) since 2026-09-01, which is the entire life of the database:

| | Rows read | Rows written |
|---|---|---|
| 2026-09-16 | 1,344 | 299 |
| 2026-09-17 | 657 | 615 |
| **Total** | **2,001** | **914** |

That includes the phase-1 schema load, the 2027 price import, and every test and smoke run.

## 2. Included allowances and what that means

Workers Paid, per month:

| Metric | Included | Ours | Used | Overage price |
|---|---|---|---|---|
| Rows read | 25,000,000,000 | 2,001 | **0.000008%** | $0.001 / million |
| Rows written | 50,000,000 | 914 | **0.0018%** | $1.00 / million |
| Storage | 5 GB | ~0.6 MB | negligible | $0.75 / GB-month |

To put the write allowance in perspective: it is roughly **50,000 invoices a month** at ~18 written rows each, including index maintenance. AG Pro writes a few hundred.

**Reads are effectively free.** $0.001 per million is a dollar per *billion* rows. A full scan of a 50,000-row ledger costs 50,000 rows, so a billion reads would take 20,000 such scans inside a single month. Optimising reads to save money here is not a real activity.

## 3. What actually constrains us

### Latency, not cost

**A D1 database is single-threaded and processes queries one at a time.** Throughput is therefore governed by query duration: 1 ms queries allow ~1,000/second, 100 ms queries allow ~10. This is the metric that degrades as the ledger grows, and it is why the aggregates below have bounds on them.

Current state: `inventory_movements` has 0 rows in production. At a realistic few thousand rows a year, every aggregate in the app is sub-millisecond.

The unbounded queries have been given bounds anyway, but for the right reason: `productLedger` returns at most the 500 most recent movements, which does not reduce rows read (the aggregate still scans) but does stop a decade of history being serialised into one JSON response. Its running balance stays correct — the opening figure is the pool minus the sum of what was fetched.

### Hard platform limits that fail as errors

These are the ones worth knowing, because they do not degrade — they break:

| Limit | Value | Relevance here |
|---|---|---|
| `LIKE` / `GLOB` pattern length | **50 bytes** | Search terms were capped at 200 characters. A long search was a hard error, not a slow query. **Fixed: capped at 40.** |
| SQL statement length | 100 KB | The price importer builds one file of ~60 statements, each small. Fine. |
| Bound parameters per query | 100 | We use few. |
| Queries per Worker invocation | 1,000 | The heaviest screen issues ~6. |
| Query duration | 30 s | Nothing approaches it. |
| Row size | 2 MB | Nothing approaches it. |
| Database size | 10 GB | See below. |
| Time Travel retention | 30 days, 10 restores / 10 min | Referenced by the recovery guidance. |

### Unbounded tables

Two tables grow without limit, deliberately:

- **`inventory_movements`** — never pruned. It is the stock and cost ledger; pruning it would reset every running total and destroy margin history.
- **`audit_logs`** — archived at twelve months by `pnpm audit:archive`.

At ~120,000 movement rows a year and roughly 100 bytes per row including indexes, that is **~12 MB a year**. The 10 GB database ceiling is not reachable in any realistic horizon.

## 4. Where a real cost would come from

None of these exist today. They are listed so the assumption can be checked rather than assumed:

1. **A public, unauthenticated endpoint.** Every route is behind a session. The moment something is reachable without a login, an attacker can generate reads at will.
2. **A high-frequency polling UI.** A dashboard refreshing every few seconds multiplies query volume by orders of magnitude. Any such screen should poll no faster than a person can read it.
3. **A per-request scan at high frequency.** The aggregates below are bounded, but a per-request full scan under real concurrency would hurt latency long before it hurt the bill.
4. **Bulk operations.** A large `UPDATE` or `DELETE` touching hundreds of thousands of rows must be batched — D1 will exceed execution limits on a single statement of that size. The archive script deletes by cutoff in one statement and should be batched if audit volume ever reaches that scale.

## 5. Rate limiting

Two different problems, two different tools:

**Abuse protection** belongs at the edge, not in the application. Cloudflare **Rate Limiting Rules** run before the Worker, consume no D1 writes, and cost nothing extra on a paid plan. Hand-rolling this in D1 would be slower, weaker, and would itself consume the write allowance under exactly the attack it is meant to stop. *Recommended, not yet configured.*

**Sign-in brute force** is already handled in the application (`login_attempts`, 10 per account and 50 per IP per 15 minutes), because it needs to be keyed on the account, not just the address. See the Conventions section of the README.

## 6. Deliberately not doing

- **Denormalising the stock pool into a cached column.** It would save reads that are already free, at the cost of a number that can drift from the ledger that produced it. The pool is a `SUM` and stays one.
- **Caching query results in KV.** The UI calls the API in-isolate with no network hop; a cache adds invalidation bugs to save nothing.
- **Pruning movements.** See above. This is a correctness boundary, not a storage decision.

## 7. How to re-check this

The measurement is two API calls, not an estimate. The dashboard shows the same data under **Workers & Pages → D1 → agpro-db → Metrics**, and the analytics API can be queried directly:

```graphql
query {
  viewer {
    accounts(filter: { accountTag: "<account-id>" }) {
      d1AnalyticsAdaptiveGroups(limit: 100, filter: {
        date_geq: "2026-09-01",
        databaseId: "fa197b3f-d0cd-4138-9065-8ecf67b6484f"
      }) {
        sum { rowsRead rowsWritten }
        dimensions { date }
      }
    }
  }
}
```

**Revisit this document if** a public endpoint is added, a polling screen is built, or usage exceeds roughly 1% of either allowance — at which point the trend matters more than the absolute number.
