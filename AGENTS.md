# Repository Guidelines & Agent Skills

This repository contains the codebase for PNetLab / UNetLab.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues (`git@github.com:Luuxinhxinh/pnetlab-core.git`). See `docs/agents/issue-tracker.md`.

### Triage labels

Uses canonical triage label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo layout (`CONTEXT.md` and `docs/adr/`). See `docs/agents/domain.md`.

## Engineering Guidelines & Rules

All code contributions and refactoring must strictly adhere to:
1. **Skill Auto-Routing & Intent Execution Engine (v3.0)**: [`.agents/rules/skill-router.md`](.agents/rules/skill-router.md).
2. **Engineering Rules & SOLID Clean Code Standards**: [`docs/guidelines/ENGINEERING_RULES.md`](docs/guidelines/ENGINEERING_RULES.md).
3. **Master Safety Net Test Runner**: [`tests/run_all_safety_net.py`](tests/run_all_safety_net.py) (must pass 18/18 tests before any PR).
4. **8-Week Refactor Master Plan**: [`docs/plan/REFACTOR_MASTER_PLAN.md`](docs/plan/REFACTOR_MASTER_PLAN.md).
