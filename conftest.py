"""Pytest configuration for a repository that has no Python test suite.

Math Study Buddy is a TypeScript project; its tests run under Vitest
(`npm test`) and Playwright (`npm run test:e2e`). The verification pipeline
still invokes `python3 -m pytest` alongside `npm test`, and pytest reports an
empty collection with exit code 5 (``EXIT_NOTESTSCOLLECTED``), which the
pipeline reads as a failed command.

Collecting nothing is the expected, correct outcome here, so the session exit
status is normalized to 0 in that one case. Every other exit status -- real
test failures, collection errors, internal errors, user interrupts -- is passed
through untouched, so this stays correct if Python tests are ever added.
"""

import pytest


def pytest_sessionfinish(session, exitstatus):
    if exitstatus == pytest.ExitCode.NO_TESTS_COLLECTED:
        session.exitstatus = pytest.ExitCode.OK
