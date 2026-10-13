# How scoring works

ArchDrill scores a design per scenario. The score is deterministic: the same design always gets the same score, and every point it loses comes with a finding that says what was checked, what was found, why interviewers care and how to fix it.

## From a design to a score

1. **Validation.** The design is checked for structural errors: a call over a connection that does not exist, a step a component cannot perform, a flow whose handler no client can reach. Errors on the shared architecture block every scenario; errors inside a flow block only the scenarios that focus on that operation. A blocked scenario says *Not evaluable yet* and lists what to fix.
2. **Readiness.** Every operation a scenario focuses on needs a flow. Consumers of an event (for example the scan of new links in S7) are optional, because a design may do that work another way; their checks then do not apply.
3. **Analysis.** Every path a request can take through its flow is enumerated, with the outcome of every step along it.
4. **Simulation.** Each environment of the scenario (average day, peak, a cache outage) is simulated analytically. See [About the model](model.md).
5. **Checks.** The scenario's checks run against the paths and the simulated metrics. Each one ends as **pass**, **partial** (with a fraction of the credit), **fail** or **n/a** (it does not apply to this design).
6. **Scorecard.** The score combines the checks as described below.

## Dimensions and weights

Every scenario weighs a few dimensions, for example `correctness 0.45 · security 0.25 · operability 0.2 · latency 0.1` in S7. Every check belongs to one dimension and has a weight within it.

- A dimension's score is the weighted share of credit its applicable checks earned: `100 · Σ weight · fraction / Σ weight`.
- Checks that do not apply are left out. A dimension without any applicable check is shown but left out of the score, and the remaining dimension weights are renormalised.
- The scenario's raw score is the weighted average of its dimension scores.

## Gates and caps

Some failures make everything else irrelevant: a redirect that never reads the stored link, an acknowledged write that a failover loses, malicious links that nobody checks. These checks are **gates**.

| Rule | Effect |
|---|---|
| A gate fails or is only partly met | The score is capped at **40** and the band is *not passing*, however good the rest is. |
| A *critical* finding is open | The score is capped at **79**: no *strong* band. |
| A *major* finding is open | The score is capped at **89**: no *excellent* band. |
| Only *minor* findings are open | No cap. |

The scorecard says when, and why, a cap applied.

## Bands

| Band | Score |
|---|---|
| Excellent | 90 and above |
| Strong | 80–89 |
| Passing | 60–79 |
| Not passing | below 60, or any failed gate |

## Signals

Some checks recognise what a senior or staff engineer would add without being asked: a near cache for viral links, autoscaling, negative caching, rate limits. These are **signals**. They never lower the score; the scorecard counts how many a design demonstrates (for example *senior 2/3*).

## Many valid designs

Checks ask for behaviour and capabilities, never for specific products. A unique short code can come from a key generation service, random codes with a conditional insert, counter ranges with obfuscation, or URL hashes; a malicious link can be stopped before the create answers or by a consumer that scans new links. The golden corpus keeps several such designs at 90 or above in CI, and the mutant corpus checks that every way of breaking them is caught by the check that should catch it.

## Working across scenarios

Every scenario judges the same shared design. When an edit lowers another scenario's score, that scenario's tab is marked and a toast says what changed. Pin a baseline under *Compare* to see how every score moved since.
