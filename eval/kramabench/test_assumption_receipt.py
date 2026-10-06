"""Offline check: the d-trail receipt reaches run_config only when a check produced one.

Run: python eval/kramabench/test_assumption_receipt.py   (or pytest on this file)
"""

from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import datafoundry_sut as sut  # noqa: E402

CLASSIFIER = {"task_id": "t1", "assumptions": [{"clause": "c", "term": "t"}],
              "trees": [{"status": "refuted", "claim": None}], "summary": {"refuted": 1},
              "probes": 1, "conditioner_reply": "raw model text"}
CHECKED = {"mode": "assume_only", "domain": "d", "task_id": "t1", "run_status": "COMPLETED",
           "receipt": {"task_id": "t1", "assumptions": CLASSIFIER}}
FAILED = {"mode": "assume_only", "domain": "d", "task_id": None, "run_status": "HTTP_500",
          "receipt": None, "error": {"http": 500}}


class _Stream:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def raise_for_status(self):
        pass

    def iter_lines(self, decode_unicode=True):
        return iter(())


class _Session:
    def __init__(self):
        self.posted: list[dict] = []

    def post(self, url, json=None, **kwargs):
        self.posted.append(json)
        return _Stream()


class _Dtrail:
    def __init__(self, result):
        self.result = result

    def check(self, question, domain, executed_sql=None):
        return self.result


def _sut(check_result) -> tuple[sut.DataFoundrySUT, _Session]:
    client = sut.DataFoundryClient.__new__(sut.DataFoundryClient)
    client.api, client.csrf, client._last_thread_id = "http://df", None, None
    client.s = _Session()
    client._final_answer = lambda thread_id: "FINAL_ANSWER: 1"
    client.read_assumptions = lambda: None
    system = sut.DataFoundrySUT(system_output_directory=tempfile.mkdtemp())
    system.client, system._ds_id, system._domain = client, "kb-d", "d"
    system.dtrail = _Dtrail(check_result) if check_result is not None else None
    return system, client.s


def _run_config(session: _Session) -> dict:
    return session.posted[-1]["body"]["forwardedProps"]["run_config"]


def test_receipt_reaches_run_config_without_conditioner_reply():
    system, session = _sut(CHECKED)
    out = system.serve_query("q?", "q-1")
    sent = _run_config(session)["assumptionReceipt"]
    assert sent["trees"] == CLASSIFIER["trees"] and sent["task_id"] == "t1"
    assert "conditioner_reply" not in sent
    assert out["explanation"]["assumptions"] is CHECKED  # stored shape unchanged


def test_no_receipt_when_check_failed_or_disabled():
    system, session = _sut(FAILED)
    out = system.serve_query("q?", "q-1")
    assert "assumptionReceipt" not in _run_config(session)
    assert out["explanation"]["assumptions"] is FAILED

    system, session = _sut(None)
    system.serve_query("q?", "q-1")
    assert "assumptionReceipt" not in _run_config(session)


def test_dtrail_to_agent_off_keeps_receipt_out():
    saved, sut.DTRAIL_TO_AGENT = sut.DTRAIL_TO_AGENT, False
    try:
        system, session = _sut(CHECKED)
        out = system.serve_query("q?", "q-1")
        assert "assumptionReceipt" not in _run_config(session)
        assert out["explanation"]["assumptions"] is CHECKED
    finally:
        sut.DTRAIL_TO_AGENT = saved


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok {name}")
