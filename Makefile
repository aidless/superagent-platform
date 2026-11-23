# Offline gate. Recomputes the Watchdog grid, the unit tests, and the
# regression harness, then fails if README.md disagrees.
.PHONY: check eval

check:
	python3 scripts/check_readme.py

eval:
	python3 eval/run_cases.py
