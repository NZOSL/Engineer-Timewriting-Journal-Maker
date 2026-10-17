"""Sign-ins: who can sign in, their keys and passwords.

The private data repo keeps users.json (version 2), written only by the Actions:

    {"v": 2, "epoch": 3, "users": {"alex.smith": {
        "userKey":  sealed with the state key        random; unlocks the person's profile
        "dataKeys": [sealed, ...]                     encrypt their timesheets (newest last)
        "password": sealed with the password key      only while they use an issued password
        "wrap":     {"salt", "iterations", "key"}     the user key locked with their password
        "own": false, "seq": 0                        set once they choose their own password
        "reset": true                                 written by the Admin page to ask for a reset
    }}}

Every secret in it is encrypted under keys derived from MASTER_KEY, and the whole file is
encrypted again in the repo (etjm_vault.py), so it doesn't even show who has a sign-in. The
website's public users.json holds, per person, only the wrap and a profile encrypted with
their user key (see profile_for).
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from etjm_core import (
    MIN_OWN_PASSWORD,
    PASSWORD_TITLE_RE,
    PASSWORD_V1,
    PBKDF2_ITERATIONS,
    b64,
    bundle_key,
    cipher_block,
    generate_password,
    password_store_key,
    recharge_rate,
    seal,
    seal_profile,
    state_key,
    store_key,
    unb64,
    unb64url,
    unseal,
    unseal_profile,
    user_id,
    user_tag,
    wrap_user_key,
)

ABOUT = ("Sign-ins for the timewriting website, kept by the Actions. Every secret here is encrypted "
         "with keys derived from the MASTER_KEY secret. Use the website's Admin page to give someone "
         "a new password; don't edit this file by hand.")


def new_state() -> dict:
    return {"v": 2, "about": ABOUT, "epoch": 1, "users": {}}


def load_state(path: Path) -> tuple[dict, bool]:
    """A plain users.json file (the data repo's copy is encrypted: see load_state_data)."""
    return load_state_data(json.loads(path.read_text(encoding="utf-8")) if path.exists() else None)


def load_state_data(data) -> tuple[dict, bool]:
    """The sign-ins, and whether they had to be started again (old or missing file)."""
    if data is None:
        return new_state(), True
    if not isinstance(data, dict) or data.get("v") != 2:
        return new_state(), True  # version 1 kept passwords in plain text: everyone gets new ones
    data["about"] = ABOUT
    return data, False


class Keys:
    """Opens the sealed secrets in the state with keys derived from MASTER_KEY."""

    def __init__(self, master: bytes):
        self.master = master
        self.state = state_key(master)
        self.passwords = password_store_key(master)

    def user_key(self, username: str, record: dict) -> bytes:
        return unseal(self.state, record["userKey"], f"state|userKey|{username}")

    def data_keys(self, username: str, record: dict) -> list[bytes]:
        return [unseal(self.state, token, f"state|dataKey|{username}|{i}") for i, token in enumerate(record["dataKeys"])]

    def password(self, username: str, record: dict) -> str | None:
        token = record.get("password")
        return unseal(self.passwords, token, f"password|{username}").decode("utf-8") if token else None

    def seal_user_key(self, username: str, key: bytes) -> str:
        return seal(self.state, key, f"state|userKey|{username}")

    def seal_data_key(self, username: str, index: int, key: bytes) -> str:
        return seal(self.state, key, f"state|dataKey|{username}|{index}")

    def seal_password(self, username: str, password: str) -> str:
        return seal(self.passwords, password.encode("utf-8"), f"password|{username}")


def _issue_password(keys: Keys, username: str, record: dict, admin: bool) -> None:
    """A new random password (longer for admins), and a new user key so old sign-ins stop working."""
    password = generate_password(4 if admin else 3)
    user_key = os.urandom(32)
    record["userKey"] = keys.seal_user_key(username, user_key)
    record["password"] = keys.seal_password(username, password)
    record["wrap"] = wrap_user_key(user_key, password, username)
    record["own"] = False
    record.pop("reset", None)


def _add_data_key(keys: Keys, username: str, record: dict) -> None:
    record.setdefault("dataKeys", [])
    record["dataKeys"].append(keys.seal_data_key(username, len(record["dataKeys"]), os.urandom(32)))


def sync_people(state: dict, keys: Keys, people: list[dict]) -> dict:
    """Give new people a sign-in, reset those the Admin page asked to, and remove leavers.

    Removing or resetting anyone moves the epoch on, which changes the job-list key, so a
    sign-in that's been taken away can't read the job list (or the save token) any more.
    """
    users = state["users"]
    report = {"created": [], "reset": [], "removed": []}
    wanted = {p["username"]: p for p in people}
    for username, person in wanted.items():
        record = users.get(username)
        if record is None:
            record = users[username] = {"dataKeys": [], "seq": 0}
            _add_data_key(keys, username, record)
            _issue_password(keys, username, record, person["admin"])
            report["created"].append(username)
        elif record.get("reset"):
            _add_data_key(keys, username, record)
            _issue_password(keys, username, record, person["admin"])
            report["reset"].append(username)
    for username in sorted(set(users) - set(wanted)):
        del users[username]
        report["removed"].append(username)
    if report["reset"] or report["removed"]:
        state["epoch"] = int(state.get("epoch", 1)) + 1
    return report


def apply_password_changes(state: dict, keys: Keys, issues: list[dict]) -> tuple[list[int], list[str]]:
    """Apply "Password change" requests: each is sealed with the person's user key, so only
    they could have made it. Returns the issue numbers to close, and notes for the log."""
    tags = {user_tag(keys.master, u): u for u in state["users"]}
    done, notes = [], []
    for issue in sorted(issues, key=lambda i: i.get("number") or 0):
        match = PASSWORD_TITLE_RE.match((issue.get("title") or "").strip())
        if not match or "pull_request" in issue or issue.get("state") != "open":
            continue
        number = issue.get("number")
        username = tags.get(match.group(1))
        token = cipher_block(issue.get("body") or "", PASSWORD_V1)
        if not username or not token or not token.startswith("ETJMP1."):
            notes.append(f"Password change #{number} isn't for anyone who can sign in; ignored.")
            done.append(number)
            continue
        record = state["users"][username]
        try:
            request = json.loads(unseal(keys.user_key(username, record), token[len("ETJMP1."):], f"etjm-pw|{username}"))
            seq, wrap = int(request["seq"]), request["wrap"]
            ok = (seq > int(record.get("seq", 0))
                  and int(wrap["iterations"]) >= PBKDF2_ITERATIONS
                  and len(unb64(wrap["salt"])) == 16
                  and re.fullmatch(r"[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,}", wrap["key"]))
            if ok:
                unb64url(wrap["key"].split(".")[1])
        except (ValueError, KeyError, TypeError):
            ok = False
        if ok:
            record["wrap"] = {"salt": wrap["salt"], "iterations": int(wrap["iterations"]), "key": wrap["key"]}
            record["own"] = True
            record["seq"] = seq
            record.pop("password", None)
            notes.append(f"Password change #{number} applied.")
        else:
            notes.append(f"Password change #{number} couldn't be verified or was out of date; ignored.")
        done.append(number)
    return done, notes


def profile_for(person: dict, settings: dict, keys: Keys, epoch: int, record: dict, admin_token: str | None) -> dict:
    """What only this person's sign-in unlocks."""
    username = person["username"]
    profile = {
        "v": 3,
        "name": person["name"],
        "username": username,
        "timesheets": person["timesheets"],
        "admin": person["admin"],
        "rate": None,
        "epoch": epoch,
        "bundleKey": b64(bundle_key(keys.master, epoch)),
        "tag": user_tag(keys.master, username),
    }
    if person["timesheets"]:
        rate = recharge_rate(settings, person["name"])
        profile["rate"] = None if rate is None else (int(rate) if rate == rate.to_integral_value() else float(rate))
        profile["dataKeys"] = [b64(k) for k in keys.data_keys(username, record)]
    if person["admin"]:
        profile["passwordKey"] = b64(keys.passwords)
        profile["storeKey"] = b64(store_key(keys.master))
        if admin_token:
            profile["adminToken"] = admin_token
    return profile


def public_users(state: dict, keys: Keys, profiles: dict, existing: dict) -> dict:
    """The website's users.json. Unchanged entries are kept byte for byte."""
    out = {}
    for username, record in sorted(state["users"].items()):
        if username not in profiles:
            continue
        uid = user_id(username)
        user_key = keys.user_key(username, record)
        old = existing.get(uid) or {}
        entry = {"salt": record["wrap"]["salt"], "iterations": record["wrap"]["iterations"], "key": record["wrap"]["key"]}
        try:
            same = isinstance(old.get("profile"), str) and unseal_profile(user_key, old["profile"], username) == profiles[username]
        except (KeyError, TypeError, ValueError):
            same = False
        entry["profile"] = old["profile"] if same else seal_profile(user_key, profiles[username], username)
        out[uid] = entry
    return {"v": 3, "users": out}


def check_own_password(password: str, username: str) -> str | None:
    """The website applies the same rules; kept here so the tests pin them down."""
    from etjm_core import normalize_password

    plain = normalize_password(password)
    if len(plain) < MIN_OWN_PASSWORD:
        return f"Use at least {MIN_OWN_PASSWORD} characters."
    if len(set(plain)) < 5:
        return "Use a mix of different characters."
    if username.replace(".", "").upper() in plain:
        return "Don't include your username."
    return None
