---
description: Audits the information architecture of Settings (read only) and returns a map with the decisions for the owner.
argument-hint: "[optional section, e.g. decisions]"
---

Launch the `ia-auditor` agent on the section `$ARGUMENTS` (or all of Settings if it is empty). When it finishes, present its report without summarising it, and end with its numbered "Decisions for the owner", asking the owner to choose before anything goes on. Implement nothing in this command.
