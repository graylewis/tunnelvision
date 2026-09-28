# Correlate code to visual changes through tracked properties and winning declarations

To link a changed line to a visual change, we record, for every element, the computed value of each tracked property and the declaration that won it (following `var()` chains and inheritance). We don't just check whether a changed rule *matches* a changed element. Matching produces false positives (a rule can match a changed element without being the reason it changed), and it misses Tailwind utility swaps and CSS-in-JS rules, which have no changed stylesheet line. Asking "which property changed, and which declaration set it" works whatever produced the CSS, and git lines are joined on only where a rule has a source location.

## Considered Options

- **Rule matching only**: an element is affected if a changed rule matches it. Rejected because of false positives and because it doesn't cover generated CSS.
- **Computed values only, with a heuristic link to hunks**: rejected because it can't tell two rules that set the same property apart.
- **Store every matched rule and resolve the cascade at diff time**: rejected in favour of resolving the cascade at capture time and storing only the winner per tracked property, to keep captures small. Winners that don't agree with the computed value are marked uncertain.

## Consequences

The cascade winner is our own reconstruction from CDP's matched rules (CDP doesn't report it), so cascade features we don't model (e.g. `@layer`) can give wrong winners.
