#!/usr/bin/env python3
"""Keep the sign-ins up to date and publish the job list to the website.

This runs in the private data repo (see data-repo-template/.github/workflows/update.yml):

    python .website/tools/publish_website.py --data-dir . --site-dir .website --push

Environment:
  MASTER_KEY    32 random bytes, base64: the one secret every other key comes from (required)
  SAVE_TOKEN    fine-grained token, Issues read/write on the data repo only (engineers' Save)
  ADMIN_TOKEN   fine-grained token, Contents read/write + Actions read on the data repo (Admin page)
  GITHUB_TOKEN  the workflow's token, to read and close "Password change" requests

In the private data repo (where every file is encrypted, see etjm_vault.py) it updates
users.json: new people get a sign-in, people the Admin page asked to reset get a new
password, leavers are removed, and password changes people made themselves are applied
(see etjm_accounts.py). It also writes the job list to generated/jobs.json. On the public
website it writes site/data/users.json (each person's sign-in, encrypted) and
site/data/bundle.enc.json (the job list and save token, encrypted with the current epoch's
key). Costs, consultants, other people's rates and passwords never leave the data repo.
Nothing it prints names anyone, because Actions logs are easier to see than the files.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from etjm_accounts import Keys, apply_password_changes, load_state_data, profile_for, public_users, sync_people  # noqa: E402
from etjm_core import bundle_key, decrypt_bundle, encrypt_bundle, parse_master_key, people, read_job_report  # noqa: E402
from etjm_github import api, commit_and_push, list_issues  # noqa: E402
from etjm_vault import JOBS, REPORT, USERS, Vault  # noqa: E402

BUNDLE_PATH = Path("site/data/bundle.enc.json")
USERS_PATH = Path("site/data/users.json")


def report_date(data_dir: Path) -> str:
    return subprocess.run(["git", "log", "-1", "--format=%cs", "--", REPORT],
                          cwd=data_dir, text=True, capture_output=True).stdout.strip()


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data-dir", default=".", help="checkout of the private data repo")
    parser.add_argument("--site-dir", required=True, help="checkout of the public website repo")
    parser.add_argument("--data-repo", default=os.environ.get("GITHUB_REPOSITORY"), help="owner/name of the data repo")
    parser.add_argument("--issues-file", help="read issues from this JSON file instead of GitHub (for testing)")
    parser.add_argument("--push", action="store_true", help="commit and push both repos")
    args = parser.parse_args()
    data_dir, site_dir = Path(args.data_dir).resolve(), Path(args.site_dir).resolve()

    try:
        keys = Keys(parse_master_key(os.environ.get("MASTER_KEY", "")))
    except ValueError as exc:
        sys.exit(f"The MASTER_KEY secret is missing or wrong: {exc}")
    vault = Vault(data_dir, keys.master)
    save_token = os.environ.get("SAVE_TOKEN") or None
    admin_token = os.environ.get("ADMIN_TOKEN") or None
    github_token = os.environ.get("GITHUB_TOKEN")
    if not args.data_repo:
        sys.exit("--data-repo (or GITHUB_REPOSITORY) is needed.")

    settings = vault.settings()
    report = vault.read_json(REPORT)
    if not report:
        sys.exit('There is no Business Central report yet. Upload the "Job Task Overview" report on the Admin page.')
    jobs, stats = read_job_report(io.BytesIO(base64.b64decode(report["xlsx"])), settings["jobStatuses"])
    updated = report.get("uploaded") or report_date(data_dir)
    everyone = people(settings)
    print(f"Report: {stats['rows']} job task rows, {stats['jobs']} jobs with status "
          f"{' or '.join(settings['jobStatuses'])}; {len(everyone)} people can sign in.")
    if not save_token:
        print("::warning::SAVE_TOKEN isn't set, so the website will only keep timesheets on each computer.")
    if any(p["admin"] for p in everyone) and not admin_token:
        print("::warning::ADMIN_TOKEN isn't set, so the Admin page can't upload reports or manage engineers.")
    if save_token:
        try:
            api("GET", f"/repos/{args.data_repo}", save_token)
        except Exception as exc:  # noqa: BLE001 - only a warning
            print(f"::warning::SAVE_TOKEN couldn't reach {args.data_repo} ({exc}). Saving from the website won't work.")

    def fetch_issues() -> list[dict]:
        if args.issues_file:
            return json.loads(Path(args.issues_file).read_text(encoding="utf-8"))
        return list_issues(args.data_repo, github_token) if github_token else []

    result = {}

    def regenerate_data() -> None:
        state, restarted = load_state_data(vault.read_json(USERS))
        to_close, notes = apply_password_changes(state, keys, fetch_issues())
        changes = sync_people(state, keys, everyone)
        vault.write_json(USERS, state)
        vault.write_json(JOBS, {"source": report["name"], "sha256": report.get("sha256"), "updated": updated,
                                "statuses": settings["jobStatuses"], "stats": stats, "jobs": jobs})
        result.update(state=state, restarted=restarted, to_close=to_close, notes=notes, changes=changes)

    if args.push:
        pushed, _ = commit_and_push(data_dir, ["generated", USERS], "Update sign-ins and job list", regenerate_data)
        print("Data repo " + ("updated." if pushed else "already up to date."))
    else:
        regenerate_data()
    state = result["state"]
    if result["restarted"]:
        print("::warning::users.json was started again (it was missing or an old version): everyone has a new password, shown on the Admin page.")
    for kind in ("created", "reset", "removed"):
        if result["changes"][kind]:
            print(f"Sign-ins {kind}: {len(result['changes'][kind])}.")
    for note in result["notes"]:
        print(note)

    epoch = int(state["epoch"])
    profiles = {p["username"]: profile_for(p, settings, keys, epoch, state["users"][p["username"]], admin_token)
                for p in everyone}
    bundle = {
        "v": 3,
        "dataRepo": args.data_repo,
        "saveToken": save_token,
        "otherTime": settings["otherTime"],
        "journal": settings["journal"],
        "closedMonths": settings["closedMonths"],
        "jobsSource": report["name"],
        "jobsUpdated": updated,
        "jobs": jobs,
    }
    key = bundle_key(keys.master, epoch)

    def regenerate_site() -> None:
        bundle_file = site_dir / BUNDLE_PATH
        old = read_json(bundle_file)
        try:
            same = old.get("epoch") == epoch and decrypt_bundle(old, key) == bundle
        except (ValueError, KeyError):
            same = False
        bundle_file.parent.mkdir(parents=True, exist_ok=True)
        if not same:
            bundle_file.write_text(json.dumps(encrypt_bundle(bundle, key, epoch)) + "\n", encoding="utf-8")
        users_file = site_dir / USERS_PATH
        users = public_users(state, keys, profiles, read_json(users_file).get("users") or {})
        if users != read_json(users_file):
            users_file.write_text(json.dumps(users, indent=1) + "\n", encoding="utf-8")

    if args.push:
        pushed, _ = commit_and_push(site_dir, [str(BUNDLE_PATH), str(USERS_PATH)], "Update the encrypted job list and sign-ins", regenerate_site)
        print("Website " + ("updated." if pushed else "already up to date."))
        for number in result["to_close"]:
            api("PATCH", f"/repos/{args.data_repo}/issues/{number}", github_token, {"state": "closed", "state_reason": "completed"})
    else:
        regenerate_site()
        print("Files written (not pushed).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
